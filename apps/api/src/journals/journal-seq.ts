import type { SqlClient } from '../db/sql-client';

/** PostgreSQL sequence backing independent journal_seq numbering. */
export function journalSeqSequenceName(journalId: string): string {
  return `journal_seq_${journalId.replace(/-/g, '_')}`;
}

/**
 * Creates the per-journal sequence when a journal is created. Migration 0014
 * backfills existing journals; this keeps new journals lock-free for batch
 * sequence allocation.
 */
export async function ensureJournalSequence(
  client: SqlClient,
  journalId: string,
  start = 1,
): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(journalId)) {
    throw new Error('journal sequence: invalid journal id');
  }
  const name = journalSeqSequenceName(journalId);
  await client.exec(
    `CREATE SEQUENCE IF NOT EXISTS "${name}" START WITH ${Math.max(1, Math.trunc(start))}`,
  );
}
