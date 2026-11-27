import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { closeDeviceDatabase, deleteDatabase } from '../db/device-db';
import { resetActiveDatabase } from '../db/user-db';

/**
 * Every test starts from a clean IndexedDB: all databases of this environment
 * are deleted after closing the known Dexie handles. (Replacing the global
 * factory is not safe: Dexie binds to `indexedDB` when a database is created.)
 */
async function resetIndexedDb(): Promise<void> {
  await resetActiveDatabase();
  await closeDeviceDatabase();
  const factory = indexedDB as IDBFactory & {
    databases?: () => Promise<Array<{ name?: string }>>;
  };
  if (typeof factory.databases !== 'function') {
    return;
  }
  const names = (await factory.databases())
    .map((database) => database.name ?? '')
    .filter(Boolean);
  for (const name of names) {
    await deleteDatabase(name).catch(() => undefined);
  }
}

afterEach(async () => {
  cleanup();
  await resetIndexedDb();
});

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
