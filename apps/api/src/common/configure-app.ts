import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { loadEnv } from '../config/env';
import { requestContext } from './context';
import { rateLimit } from './rate-limit';
import { securityHeaders } from './security-headers';

export function configureApp(app: INestApplication): void {
  const env = loadEnv();
  app.setGlobalPrefix('v1');
  if (env.TRUST_PROXY) {
    // nginx sets X-Forwarded-For/Proto; needed for real client IP and HSTS.
    (app as NestExpressApplication).set('trust proxy', 1);
  }
  app.use(cookieParser(env.COOKIE_SECRET) as never);
  app.use(requestContext as never);
  app.use(securityHeaders(env) as never);
  app.use(rateLimit(env) as never);

  // ADR-14: the operational SPA and the separate admin origin are both allowed.
  const origins = [env.CORS_ORIGIN, env.ADMIN_ORIGIN].filter(
    (origin): origin is string => Boolean(origin),
  );
  app.enableCors({
    origin: origins,
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'X-CSRF-Token',
      'X-Request-Id',
      'X-Device-Key',
      'X-App-Version',
      'Idempotency-Key',
    ],
    exposedHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After',
      'X-Request-Id',
    ],
  });
}
