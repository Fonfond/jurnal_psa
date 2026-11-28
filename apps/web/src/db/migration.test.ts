import 'fake-indexeddb/auto';
import Dexie, { type Table } from 'dexie';
import { describe, expect, it } from 'vitest';
import { DEFAULT_JOURNAL_ID, SEED_HLC, SEED_UUIDS } from '@logbook/shared';
import { LogbookDatabase } from './schema';
import {
  dumpDatabase,
  openWithMigrationSnapshot,
  readDatabaseVersion,
  restoreFromSnapshot,
  storeCounts,
  writeSnapshot,
} from './migration';

class LegacyV3 extends Dexie {
  entries!: Table<Record<string, unknown>, string>;
  meta!: Table<Record<string, unknown>, string>;

  constructor(name: string) {
    super(name);
    this.version(3).stores({
      entries:
        'id, author_id, performed_at, permit_id, sync_status, status, event_type, journal_id',
      meta: 'key',
    });
  }
}

function entry(index: number): Record<string, unknown> {
  return {
    id: `01930000-0000-7000-8000-${String(index).padStart(12, '0')}`,
    author_id: SEED_UUIDS.worker,
    performed_at: new Date(Date.UTC(2026, 10, 20, 8, 0, index % 60)).toISOString(),
    performed_tz_offset_min: 180,
    work_type_id: SEED_UUIDS.workTypePermit,
    site_id: SEED_UUIDS.siteWorkshop,
    permit_id: null,
    text: `Запись ${index}`,
    input_method: 'manual',
    status: 'active',
    sync_status: 'synced',
    version: 1,
    hlc: SEED_HLC.entry1,
    created_at_client: '2026-11-20T08:05:00.000Z',
    updated_at_client: '2026-11-20T08:05:00.000Z',
    journal_id: DEFAULT_JOURNAL_ID,
    revision_no: 0,
  };
}

async function seedLegacy(name: string, rows: number): Promise<void> {
  const legacy = new LegacyV3(name);
  await legacy.open();
  await legacy.table('entries').bulkPut(
    Array.from({ length: rows }, (_value, index) => entry(index + 1)),
  );
  await legacy.table('meta').put({ key: 'snapshot_id', value: 'ds_legacy' });
  await legacy.close();
}

describe('IndexedDB migration with snapshot (ADR-18/SYN-04)', () => {
  it('creates a fresh database without a snapshot', async () => {
    const { database, report } = await openWithMigrationSnapshot(
      'logbook:migration-fresh',
    );
    expect(report.status).toBe('fresh');
    expect(report.from_version).toBeNull();
    expect(report.verification).toBe('skipped');
    expect(database?.verno).toBe(6);
    await database?.close();
  });

  it('opens an already migrated database as current', async () => {
    const first = await openWithMigrationSnapshot('logbook:migration-current');
    await first.database?.close();
    const second = await openWithMigrationSnapshot('logbook:migration-current');
    expect(second.report.status).toBe('current');
    expect(second.report.verification).toBe('skipped');
    await second.database?.close();
  });

  it(
    'migrates 10 000 entries from v3 to v6 with a verified snapshot',
    async () => {
      const name = 'logbook:migration-10k';
      await seedLegacy(name, 10_000);

      const { database, report } = await openWithMigrationSnapshot(name);

      expect(report.status).toBe('upgraded');
      expect(report.from_version).toBe(3);
      expect(report.to_version).toBe(6);
      expect(report.verification).toBe('passed');
      expect(report.snapshot?.rows).toBe(10_001);
      expect(await database?.entries.count()).toBe(10_000);
      expect(await database?.meta.get('snapshot_id')).toMatchObject({
        value: 'ds_legacy',
      });
      expect(await database?.table('supervisor_cache').count()).toBe(0);
      await database?.close();

      // Snapshot is removed after a successful verification.
      expect(report.snapshot).not.toBeNull();
      expect(await Dexie.exists(report.snapshot!.database)).toBe(false);

      // The report is persisted for diagnostics (RUNBOOK).
      const reopened = new LogbookDatabase(name);
      expect(await reopened.meta.get('migration_report')).toMatchObject({
        key: 'migration_report',
      });
      await reopened.close();
    },
    120_000,
  );

  it(
    'rolls back to the snapshot when verification fails',
    async () => {
      const name = 'logbook:migration-rollback';
      await seedLegacy(name, 60);

      const { database, report } = await openWithMigrationSnapshot(name, {
        verify: () => false,
        keepSnapshot: true,
      });

      expect(database).toBeNull();
      expect(report.status).toBe('rolled_back');
      expect(report.verification).toBe('failed');
      expect(report.restored_rows).toBe(61);
      expect(report.snapshot).not.toBeNull();

      const counts = await storeCounts(name);
      expect(counts.entries).toBe(60);
      expect(counts.meta).toBe(1);
      const dump = await dumpDatabase(name);
      expect(dump.stores.find((store) => store.name === 'entries')?.rows).toHaveLength(
        60,
      );
    },
    120_000,
  );

  it('restores rows when the upgrade itself throws', async () => {
    const name = 'logbook:migration-broken-upgrade';
    await seedLegacy(name, 25);

    let calls = 0;
    const { database, report } = await openWithMigrationSnapshot(name, {
      create: (databaseName) => {
        const instance = new LogbookDatabase(databaseName);
        calls += 1;
        if (calls > 0) {
          // This instance triggers the upgrade and fails.
          (instance as unknown as { open: () => Promise<never> }).open = async () => {
            throw new Error('upgrade failed');
          };
        }
        return instance;
      },
      keepSnapshot: true,
    });

    expect(database).toBeNull();
    expect(report.status).toBe('rolled_back');
    expect(report.error).toContain('upgrade failed');
    expect(report.restored_rows).toBe(26);
    expect(await readDatabaseVersion(name)).toBe(3);
    expect((await storeCounts(name)).entries).toBe(25);
  });

  it('reads and restores a snapshot explicitly', async () => {
    const name = 'logbook:migration-snapshot-read';
    await seedLegacy(name, 3);
    const dump = await dumpDatabase(name);
    const snapshotName = 'logbook:snapshot-read-test';
    await writeSnapshot(snapshotName, dump, {
      database: name,
      created_at: new Date().toISOString(),
      from_version: 3,
      to_version: 6,
      stores: { entries: 3, meta: 1 },
      rows: 4,
    });
    const legacy = new LegacyV3(name);
    await legacy.open();
    await legacy.table('entries').clear();
    await legacy.close();

    const restored = await restoreFromSnapshot(name, snapshotName);
    expect(restored).toBe(4);
    expect((await storeCounts(name)).entries).toBe(3);
  });
});

