import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_JOURNAL_ID,
  SEED_UUIDS,
  type OutboxOperation,
} from '@logbook/shared';
import type { ApiUser } from '../api/types';
import type { SnapshotResponse } from '../api/types';
import {
  applyChanges,
  applyJournalReviews,
  applySnapshot,
  createLocalEntry,
  createPermitScan,
  deleteLocalEntry,
  getLocalEntry,
  listLocalEntries,
  listLocalJournals,
  listLocalReviews,
  allOperations,
  updateLocalEntry,
} from './repositories';
import { db } from './schema';

const user: ApiUser = {
  id: '01930000-0000-7000-8000-000000000101',
  full_name: 'Иван Петров',
  role: 'worker',
  department: { id: '01930000-0000-7000-8000-000000000001', name: 'Участок' },
  status: 'active',
  email: 'worker@logbook.local',
};

const input = {
  performed_at: '2026-11-24T08:00:00.000Z',
  performed_tz_offset_min: 480,
  work_type_id: '01930000-0000-7000-8000-000000000302',
  site_id: '01930000-0000-7000-8000-000000000402',
  permit_id: null,
  text: 'Проверил оборудование на участке',
  input_method: 'manual' as const,
};

beforeEach(async () => {
  for (const table of db.tables) {
    await table.clear();
  }
});

