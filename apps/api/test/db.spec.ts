import { seedDatabase } from '../../../db/seed/seed';
import { runMigrations } from '../src/db/migrator';
import { PgliteSqlClient } from '../src/db/pglite-client';

describe('database migrations and seed', () => {
  let client: PgliteSqlClient;

  beforeEach(async () => {
    client = new PgliteSqlClient();
  });

  afterEach(async () => {
    await client.close();
  });

  it('applies 0001..0018 once and is idempotent', async () => {
    const first = await runMigrations(client);
    expect(first).toEqual([
      '0001_init.sql',
      '0002_dictionaries.sql',
      '0003_journal.sql',
      '0004_sync_audit.sql',
      '0005_field_clocks.sql',
      '0006_operational_journal.sql',
      '0007_auth_platform.sql',
      '0008_multi_journal.sql',
      '0009_shifts.sql',
      '0010_groundings.sql',
      '0011_permit_pdf.sql',
      '0012_retention_export.sql',
      '0013_batch_journal_seq.sql',
      '0014_journal_sequences.sql',
      '0015_audit_outbox_gapless_seq.sql',
      '0016_journal_seq_gaps_policy.sql',
      '0017_retention_scheduler.sql',
      '0018_entry_attachments.sql',
    ]);

    const second = await runMigrations(client);
    expect(second).toEqual([]);

    const applied = await client.query<{ count: string }>(
      'select count(*)::text as count from schema_migrations',
    );
    expect(applied.rows[0]?.count).toBe('18');
  }, 120_000);

  it('creates the expected schema', async () => {
    await runMigrations(client);
    const tables = await client.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public'
        order by table_name`,
    );
    const names = tables.rows.map((row) => row.table_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'archive_manifests',
        'audit_events',
        'audit_outbox',
        'backup_checkpoints',
        'change_log',
        'departments',
        'devices',
        'dictionary_versions',
        'document_signatures',
        'entry_attachments',
        'entry_revisions',
        'entry_workers',
        'groundings',
        'idempotency_records',
        'journal_counters',
        'journal_entries',
        'journal_members',
        'journal_reviews',
        'journals',
        'oidc_login_requests',
        'permit_participants',
        'permits',
        'retention_runs',
        'sessions',
        'shifts',
        'sites',
        'templates',
        'user_credentials',
        'user_identities',
        'users',
        'work_types',
      ]),
    );
  });

  it('seeds deterministic data and tolerates a second run', async () => {
    await runMigrations(client);
    const first = await seedDatabase(client, 'Logbook!2026');
    expect(first).toEqual({ users: 3, permits: 3, entries: 5 });

    const second = await seedDatabase(client, 'Logbook!2026');
    expect(second).toEqual({ users: 3, permits: 3, entries: 5 });

    const entries = await client.query<{
      id: string;
      status: string;
      permit_risk_flag: boolean;
      input_method: string;
      hlc: string;
    }>(
      `select id, status, permit_risk_flag, input_method, hlc
         from journal_entries
        order by performed_at`,
    );
    expect(entries.rows).toHaveLength(5);
    expect(entries.rows.filter((row) => row.status === 'deleted')).toHaveLength(1);
    expect(entries.rows.filter((row) => row.permit_risk_flag)).toHaveLength(1);
    expect(entries.rows.filter((row) => row.input_method === 'voice')).toHaveLength(1);
    expect(entries.rows.every((row) => /^\d{13}:\d{5}:[A-Za-z0-9_-]{8}$/.test(row.hlc))).toBe(
      true,
    );

    const activePermits = await client.query<{ count: string }>(
      `select count(*)::text as count from permits where status = 'active'`,
    );
    expect(activePermits.rows[0]?.count).toBe('1');
  });

  it('keeps fixed UUIDs and HLC values stable', async () => {
    await runMigrations(client);
    await seedDatabase(client, 'Logbook!2026');
    const entry = await client.query<{ id: string; hlc: string }>(
      `select id, hlc from journal_entries
        where id = '01930000-0000-7000-8000-000000000801'`,
    );
    expect(entry.rows[0]).toEqual({
      id: '01930000-0000-7000-8000-000000000801',
      hlc: '1795000000000:00001:seed0001',
    });
  });

  it('seeds two journals and numbers entries independently per journal', async () => {
    await runMigrations(client);
    await seedDatabase(client, 'Logbook!2026');

    const journals = await client.query<{ journal_key: string }>(
      'select journal_key from journals order by sort_order',
    );
    expect(journals.rows.map((row) => row.journal_key)).toEqual([
      'main',
      'substation',
    ]);

    // All seeded entries belong to `main` and keep sequential numbering.
    const mainSeqs = await client.query<{ journal_seq: string }>(
      `select journal_seq::text
         from journal_entries
        where journal_id = '01930000-0000-7000-8000-000000001001'
        order by journal_seq`,
    );
    expect(mainSeqs.rows.map((row) => Number(row.journal_seq))).toEqual([
      1, 2, 3, 4, 5,
    ]);

    // A second journal starts its own numbering at 1.
    await client.query(
      `insert into journal_entries
         (id, author_id, performed_at, performed_tz_offset_min, performed_at_source,
          work_type_id, "text", input_method, hlc, created_at_client, updated_at_client,
          journal_id)
       values
         ('01930000-0000-7000-8000-0000000008f1',
          '01930000-0000-7000-8000-000000000101',
          '2026-11-24T08:00:00.000Z', 180, 'manual',
          '01930000-0000-7000-8000-000000000301',
          'Запись в журнале подстанции', 'manual',
          '1795000000006:00001:seed0001', '2026-11-24T08:00:00.000Z',
          '2026-11-24T08:00:00.000Z',
          '01930000-0000-7000-8000-000000001002')`,
    );
    const substation = await client.query<{ journal_seq: string }>(
      `select journal_seq::text from journal_entries
        where journal_id = '01930000-0000-7000-8000-000000001002'`,
    );
    expect(substation.rows).toHaveLength(1);
    expect(Number(substation.rows[0]?.journal_seq)).toBe(1);

    // The journal of an existing entry cannot be changed.
    await expect(
      client.query(
        `update journal_entries
            set journal_id = '01930000-0000-7000-8000-000000001002'
          where id = '01930000-0000-7000-8000-000000000801'`,
      ),
    ).rejects.toThrow(/journal_id is immutable/);
  });
});
