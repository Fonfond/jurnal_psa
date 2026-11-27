import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_JOURNAL_ID,
  SEED_HLC,
  SEED_UUIDS,
  type Journal,
  type JournalReview,
} from '@logbook/shared';
import type { ApiUser } from '../api/types';
import { getDeviceMeta } from './device-db';
import {
  clearLocalUserData,
  createLocalEntry,
  getDeviceId,
  getInstallId,
  listLocalEntries,
} from './repositories';
import { db, LEGACY_DB_NAME, LogbookDatabase } from './schema';
import {
  activateUserDatabase,
  activeUserId,
  closeActiveDatabase,
  deleteUserDatabase,
  listUserDatabases,
  userDatabaseName,
} from './user-db';

function makeUser(id: string, role: ApiUser['role'] = 'worker'): ApiUser {
  return {
    id,
    full_name: role === 'supervisor' ? 'Пётр Смирнов' : 'Иван Петров',
    role,
    department: { id: '01930000-0000-7000-8000-000000000001', name: 'Участок' },
    status: 'active',
    email: `${role}@logbook.local`,
  };
}

const alice = makeUser('01930000-0000-7000-8000-000000000101');
const bob = makeUser('01930000-0000-7000-8000-000000000102', 'supervisor');

const input = {
  performed_at: '2026-11-24T08:00:00.000Z',
  performed_tz_offset_min: 480,
  work_type_id: '01930000-0000-7000-8000-000000000302',
  site_id: '01930000-0000-7000-8000-000000000402',
  permit_id: null,
  text: 'Проверил оборудование на участке',
  input_method: 'manual' as const,
};

function legacyEntry(id: string, authorId: string, text: string) {
  return {
    id,
    author_id: authorId,
    performed_at: '2026-11-20T08:00:00.000Z',
    performed_tz_offset_min: 180,
    work_type_id: SEED_UUIDS.workTypePermit,
    site_id: SEED_UUIDS.siteWorkshop,
    permit_id: null,
    permit_number_raw: null,
    permit_binding_status: 'not_required',
    text,
    input_method: 'manual',
    status: 'active',
    sync_status: 'synced',
    version: 1,
    hlc: SEED_HLC.entry1,
    created_at_client: '2026-11-20T08:05:00.000Z',
    updated_at_client: '2026-11-20T08:05:00.000Z',
    journal_id: DEFAULT_JOURNAL_ID,
    revision_no: 0,
    device_id: SEED_UUIDS.deviceWorker,
  };
}

