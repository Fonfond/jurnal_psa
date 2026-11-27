import 'reflect-metadata';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { configureApp } from './common/configure-app';
import { loadEnv } from './config/env';
import { runMigrations } from './db/migrator';
import type { SqlClient } from './db/sql-client';
import { DB } from './db/tokens';

/**
 * The API also serves the built PWA in the pilot image. We deliberately do
 * not guess a single path: local runs, `node dist` and Docker use different
 * working directories.
 */
function resolveWebDist(): string | undefined {
  const candidates = [
    process.env.WEB_DIST,
    path.resolve(process.cwd(), 'apps/web/dist'),
    path.resolve(__dirname, '../../web/dist'),
    path.resolve(__dirname, '../../../apps/web/dist'),
  ].filter((value): value is string => Boolean(value));

  return candidates.find((candidate) => existsSync(path.join(candidate, 'index.html')));
}

function spaFallback(webDist: string) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (
      request.method !== 'GET' ||
      request.path.startsWith('/v1') ||
      path.extname(request.path) !== ''
    ) {
      next();
      return;
    }
    response.sendFile(path.join(webDist, 'index.html'));
  };
}

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  configureApp(app);

  const webDist = resolveWebDist();
  if (webDist) {
    app.useStaticAssets(webDist, { index: 'index.html' });
    app.use(spaFallback(webDist));
    console.log(`PWA static files served from ${webDist}`);
  } else {
    console.warn('PWA dist not found; API-only mode (set WEB_DIST to serve the SPA)');
  }

  if (env.RUN_MIGRATIONS_ON_START) {
    const db = app.get<SqlClient>(DB);
    const applied = await runMigrations(db);
    if (applied.length > 0) {
      console.log(`Migrations applied on startup: ${applied.join(', ')}`);
    }
  }

  await app.listen(env.PORT, '0.0.0.0');
  console.log(`Logbook API listening on http://0.0.0.0:${env.PORT}/v1`);
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