describe('local entry repository', () => {
  it('creates an entry, revision and create operation in one transaction', async () => {
    const entry = await createLocalEntry(input, user);

    expect(entry.sync_status).toBe('pending');
    expect(entry.field_clocks?.text).toBe(entry.hlc);
    expect(entry.event_type).toBe('work');
    expect(entry.journal_seq).toBeNull();
    expect(entry.journal_id).toBe(DEFAULT_JOURNAL_ID);
    expect(await db.entries.count()).toBe(1);
    expect(await db.revisions.count()).toBe(1);

    const operations = await db.outbox.toArray();
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      op_type: 'create',
      base_version: null,
      status: 'pending',
      entity_id: entry.id,
    });
    expect(operations[0]?.payload.journal_id).toBe(DEFAULT_JOURNAL_ID);
  });

  it('creates entries in a selected journal and filters by journal', async () => {
    const mainEntry = await createLocalEntry(input, user);
    const substationEntry = await createLocalEntry(
      { ...input, journal_id: SEED_UUIDS.journalSubstation },
      user,
    );

    expect(mainEntry.journal_id).toBe(DEFAULT_JOURNAL_ID);
    expect(substationEntry.journal_id).toBe(SEED_UUIDS.journalSubstation);

    const mainOnly = await listLocalEntries({ journal_id: DEFAULT_JOURNAL_ID });
    expect(mainOnly.map((row) => row.id)).toEqual([mainEntry.id]);
    const substationOnly = await listLocalEntries({
      journal_id: SEED_UUIDS.journalSubstation,
    });
    expect(substationOnly.map((row) => row.id)).toEqual([substationEntry.id]);
    expect(await listLocalEntries()).toHaveLength(2);
  });

  it('moves an unsynced entry between journals but keeps a synced entry', async () => {
    const entry = await createLocalEntry(input, user);
    const moved = await updateLocalEntry(
      entry.id,
      { journal_id: SEED_UUIDS.journalSubstation },
      user,
    );
    expect(moved.journal_id).toBe(SEED_UUIDS.journalSubstation);
    const operations = await db.outbox.toArray();
    expect(operations[0]?.payload.journal_id).toBe(SEED_UUIDS.journalSubstation);

    // Once the entry reached the server the journal is immutable client-side.
    await db.outbox.clear();
    await db.entries.put({
      ...moved,
      journal_id: SEED_UUIDS.journalSubstation,
      sync_status: 'synced',
      version: 2,
    });
    const unchanged = await updateLocalEntry(
      entry.id,
      { journal_id: DEFAULT_JOURNAL_ID },
      user,
    );
    expect(unchanged.journal_id).toBe(SEED_UUIDS.journalSubstation);
  });

  it('falls back to the built-in main journal until a snapshot is cached', async () => {
    const journals = await listLocalJournals();
    expect(journals).toHaveLength(1);
    expect(journals[0]?.id).toBe(DEFAULT_JOURNAL_ID);
  });

  it('coalesces edits of an unsynced entry into the create operation', async () => {
    const entry = await createLocalEntry(input, user);
    const updated = await updateLocalEntry(
      entry.id,
      { text: 'Уточнённый текст записи после проверки' },
      user,
    );

    const operations = await db.outbox.toArray();
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op_type).toBe('create');
    expect(operations[0]?.payload.text).toBe(
      'Уточнённый текст записи после проверки',
    );
    expect(updated.revision_no).toBe(1);

    const stored = await getLocalEntry(entry.id);
    expect(stored.entry?.text).toContain('Уточнённый');
    expect(stored.revisions).toHaveLength(2);
  });

  it('creates an update operation against the server version', async () => {
    const entry = await createLocalEntry(input, user);
    const operations = await db.outbox.toArray();
    await db.outbox.delete(operations[0]!.op_id);
    await db.entries.put({
      ...entry,
      sync_status: 'synced',
      version: 3,
    });

    await updateLocalEntry(entry.id, { comment: 'Комментарий' }, user);
    const nextOperations = await db.outbox.toArray();
    expect(nextOperations).toHaveLength(1);
    expect(nextOperations[0]).toMatchObject({
      op_type: 'update',
      base_version: 3,
    });
    expect(nextOperations[0]?.payload.comment).toBe('Комментарий');
  });

  it('removes an unsynced entry and its outbox operation', async () => {
    const entry = await createLocalEntry(input, user);
    await deleteLocalEntry(entry.id, user);

    expect(await db.entries.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
    expect(await db.revisions.count()).toBe(0);
  });

  it('applies server changes and removes tombstones', async () => {
    const entry = await createLocalEntry(input, user);
    await db.outbox.clear();

    const serverEntry = {
      ...entry,
      text: 'Текст с сервера',
      version: 4,
      sync_status: 'synced' as const,
      field_clocks: undefined,
    };
    await applyChanges([
      {
        seq: 1,
        entity_type: 'entry',
        op: 'upsert',
        entity: serverEntry as unknown as Record<string, unknown>,
      },
    ]);

    const afterUpsert = await listLocalEntries();
    expect(afterUpsert[0]?.text).toBe('Текст с сервера');

    await applyChanges([
      {
        seq: 2,
        entity_type: 'entry',
        op: 'delete',
        entity_id: entry.id,
      },
    ]);
    expect(await db.entries.get(entry.id)).toBeUndefined();
  });

  it('records a pending conflict when a change races a local outbox op', async () => {
    const entry = await createLocalEntry(input, user);
    const serverEntry = {
      ...entry,
      text: 'Текст, пришедший с сервера',
      version: 2,
      sync_status: 'synced' as const,
      field_clocks: undefined,
    };

    await applyChanges([
      {
        seq: 3,
        entity_type: 'entry',
        op: 'upsert',
        entity: serverEntry as unknown as Record<string, unknown>,
      },
    ]);

    const stored = await db.entries.get(entry.id);
    expect(stored?.sync_status).toBe('conflict');
    const conflicts = await db.conflicts.toArray();
    expect(conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entry_id: entry.id,
          field: 'text',
          resolution: 'pending',
          local_value: input.text,
          remote_value: 'Текст, пришедший с сервера',
        }),
      ]),
    );
  });

  it('applies dictionary snapshots including templates', async () => {
    const snapshot: SnapshotResponse = {
      snapshot_id: 'ds_test',
      work_types: { version: 1, items: [] },
      sites: { version: 1, items: [] },
      templates: {
        version: 2,
        items: [
          {
            id: '01930000-0000-7000-8000-000000000501',
            work_type_id: '01930000-0000-7000-8000-000000000301',
            text: 'Шаблонный текст для записи журнала',
            tags: ['наряд'],
            sort_order: 1,
            active: true,
          },
        ],
      },
      reasons: { version: 1, items: [] },
      departments: { version: 1, items: [] },
      journals: {
        version: 1,
        items: [
          {
            id: SEED_UUIDS.journalSubstation,
            journal_key: 'substation',
            name: 'Журнал подстанции',
            description: null,
            active: true,
            sort_order: 20,
          },
        ],
      },
    };

    await applySnapshot(snapshot);

    expect(
      (await db.dict_templates.get('01930000-0000-7000-8000-000000000501'))?.text,
    ).toBe('Шаблонный текст для записи журнала');
    expect((await db.journals.get(SEED_UUIDS.journalSubstation))?.name).toBe(
      'Журнал подстанции',
    );
  });

  it('stores journal reviews in the v2 schema', async () => {
    await applyJournalReviews([
      {
        id: '01930000-0000-7000-8000-000000000999',
        journal_key: 'main',
        period_start: '2026-11-01',
        period_end: '2026-11-30',
        reviewer_id: user.id,
        reviewed_at: '2026-11-30T10:00:00.000Z',
        entries_count: 5,
        remarks: 'Замечаний нет',
        content_hash: 'a'.repeat(64),
      },
    ]);

    const reviews = await listLocalReviews();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.entries_count).toBe(5);
  });
  it('creates one offline permit scan and queues its upload', async () => {
    const entry = await createLocalEntry(input, user);
    const pdf = new Blob(['%PDF-1.4\n%%EOF\n'], { type: 'application/pdf' });
    const attachment = await createPermitScan(
      entry.id,
      pdf,
      2,
      'a'.repeat(64),
      user,
    );
    expect(attachment.status).toBe('local');
    expect(await db.attachments.count()).toBe(1);
    const operation = (await db.outbox.toArray()).find(
      (row) => row.entity_type === 'attachment',
    );
    expect(operation?.payload).toMatchObject({ pages: 2, entry_id: entry.id });

    await expect(
      createPermitScan(entry.id, pdf, 2, 'b'.repeat(64), user),
    ).rejects.toThrow('уже есть скан');
  });
});

