import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { uuidv7 } from '@logbook/shared';
import { seedDatabase } from '../../../db/seed/seed';
import { migrationsDirectory } from '../src/db/paths';
import { runMigrations } from '../src/db/migrator';
import { PgliteSqlClient } from '../src/db/pglite-client';

const SIMPLE_WORK_TYPE = '01930000-0000-7000-8000-000000000302';
const FIELD_SITE = '01930000-0000-7000-8000-000000000402';

async function migrationDirUpTo(last: string): Promise<string> {
  const source = migrationsDirectory();
  const target = await mkdtemp(path.join(tmpdir(), 'logbook-mig-'));
  for (const file of (await readdir(source)).filter((name) => name.endsWith('.sql')).sort()) {
    if (file <= last) {
      await copyFile(path.join(source, file), path.join(target, file));
    }
  }
  return target;
}

async function insertEntry(client: PgliteSqlClient, text: string): Promise<{ id: string; seq: number }> {
  const id = uuidv7();
  const result = await client.query<{ journal_seq: string }>(
    `insert into journal_entries
       (id, author_id, performed_at, performed_tz_offset_min,
        performed_at_source, work_type_id, site_id, "text", input_method,
        hlc, created_at_client, updated_at_client, journal_id)
     values ($1, '01930000-0000-7000-8000-000000000101',
             '2026-11-23T11:55:00.000Z', 180,
             'device_auto'::performed_source_enum, $2, $3, $4, 'manual',
             '1795000000999:00001:upgrade01', '2026-11-23T12:00:00.000Z',
             '2026-11-23T12:00:00.000Z',
             (select id from journals where journal_key = 'main'))
     returning journal_seq::text as journal_seq`,
    [id, SIMPLE_WORK_TYPE, FIELD_SITE, text],
  );
  return { id, seq: Number(result.rows[0]!.journal_seq) };
}

describe('migration upgrade 0014 -> 0016 (REP-06/B-10, t29)', () => {
  it('backfills counters, keeps sequence numbering unique and accepts the gap policy', async () => {
    const client = new PgliteSqlClient();
    const partial = await migrationDirUpTo('0014_journal_sequences.sql');
    try {
      const applied = await runMigrations(client, partial);
      expect(applied).toHaveLength(14);
      await seedDatabase(client, 'Logbook!2026');

      const before = await client.query<{ max: string; min: string }>(
        `select coalesce(max(journal_seq), 0)::text as max,
                coalesce(min(journal_seq), 0)::text as min
           from journal_entries`,
      );
      expect(Number(before.rows[0]!.max)).toBeGreaterThan(0);
      expect(Number(before.rows[0]!.min)).toBeGreaterThan(0);

      // 0013/0014 advanced sequences, not counters: the upgrade must fix this.
      const stale = await client.query<{ last_seq: string }>(
        `select last_seq::text from journal_counters
          where journal_id = (select id from journals where journal_key = 'main')`,
      );
      expect(Number(stale.rows[0]?.last_seq)).toBe(0);

      const full = await runMigrations(client);
      expect(full).toContain('0015_audit_outbox_gapless_seq.sql');
      expect(full).toContain('0016_journal_seq_gaps_policy.sql');

      const maxSeq = Number(before.rows[0]!.max);
      const counters = await client.query<{
        journal_key: string;
        last_seq: string;
        max_seq: string;
      }>(
        `select j.journal_key,
                c.last_seq::text,
                coalesce((select max(e.journal_seq) from journal_entries e
                           where e.journal_id = j.id), 0)::text as max_seq
           from journal_counters c
           join journals j on j.id = c.journal_id
          order by j.journal_key`,
      );
      for (const row of counters.rows) {
        expect(Number(row.last_seq)).toBe(Number(row.max_seq));
      }
      const mainCounter = counters.rows.find((row) => row.journal_key === 'main');
      expect(Number(mainCounter?.last_seq)).toBe(maxSeq);

      // Post-upgrade inserts continue after MAX, not from 1/0, and stay unique.
      const first = await insertEntry(client, 'Запись после обновления 0015');
      const second = await insertEntry(client, 'Вторая запись после обновления');
      expect(first.seq).toBe(maxSeq + 1);
      expect(second.seq).toBe(maxSeq + 2);

      const duplicates = await client.query<{ count: string }>(
        `select count(*)::text as count from (
           select journal_id, journal_seq from journal_entries
            where journal_seq is not null
            group by journal_id, journal_seq having count(*) > 1
         ) d`,
      );
      expect(duplicates.rows[0]?.count).toBe('0');
      const negative = await client.query<{ count: string }>(
        'select count(*)::text as count from journal_entries where journal_seq < 0',
      );
      expect(negative.rows[0]?.count).toBe('0');
    } finally {
      await client.close();
      await rm(partial, { recursive: true, force: true });
    }
  });
});