describe('per-user IndexedDB (SYN-02)', () => {
  it('keeps entries and journals separated between two users', async () => {
    const deviceId = await getDeviceId();
    const installId = await getInstallId();

    await activateUserDatabase(alice.id);
    await expect(activeUserId()).resolves.toBe(alice.id);
    await createLocalEntry(input, alice);
    await createLocalEntry(
      { ...input, journal_id: SEED_UUIDS.journalSubstation },
      alice,
    );
    expect(await listLocalEntries()).toHaveLength(2);

    await activateUserDatabase(bob.id);
    expect(await listLocalEntries()).toHaveLength(0);
    expect(await db.entries.count()).toBe(0);
    await createLocalEntry(input, bob);
    const bobEntries = await listLocalEntries();
    expect(bobEntries).toHaveLength(1);
    expect(bobEntries[0]?.author_id).toBe(bob.id);
    expect(await db.revisions.count()).toBe(1);
    expect(await db.outbox.count()).toBe(1);

    await activateUserDatabase(alice.id);
    const aliceEntries = await listLocalEntries();
    expect(aliceEntries).toHaveLength(2);
    expect(aliceEntries.every((entry) => entry.author_id === alice.id)).toBe(true);

    // Device identity is shared by the installation, not by the account.
    expect(await getDeviceId()).toBe(deviceId);
    expect(await getInstallId()).toBe(installId);
    const databases = await listUserDatabases();
    expect(databases).toEqual(
      expect.arrayContaining([
        userDatabaseName(alice.id),
        userDatabaseName(bob.id),
      ]),
    );
  });

  it('lock keeps local data, logout deletes the user database', async () => {
    await activateUserDatabase(alice.id);
    await createLocalEntry(input, alice);
    const name = userDatabaseName(alice.id);
    expect(await Dexie.exists(name)).toBe(true);

    // ADR-10: lock closes the database but keeps every local row.
    await closeActiveDatabase();
    expect(await Dexie.exists(name)).toBe(true);
    expect(await activeUserId()).toBeNull();
    await activateUserDatabase(alice.id);
    expect(await listLocalEntries()).toHaveLength(1);

    // Explicit logout with cleanup removes the whole per-user store.
    await deleteUserDatabase(alice.id);
    expect(await Dexie.exists(name)).toBe(false);
  });

  it('clears every user-scoped store on logout but keeps the device identity', async () => {
    const deviceId = await getDeviceId();
    await activateUserDatabase(alice.id);
    await createLocalEntry(input, alice);
    const review: JournalReview = {
      id: '01930000-0000-7000-8000-000000000999',
      journal_id: DEFAULT_JOURNAL_ID,
      journal_key: 'main',
      period_start: '2026-11-01',
      period_end: '2026-11-30',
      reviewer_id: bob.id,
      reviewed_at: '2026-11-30T10:00:00.000Z',
      entries_count: 1,
      remarks: null,
      content_hash: 'a'.repeat(64),
    };
    const journal: Journal = {
      id: DEFAULT_JOURNAL_ID,
      journal_key: 'main',
      name: 'Основной журнал',
      description: null,
      active: true,
      sort_order: 10,
    };
    await db.journal_reviews.put(review);
    await db.journals.put(journal);
    await db.meta.put({ key: 'snapshot_id', value: 'ds_test' });
    await db.supervisor_cache.put({
      journal_id: DEFAULT_JOURNAL_ID,
      user_id: bob.id,
      window_from: '2026-11-17T00:00:00.000Z',
      window_to: '2026-11-24T00:00:00.000Z',
      entries: 1,
      bytes: 100,
      updated_at: '2026-11-24T00:00:00.000Z',
    });
    await db.shifts.put({
      id: '01930000-0000-7000-8000-000000000888',
      journal_id: DEFAULT_JOURNAL_ID,
      shift_date: '2026-11-24',
      period_start: '2026-11-24T08:00:00.000Z',
      period_end: '2026-11-24T20:00:00.000Z',
      status: 'handed_over',
      handed_over_by: alice.id,
      handed_over_at: '2026-11-24T20:00:00.000Z',
      handover_comment: 'Смена сдана',
      accepted_by: null,
      accepted_at: null,
      acceptance_comment: null,
      rejected_by: null,
      rejected_at: null,
      rejection_reason: null,
      entries_count: 1,
      entries_hash: 'b'.repeat(64),
      content_hash: 'c'.repeat(64),
      version: 1,
      hlc: SEED_HLC.entry1,
      created_at_client: '2026-11-24T20:00:00.000Z',
      created_at_server: null,
      updated_at_client: '2026-11-24T20:00:00.000Z',
      updated_at_server: null,
      device_id: null,
      last_op_id: null,
    });

    await clearLocalUserData();

    for (const table of db.tables) {
      expect(await table.count()).toBe(0);
    }
    // Device identity is not user data and survives the cleanup.
    expect(await getDeviceId()).toBe(deviceId);
  });

  it('adopts a legacy shared database per account and deletes it when empty', async () => {
    const legacy = new LogbookDatabase(LEGACY_DB_NAME);
    await legacy.open();
    await legacy.entries.bulkPut([
      legacyEntry(
        '01930000-0000-7000-8000-000000000201',
        alice.id,
        'Запись Алисы',
      ),
      legacyEntry(
        '01930000-0000-7000-8000-000000000202',
        bob.id,
        'Запись Боба',
      ),
    ] as never);
    await legacy.outbox.bulkPut([
      {
        op_id: '01930000-0000-7000-8000-000000000301',
        user_id: alice.id,
        device_id: SEED_UUIDS.deviceWorker,
        entity_type: 'entry',
        entity_id: '01930000-0000-7000-8000-000000000201',
        op_type: 'create',
        payload: { text: 'Запись Алисы' },
        field_clocks: {},
        base_version: null,
        hlc: SEED_HLC.entry1,
        created_at: '2026-11-20T08:05:00.000Z',
        attempts: 0,
        next_attempt_at: null,
        last_error_code: null,
        last_error_message: null,
        status: 'pending',
        sent_at: null,
        ack_at: null,
      },
    ]);
    await legacy.meta.bulkPut([
      { key: 'device_id', value: 'legacy-device-id' },
      { key: 'install_id', value: 'legacy-install-id' },
      { key: 'device_key:legacy-device-id', value: 'legacy-device-key' },
      { key: 'hlc_last', value: SEED_HLC.entry1 },
      { key: 'snapshot_id', value: 'ds_legacy' },
    ]);
    await legacy.close();
    expect(await Dexie.exists(LEGACY_DB_NAME)).toBe(true);

    const aliceActivation = await activateUserDatabase(alice.id);

    expect(aliceActivation.adoption?.adopted).toBe(true);
    expect(aliceActivation.adoption?.remaining_rows).toBeGreaterThan(0);
    expect(aliceActivation.adoption?.stores.entries).toBe(1);
    expect(await listLocalEntries()).toHaveLength(1);
    expect((await listLocalEntries())[0]?.text).toBe('Запись Алисы');
    expect(await db.outbox.count()).toBe(1);
    expect(await getDeviceId()).toBe('legacy-device-id');
    expect(await getInstallId()).toBe('legacy-install-id');
    expect(await getDeviceMeta('device_key:legacy-device-id')).toBe(
      'legacy-device-key',
    );
    expect(await getDeviceMeta('snapshot_id')).toBeNull();
    // Bob's rows remain, so the legacy database is kept for his first login.
    expect(await Dexie.exists(LEGACY_DB_NAME)).toBe(true);

    const bobActivation = await activateUserDatabase(bob.id);

    expect(bobActivation.adoption?.remaining_rows).toBe(0);
    expect(await listLocalEntries()).toHaveLength(1);
    expect((await listLocalEntries())[0]?.text).toBe('Запись Боба');
    expect(bobActivation.adoption?.snapshot).not.toBeNull();
    expect(
      await Dexie.exists(String(bobActivation.adoption?.snapshot)),
    ).toBe(true);
    // Fully adopted: the shared legacy database is gone.
    expect(await Dexie.exists(LEGACY_DB_NAME)).toBe(false);
    expect(await getDeviceMeta(`legacy_adopted:${bob.id}`)).toContain(
      '"adopted":true',
    );
  });
});