describe('outbox queue for S-10', () => {
  function operation(
    opId: string,
    createdAt: string,
    status: OutboxOperation['status'],
  ): OutboxOperation {
    return {
      op_id: opId,
      user_id: user.id,
      device_id: SEED_UUIDS.deviceWorker,
      entity_type: 'entry',
      entity_id: SEED_UUIDS.entry1,
      op_type: 'create',
      payload: { text: 'Запись из очереди' },
      field_clocks: {},
      base_version: null,
      hlc: '1795000000200:00001:test0001',
      created_at: createdAt,
      attempts: 0,
      next_attempt_at: null,
      last_error_code: null,
      last_error_message: null,
      status,
      sent_at: null,
      ack_at: null,
    };
  }

  it('returns the whole queue sorted by created_at without a created_at index', async () => {
    // Regression: orderBy('created_at') threw SchemaError (no index) and /sync
    // rendered a white screen. The queue must load and keep creation order.
    await db.outbox.bulkPut([
      operation('op-3', '2026-11-24T10:00:00.000Z', 'dead'),
      operation('op-1', '2026-11-24T08:00:00.000Z', 'pending'),
      operation('op-2', '2026-11-24T09:00:00.000Z', 'in_flight'),
    ]);

    const rows = await allOperations();

    expect(rows.map((row) => row.op_id)).toEqual(['op-1', 'op-2', 'op-3']);
    expect(rows.map((row) => row.status)).toEqual(['pending', 'in_flight', 'dead']);
  });

  it('returns an empty queue without throwing', async () => {
    await expect(allOperations()).resolves.toEqual([]);
  });
});