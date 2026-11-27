import Dexie from 'dexie';
import { DEFAULT_JOURNAL_ID } from '@logbook/shared';
import {
  deleteDatabase,
  getDeviceMeta,
  isDeviceIdentityKey,
  setDeviceMeta,
} from './device-db';
import {
  countSnapshotRows,
  deleteRowsFromDatabase,
  dumpDatabase,
  openWithMigrationSnapshot,
  snapshotDatabaseName,
  storeCounts,
  writeSnapshot,
  type MigrationOptions,
  type MigrationReport,
  type StoreDump,
} from './migration';
import { getDb, LEGACY_DB_NAME, LogbookDatabase, setActiveDatabase } from './schema';

/**
 * Per-user local storage (SYN-02, ADR-16, OQ-21).
 *
 * Every signed-in account gets its own IndexedDB database
 * `logbook:user:<user_id>`; dictionaries and entries therefore cannot leak
 * between accounts on a shared device. Device identity stays in
 * `logbook:device` (db/device-db.ts).
 */

export const USER_DB_PREFIX = 'logbook:user:';

export function userDatabaseName(userId: string): string {
  return `${USER_DB_PREFIX}${userId}`;
}

export interface LegacyAdoptionReport {
  legacy_database: string;
  adopted: boolean;
  verified: boolean;
  stores: Record<string, number>;
  device_keys: string[];
  remaining_rows: number;
  snapshot: string | null;
}

export interface UserDatabaseActivation {
  user_id: string;
  database: string;
  migration: MigrationReport;
  adoption: LegacyAdoptionReport | null;
}

function asRows(store: StoreDump | undefined): Record<string, unknown>[] {
  return store?.rows ?? [];
}

function normalizeEntry(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    journal_id: row.journal_id ?? DEFAULT_JOURNAL_ID,
    sync_status: row.sync_status ?? 'synced',
    status: row.status ?? 'active',
  };
}

/**
 * One-time move of pre-per-user data from the shared `logbook` database.
 *
 * Only rows owned by `userId` are copied; rows of other accounts stay in the
 * legacy database (and are never opened by the app again). Device identity is
 * copied into the device database so device registration survives.
 */
export async function adoptLegacyDatabase(
  userId: string,
  target: LogbookDatabase,
  options: { now?: () => number; keepSnapshot?: boolean } = {},
): Promise<LegacyAdoptionReport | null> {
  if (!(await Dexie.exists(LEGACY_DB_NAME))) {
    return null;
  }
  const now = options.now ?? (() => Date.now());
  const dump = await dumpDatabase(LEGACY_DB_NAME);
  const byName = new Map(dump.stores.map((store) => [store.name, store]));

  const entries = asRows(byName.get('entries'))
    .filter((row) => row.author_id === userId)
    .map(normalizeEntry);
  const entryIds = new Set(entries.map((row) => String(row.id)));
  const revisions = asRows(byName.get('revisions')).filter((row) =>
    entryIds.has(String(row.entry_id)),
  );
  const outbox = asRows(byName.get('outbox')).filter(
    (row) => row.user_id === userId,
  );
  const drafts = asRows(byName.get('drafts')).filter(
    (row) => row.user_id === userId,
  );
  const conflicts = asRows(byName.get('conflicts')).filter((row) =>
    entryIds.has(String(row.entry_id)),
  );
  const reviews = asRows(byName.get('journal_reviews')).filter(
    (row) => row.reviewer_id === userId,
  );
  const entryWorkers = asRows(byName.get('entry_workers')).filter(
    (row) => row.user_id === userId || entryIds.has(String(row.entry_id)),
  );

  const sharedStores: Array<[string, Record<string, unknown>[]]> = [
    ['dict_work_types', asRows(byName.get('dict_work_types'))],
    ['dict_sites', asRows(byName.get('dict_sites'))],
    ['dict_templates', asRows(byName.get('dict_templates'))],
    ['dict_reasons', asRows(byName.get('dict_reasons'))],
    ['dict_departments', asRows(byName.get('dict_departments'))],
    ['journals', asRows(byName.get('journals'))],
    ['permits', asRows(byName.get('permits'))],
  ];

  const metaRows = asRows(byName.get('meta'));
  const syncState = asRows(byName.get('sync_state'));
  const carriedMeta = metaRows.filter(
    (row) =>
      !isDeviceIdentityKey(String(row.key)) &&
      ['snapshot_id', 'dict_versions', 'schema_version'].includes(String(row.key)),
  );

  const adoptedStores: Array<[string, Record<string, unknown>[]]> = [
    ['entries', entries],
    ['revisions', revisions],
    ['entry_workers', entryWorkers],
    ['outbox', outbox],
    ['conflicts', conflicts],
    ['drafts', drafts],
    ['journal_reviews', reviews],
    ['sync_state', entries.length > 0 || outbox.length > 0 || reviews.length > 0 ? syncState : []],
    ['meta', carriedMeta],
    ...sharedStores,
  ];

  const adopted = adoptedStores.some(([, rows]) => rows.length > 0);
  const stores: Record<string, number> = {};
  let verified = true;

  if (adopted) {
    await target.transaction('rw', target.tables, async () => {
      for (const [storeName, rows] of adoptedStores) {
        if (rows.length === 0) continue;
        const table = target.table(storeName);
        if (!table) continue;
        await table.bulkPut(rows);
        stores[storeName] = rows.length;
      }
    });

    // ADR-18: verify the copy before the legacy rows are removed.
    for (const [storeName, rows] of adoptedStores) {
      if (rows.length === 0) continue;
      const count = await target.table(storeName).count();
      if (count !== rows.length) {
        verified = false;
        break;
      }
    }
  }

  if (adopted && verified) {
    // Rows are moved, not copied: the legacy database keeps only other
    // accounts' data (and shared dictionaries) for their first login.
    await deleteRowsFromDatabase(LEGACY_DB_NAME, {
      entries: entries.map((row) => String(row.id)),
      revisions: revisions.map((row) => String(row.id)),
      entry_workers: entryWorkers.map((row) => [
        String(row.entry_id),
        String(row.user_id),
      ]),
      outbox: outbox.map((row) => String(row.op_id)),
      conflicts: conflicts.map((row) => String(row.id)),
      drafts: drafts.map((row) => String(row.id)),
      journal_reviews: reviews.map((row) => String(row.id)),
    });
  }

  // Device identity: the device database wins when it already has a value.
  const deviceKeys: string[] = [];
  for (const row of metaRows) {
    const key = String(row.key);
    if (!isDeviceIdentityKey(key)) continue;
    if (await getDeviceMeta(key)) continue;
    await setDeviceMeta(key, String(row.value));
    deviceKeys.push(key);
  }

  const remainingCounts = await storeCounts(LEGACY_DB_NAME);
  const remainingRows = [
    'entries',
    'revisions',
    'entry_workers',
    'outbox',
    'conflicts',
    'drafts',
    'journal_reviews',
  ].reduce((sum, store) => sum + (remainingCounts[store] ?? 0), 0);

  if (adopted && !verified) {
    throw new Error(
      'Не удалось перенести локальные данные в хранилище пользователя: проверка копии не пройдена',
    );
  }

  // ADR-18: snapshot the legacy database before it may be deleted.
  let snapshot: string | null = null;
  if (remainingRows === 0) {
    snapshot = snapshotDatabaseName(LEGACY_DB_NAME, now());
    const counts = countSnapshotRows(dump);
    await writeSnapshot(snapshot, dump, {
      database: LEGACY_DB_NAME,
      created_at: new Date(now()).toISOString(),
      from_version: dump.version,
      to_version: target.verno,
      stores: counts,
      rows: Object.values(counts).reduce((sum, n) => sum + n, 0),
    });
  }

  const report: LegacyAdoptionReport = {
    legacy_database: LEGACY_DB_NAME,
    adopted,
    verified,
    stores,
    device_keys: deviceKeys,
    remaining_rows: remainingRows,
    snapshot,
  };
  await setDeviceMeta(`legacy_adopted:${userId}`, JSON.stringify(report));
  return report;
}

