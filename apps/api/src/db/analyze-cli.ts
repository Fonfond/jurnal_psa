import { loadEnv } from '../config/env';
import { createSqlClient } from './client-factory';

/**
 * Mandatory post-install/post-seed step (F-01): refresh planner statistics.
 * A fresh PostgreSQL without ANALYZE can choose a sequential scan for
 * `/sync/changes`, which blows the changes p95 on the first cold load.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const client = await createSqlClient(env);
  try {
    await client.query('ANALYZE');
    console.log('ANALYZE complete: planner statistics refreshed');
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
