import Dexie from 'dexie';
import { CLIENT_SCHEMA_VERSION, LogbookDatabase } from './schema';
import { deleteDatabase } from './device-db';

/**
 * Safe Dexie schema upgrades (ADR-18, SYN-04):
 * snapshot → migrate → verify → drop snapshot; restore the snapshot when the
 * migrated database does not verify. Everything here works on raw IndexedDB so
 * the snapshot is taken *before* Dexie opens (and upgrades) the database.
 */

export interface StoreDump {
  name: string;
  rows: Record<string, unknown>[];
}

export interface DatabaseDump {
  version: number;
  stores: StoreDump[];
}

export interface MigrationSnapshotInfo {
  database: string;
  created_at: string;
  from_version: number;
  to_version: number;
  stores: Record<string, number>;
  rows: number;
}

export interface MigrationReport {
  database: string;
  status: 'fresh' | 'current' | 'upgraded' | 'rolled_back' | 'failed';
  from_version: number | null;
  to_version: number;
  verification: 'skipped' | 'passed' | 'failed';
  snapshot: MigrationSnapshotInfo | null;
  restored_rows: number;
  error: string | null;
  duration_ms: number;
}

export interface MigrationOptions {
  create?: (name: string) => LogbookDatabase;
  /** Target schema version; defaults to the client schema version. */
  toVersion?: number;
  /** Extra verification hook; returning false triggers the rollback. */
  verify?: (counts: Record<string, number>) => boolean;
  /** Keep the snapshot database even when the migration verifies. */
  keepSnapshot?: boolean;
  now?: () => number;
}

export interface MigrationResult {
  database: LogbookDatabase | null;
  report: MigrationReport;
}

const SNAPSHOT_STORES = 'stores';
const SNAPSHOT_INFO = 'info';

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function openRaw(
  name: string,
  version?: number,
  upgrade?: (database: IDBDatabase, transaction: IDBTransaction) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request =
      version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
    request.onupgradeneeded = () => {
      if (upgrade) {
        upgrade(request.result, request.transaction as IDBTransaction);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error(`Не удалось открыть базу ${name}`));
    request.onblocked = () => {
      // Another tab holds the upgrade; the request continues on its own.
    };
  });
}