export async function rememberUser(userId: string): Promise<void> {
  const known = await listKnownUsers();
  if (!known.includes(userId)) {
    known.push(userId);
  }
  await setDeviceMeta('known_users', JSON.stringify(known));
}

export async function listKnownUsers(): Promise<string[]> {
  const raw = await getDeviceMeta('known_users');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export async function activeUserId(): Promise<string | null> {
  const value = await getDeviceMeta('active_user_id');
  return value ? value : null;
}

/**
 * Open (and if needed create/adopt/migrate) the database of `userId` and make
 * it the active one for the whole app.
 */
export async function activateUserDatabase(
  userId: string,
  options: MigrationOptions = {},
): Promise<UserDatabaseActivation> {
  const name = userDatabaseName(userId);
  const migration = await openWithMigrationSnapshot(name, options);
  if (!migration.database) {
    throw new Error(
      `Локальная база не открыта: ${migration.report.error ?? 'неизвестная ошибка'}`,
    );
  }

  let adoption: LegacyAdoptionReport | null = null;
  if (migration.report.status === 'fresh') {
    adoption = await adoptLegacyDatabase(userId, migration.database, options);
  }

  const previous = setActiveDatabase(migration.database);
  if (previous !== migration.database) {
    await previous.close();
  }

  await rememberUser(userId);
  await setDeviceMeta('active_user_id', userId);
  await setDeviceMeta('last_user_id', userId);

  if (adoption && adoption.remaining_rows === 0) {
    // The legacy database has been fully adopted: close it for good.
    await deleteDatabase(LEGACY_DB_NAME).catch(() => undefined);
  }

  return {
    user_id: userId,
    database: name,
    migration: migration.report,
    adoption,
  };
}

/** Close the active user database; data stays on disk (ADR-10 "lock"). */
export async function closeActiveDatabase(): Promise<void> {
  const current = getDb();
  if (current.name !== LEGACY_DB_NAME) {
    await current.close();
  }
  setActiveDatabase(new LogbookDatabase(LEGACY_DB_NAME));
  await setDeviceMeta('active_user_id', '').catch(() => undefined);
}

/** Remove the local database of a user (explicit logout with cleanup). */
export async function deleteUserDatabase(userId: string): Promise<void> {
  const name = userDatabaseName(userId);
  if (getDb().name === name) {
    await closeActiveDatabase();
  }
  await deleteDatabase(name).catch(() => undefined);
}

/** Test/diagnostic helper: list every per-user database on this device. */
export async function listUserDatabases(): Promise<string[]> {
  const anyIndexedDB = indexedDB as IDBFactory & {
    databases?: () => Promise<Array<{ name?: string }>>;
  };
  if (typeof anyIndexedDB.databases !== 'function') {
    return (await listKnownUsers()).map(userDatabaseName);
  }
  const databases = await anyIndexedDB.databases();
  return databases
    .map((entry) => entry.name ?? '')
    .filter((name) => name.startsWith(USER_DB_PREFIX));
}

/** Test hook: close the active database and point the registry at a fresh one. */
export async function resetActiveDatabase(): Promise<void> {
  const current = getDb();
  await current.close();
  setActiveDatabase(new LogbookDatabase(LEGACY_DB_NAME));
}
