import Dexie, { type Table } from 'dexie';

/**
 * Device-scoped IndexedDB (ADR-23, SYN-02).
 *
 * The device key/install id belong to the installation, not to a user: they
 * must survive user switches and explicit logout, otherwise every login would
 * register a new device and every push would be rejected. Everything that is
 * user data lives in the per-user database (db/user-db.ts).
 */
export const DEVICE_DB_NAME = 'logbook:device';

export interface DeviceMetaRow {
  key: string;
  value: string;
}

export class DeviceDatabase extends Dexie {
  meta!: Table<DeviceMetaRow, string>;

  constructor(name = DEVICE_DB_NAME) {
    super(name);
    this.version(1).stores({ meta: 'key' });
  }
}

let deviceDatabase: DeviceDatabase | null = null;

export function getDeviceDb(): DeviceDatabase {
  deviceDatabase ??= new DeviceDatabase();
  return deviceDatabase;
}

/** Test hook: forget the open handle (the database itself is untouched). */
export function resetDeviceDbHandle(): void {
  deviceDatabase = null;
}

/** Close the device database handle (tests / device reset). */
export async function closeDeviceDatabase(): Promise<void> {
  if (deviceDatabase) {
    await deviceDatabase.close();
    deviceDatabase = null;
  }
}

export async function getDeviceMeta(key: string): Promise<string | null> {
  const row = await getDeviceDb().meta.get(key);
  return row?.value ?? null;
}

export async function setDeviceMeta(key: string, value: string): Promise<void> {
  await getDeviceDb().meta.put({ key, value });
}

export async function deleteDeviceMeta(key: string): Promise<void> {
  await getDeviceDb().meta.delete(key);
}

export async function deviceMetaEntries(prefix = ''): Promise<DeviceMetaRow[]> {
  const rows = await getDeviceDb().meta.toArray();
  return prefix ? rows.filter((row) => row.key.startsWith(prefix)) : rows;
}

/** Device identity keys moved from the legacy shared database on migration. */
export const DEVICE_IDENTITY_KEYS = [
  'device_id',
  'install_id',
  'device_node',
  'hlc_last',
  'csrf_token',
  'active_user_id',
  'last_user_id',
  'known_users',
  'legacy_adopted',
  'background_sync_status',
  'sw_last_flush',
] as const;

export function isDeviceIdentityKey(key: string): boolean {
  return (
    key.startsWith('device_key:') ||
    (DEVICE_IDENTITY_KEYS as readonly string[]).includes(key)
  );
}

export async function clearDeviceMeta(): Promise<void> {
  await getDeviceDb().meta.clear();
}

export async function deleteDeviceDatabase(): Promise<void> {
  await getDeviceDb().close();
  resetDeviceDbHandle();
  await deleteDatabase(DEVICE_DB_NAME);
}

/** Promise wrapper around `indexedDB.deleteDatabase`; waits for completion. */
export async function deleteDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('deleteDatabase failed'));
    // A blocked delete finishes once the last connection closes; waiting for
    // success avoids deleting a database that a later test has just recreated.
    request.onblocked = () => undefined;
  });
}
