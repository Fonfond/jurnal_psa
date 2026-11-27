import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { migrationsDirectory } from './paths';
import type { SqlClient } from './sql-client';

interface AppliedMigration {
  filename: string;
  checksum: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Applies pending SQL migrations in filename order.
 * Each migration is wrapped into a transaction; checksum protects against edits.
 */
export async function runMigrations(
  client: SqlClient,
  directory: string = migrationsDirectory(),
): Promise<string[]> {
  await client.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const files = (await readdir(directory))
    .filter((file) => file.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));

  const appliedResult = await client.query<AppliedMigration>(
    'select filename, checksum from schema_migrations',
  );
  const applied = new Map(appliedResult.rows.map((row) => [row.filename, row.checksum]));

  const newlyApplied: string[] = [];

  for (const file of files) {
    const sql = await readFile(path.join(directory, file), 'utf8');
    const checksum = sha256(sql);
    const previous = applied.get(file);

    if (previous) {
      if (previous !== checksum) {
        throw new Error(
          `Migration ${file} was modified after being applied (checksum mismatch)`,
        );
      }
      continue;
    }

    try {
      await client.exec(`BEGIN;\n${sql}\nCOMMIT;`);
    } catch (error) {
      try {
        await client.exec('ROLLBACK;');
      } catch {
        // connection may already be aborted
      }
      throw new Error(
        `Migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await client.query(
      'insert into schema_migrations (filename, checksum) values ($1, $2)',
      [file, checksum],
    );
    newlyApplied.push(file);
  }

  return newlyApplied;
}
