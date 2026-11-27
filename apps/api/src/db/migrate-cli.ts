import { loadEnv } from '../config/env';
import { createSqlClient } from './client-factory';
import { runMigrations } from './migrator';

async function main(): Promise<void> {
  const env = loadEnv();
  const client = await createSqlClient(env);
  try {
    const applied = await runMigrations(client);
    if (applied.length === 0) {
      console.log('Migrations: no pending migrations');
    } else {
      console.log(`Migrations applied: ${applied.join(', ')}`);
    }
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