export function snapshotDatabaseName(database: string, at: number): string {
  return `${database}#snapshot:${new Date(at).toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * Dexie stores its schema version as `version * 10` in IndexedDB (Dexie uses
 * the low digit internally). Reports and comparisons use the Dexie version.
 */
export function schemaVersionOf(idbVersion: number): number {
  return idbVersion >= 10 && idbVersion % 10 === 0
    ? idbVersion / 10
    : idbVersion;
}

/** Read the on-disk schema version without changing it. */
export async function readDatabaseVersion(name: string): Promise<number | null> {
  if (!(await Dexie.exists(name))) {
    return null;
  }
  const database = await openRaw(name);
  const version = schemaVersionOf(database.version);
  database.close();
  return version;
}

/** Dump every object store of a database (no schema changes). */
export async function dumpDatabase(name: string): Promise<DatabaseDump> {
  const database = await openRaw(name);
  const version = schemaVersionOf(database.version);
  const names = Array.from(database.objectStoreNames);
  const stores: StoreDump[] = [];
  try {
    const transaction = database.transaction(names, 'readonly');
    const pending = names.map(async (storeName) => {
      const rows = await requestToPromise(
        transaction.objectStore(storeName).getAll() as IDBRequest<
          Record<string, unknown>[]
        >,
      );
      return { name: storeName, rows };
    });
    stores.push(...(await Promise.all(pending)));
    await transactionDone(transaction);
  } finally {
    database.close();
  }
  return { version, stores };
}

export async function storeCounts(name: string): Promise<Record<string, number>> {
  const database = await openRaw(name);
  const names = Array.from(database.objectStoreNames);
  const counts: Record<string, number> = {};
  try {
    const transaction = database.transaction(names, 'readonly');
    const pending = names.map(async (storeName) => {
      const count = await requestToPromise(
        transaction.objectStore(storeName).count(),
      );
      return [storeName, count] as const;
    });
    for (const [storeName, count] of await Promise.all(pending)) {
      counts[storeName] = count;
    }
    await transactionDone(transaction);
  } finally {
    database.close();
  }
  return counts;
}

export function countSnapshotRows(dump: DatabaseDump): Record<string, number> {
  return Object.fromEntries(dump.stores.map((store) => [store.name, store.rows.length]));
}

export async function writeSnapshot(
  snapshotName: string,
  dump: DatabaseDump,
  info: MigrationSnapshotInfo,
): Promise<void> {
  const database = await openRaw(snapshotName, 1, (created, _transaction) => {
    created.createObjectStore(SNAPSHOT_STORES, { keyPath: 'name' });
    created.createObjectStore(SNAPSHOT_INFO, { keyPath: 'key' });
  });
  try {
    const transaction = database.transaction(
      [SNAPSHOT_STORES, SNAPSHOT_INFO],
      'readwrite',
    );
    const stores = transaction.objectStore(SNAPSHOT_STORES);
    for (const store of dump.stores) {
      stores.put({ name: store.name, rows: store.rows });
    }
    transaction.objectStore(SNAPSHOT_INFO).put({ key: 'snapshot', value: info });
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function readSnapshot(
  snapshotName: string,
): Promise<{ dump: DatabaseDump; info: MigrationSnapshotInfo | null } | null> {
  if (!(await Dexie.exists(snapshotName))) {
    return null;
  }
  const database = await openRaw(snapshotName);
  try {
    const transaction = database.transaction(
      [SNAPSHOT_STORES, SNAPSHOT_INFO],
      'readonly',
    );
    const rows = await requestToPromise(
      transaction.objectStore(SNAPSHOT_STORES).getAll() as IDBRequest<
        Array<{ name: string; rows: Record<string, unknown>[] }>
      >,
    );
    const infoRow = await requestToPromise(
      transaction.objectStore(SNAPSHOT_INFO).get('snapshot') as IDBRequest<
        { value: MigrationSnapshotInfo } | undefined
      >,
    );
    await transactionDone(transaction);
    return {
      dump: { version: infoRow?.value.from_version ?? 0, stores: rows },
      info: infoRow?.value ?? null,
    };
  } finally {
    database.close();
  }
}

/** Restore the snapshot into the target database; returns restored row count. */
export async function restoreFromSnapshot(
  targetName: string,
  snapshotName: string,
): Promise<number> {
  const snapshot = await readSnapshot(snapshotName);
  if (!snapshot) {
    return 0;
  }
  const database = await openRaw(targetName);
  const existing = new Set(Array.from(database.objectStoreNames));
  let restored = 0;
  try {
    const stores = snapshot.dump.stores.filter((store) => existing.has(store.name));
    if (stores.length === 0) {
      return 0;
    }
    const transaction = database.transaction(
      stores.map((store) => store.name),
      'readwrite',
    );
    for (const store of stores) {
      const objectStore = transaction.objectStore(store.name);
      objectStore.clear();
      for (const row of store.rows) {
        objectStore.put(row);
        restored += 1;
      }
    }
    await transactionDone(transaction);
  } finally {
    database.close();
  }
  return restored;
}

function verifyCounts(
  expected: Record<string, number>,
  actual: Record<string, number>,
): boolean {
  return Object.entries(expected).every(
    ([store, count]) => (actual[store] ?? 0) === count,
  );
}

/**
 * Delete rows by primary key from an existing database without changing its
 * schema. Used to move adopted rows out of the legacy shared database.
 */
export async function deleteRowsFromDatabase(
  name: string,
  rows: Record<string, IDBValidKey[]>,
): Promise<number> {
  const database = await openRaw(name);
  const names = Array.from(database.objectStoreNames);
  const scoped = Object.entries(rows).filter(
    ([storeName, keys]) => names.includes(storeName) && keys.length > 0,
  );
  if (scoped.length === 0) {
    database.close();
    return 0;
  }
  let deleted = 0;
  try {
    const transaction = database.transaction(
      scoped.map(([storeName]) => storeName),
      'readwrite',
    );
    for (const [storeName, keys] of scoped) {
      const objectStore = transaction.objectStore(storeName);
      for (const key of keys) {
        objectStore.delete(key);
        deleted += 1;
      }
    }
    await transactionDone(transaction);
  } finally {
    database.close();
  }
  return deleted;
}

/**
 * Open a Dexie database with an ADR-18 safe migration.
 *
 * Fresh databases are created directly. Existing databases at the current
 * version are opened as-is. Older databases are snapshotted to
 * `<name>#snapshot:<timestamp>`, migrated by Dexie, verified store by store and
 * restored from the snapshot when verification fails.
 */
export async function openWithMigrationSnapshot(
  name: string,
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const now = options.now ?? (() => Date.now());
  const create =
    options.create ?? ((databaseName: string) => new LogbookDatabase(databaseName));
  const started = now();
  const target = options.toVersion ?? CLIENT_SCHEMA_VERSION;

  if (!(await Dexie.exists(name))) {
    const database = create(name);
    await database.open();
    return {
      database,
      report: {
        database: name,
        status: 'fresh',
        from_version: null,
        to_version: database.verno,
        verification: 'skipped',
        snapshot: null,
        restored_rows: 0,
        error: null,
        duration_ms: now() - started,
      },
    };
  }

  const dump = await dumpDatabase(name);
  if (dump.version >= target) {
    const database = create(name);
    await database.open();
    return {
      database,
      report: {
        database: name,
        status: 'current',
        from_version: dump.version,
        to_version: database.verno,
        verification: 'skipped',
        snapshot: null,
        restored_rows: 0,
        error: null,
        duration_ms: now() - started,
      },
    };
  }

  const expected = countSnapshotRows(dump);
  const snapshotName = snapshotDatabaseName(name, now());
  const info: MigrationSnapshotInfo = {
    database: snapshotName,
    created_at: new Date(now()).toISOString(),
    from_version: dump.version,
    to_version: target,
    stores: expected,
    rows: Object.values(expected).reduce((sum, count) => sum + count, 0),
  };
  await writeSnapshot(snapshotName, dump, info);

  const baseReport = {
    database: name,
    from_version: dump.version,
    to_version: target,
    snapshot: info,
  };

  let database: LogbookDatabase | null = null;
  let failure: string | null = null;
  try {
    database = create(name);
    await database.open();
  } catch (error) {
    failure = error instanceof Error ? error.message : 'Ошибка миграции IndexedDB';
  }

  let verification: MigrationReport['verification'] = 'skipped';
  if (database && !failure) {
    const actual = await storeCounts(name);
    const countsOk = verifyCounts(expected, actual);
    const customOk = options.verify ? options.verify(actual) : true;
    verification = countsOk && customOk ? 'passed' : 'failed';
    if (verification === 'failed') {
      failure = 'Проверка целостности после миграции не пройдена';
    }
  }

  if (failure) {
    if (database) {
      await database.close();
    }
    const restoredRows = await restoreFromSnapshot(name, snapshotName);
    if (!options.keepSnapshot) {
      // The snapshot stays on disk: it is the only guaranteed copy when the
      // restore itself failed and the next launch must be able to retry.
      await deleteDatabase(snapshotName).catch(() => undefined);
    }
    return {
      database: null,
      report: {
        ...baseReport,
        status: restoredRows > 0 ? 'rolled_back' : 'failed',
        verification,
        restored_rows: restoredRows,
        error: failure,
        duration_ms: now() - started,
      },
    };
  }

  const report: MigrationReport = {
    ...baseReport,
    status: 'upgraded',
    verification,
    restored_rows: 0,
    error: null,
    duration_ms: now() - started,
  };

  if (!options.keepSnapshot) {
    await deleteDatabase(snapshotName).catch(() => undefined);
  }
  await database!.meta
    .put({ key: 'migration_report', value: JSON.stringify(report) })
    .catch(() => undefined);

  return { database: database!, report };
}
