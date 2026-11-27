import { seedDatabase } from '../../../../db/seed/seed';
import { loadEnv } from '../config/env';
import { createSqlClient } from './client-factory';
import { runMigrations } from './migrator';

async function main(): Promise<void> {
  const env = loadEnv();
  const client = await createSqlClient(env);
  try {
    await runMigrations(client);
    const summary = await seedDatabase(client, env.DEV_SEED_PASSWORD);
    // F-01: mandatory after a fresh install/seed; without stats the first
    // /sync/changes can choose a seq scan and exceed the p95 threshold.
    await client.query('ANALYZE');
    console.log(
      `Seed complete: users=${summary.users}, permits=${summary.permits}, entries=${summary.entries}; ANALYZE done`,
    );
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
