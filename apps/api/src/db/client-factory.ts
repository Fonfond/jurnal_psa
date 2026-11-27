import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadEnv, type Env } from '../config/env';
import { findRepoRoot } from './paths';
import { PgSqlClient, type PgTlsOptions } from './pg-client';
import { PgliteSqlClient } from './pglite-client';
import type { SqlClient } from './sql-client';

function databaseTls(env: Env): PgTlsOptions | undefined {
  if (env.DATABASE_SSL_MODE === 'disable') {
    return undefined;
  }
  const caPath = env.DATABASE_SSL_CA_PATH
    ? path.isAbsolute(env.DATABASE_SSL_CA_PATH)
      ? env.DATABASE_SSL_CA_PATH
      : path.resolve(findRepoRoot(), env.DATABASE_SSL_CA_PATH)
    : undefined;
  return {
    rejectUnauthorized: env.DATABASE_SSL_MODE === 'verify-full',
    ...(caPath ? { ca: PgSqlClient.loadCa(caPath) } : {}),
  };
}

export async function createSqlClient(env: Env = loadEnv()): Promise<SqlClient> {
  let client: SqlClient;

  if (env.DATABASE_URL) {
    client = new PgSqlClient(env.DATABASE_URL, {
      max: env.DATABASE_POOL_MAX,
      ssl: databaseTls(env),
    });
  } else if (env.PGLITE_DIR) {
    const dataDir = path.isAbsolute(env.PGLITE_DIR)
      ? env.PGLITE_DIR
      : path.resolve(findRepoRoot(), env.PGLITE_DIR);
    mkdirSync(dataDir, { recursive: true });
    client = new PgliteSqlClient(dataDir);
  } else {
    client = new PgliteSqlClient();
  }

  await client.query('select 1');
  return client;
}
