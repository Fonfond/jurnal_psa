import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_JOURNAL_ID,
  SEED_UUIDS,
  SEED_HLC,
  type JournalEntry,
  type OutboxOperation,
} from '@logbook/shared';
import { LogbookDatabase } from './schema';

let database: LogbookDatabase;

afterEach(async () => {
  if (database) {
    await database.delete();
  }
});

function entry(): JournalEntry {
  return {
    id: SEED_UUIDS.entry1,
    author_id: SEED_UUIDS.worker,
    performed_at: '2026-11-20T08:00:00.000Z',
    performed_tz_offset_min: 180,
    performed_at_source: 'device_auto',
    performed_at_reason_id: null,
    performed_at_comment: null,
    shift_date: null,
    work_type_id: SEED_UUIDS.workTypePermit,
    site_id: SEED_UUIDS.siteWorkshop,
    permit_id: SEED_UUIDS.permitActive,
    permit_number_raw: null,
    permit_binding_status: 'linked',
    permit_status_at_sync: 'active',
    permit_risk_flag: false,
    permit_risk_reason: null,
    text: 'Заменён участок трубопровода на третьем стояке',
    comment: null,
    input_method: 'manual',
    asr_engine: null,
    asr_confidence: null,
    offline_created: false,
    status: 'active',
    sync_status: 'pending',
    version: 1,
    hlc: SEED_HLC.entry1,
    created_at_client: '2026-11-20T08:05:00.000Z',
    created_at_server: null,
    updated_at_client: '2026-11-20T08:05:00.000Z',
    updated_at_server: null,
    deleted_at: null,
    deleted_by: null,
    delete_reason_id: null,
    device_id: SEED_UUIDS.deviceWorker,
    revision_no: 0,
    last_op_id: null,
    verified_at: null,
    verified_by: null,
    unverified_at: null,
    unverified_by: null,
  };
}

function operation(): OutboxOperation {
  return {
    op_id: SEED_UUIDS.entry1,
    user_id: SEED_UUIDS.worker,
    device_id: SEED_UUIDS.deviceWorker,
    entity_type: 'entry',
    entity_id: SEED_UUIDS.entry1,
    op_type: 'create',
    payload: { text: 'x' },
    field_clocks: { text: SEED_HLC.entry1 },
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
  };
}

describe('Dexie schema', () => {
  it('opens the database and creates all stores', async () => {
    database = new LogbookDatabase('logbook-test');
    await database.open();

    expect(database.verno).toBe(5);
    const tables = database.tables.map((table) => table.name).sort();
    expect(tables).toEqual(
      [
        'conflicts',
        'dict_departments',
        'dict_reasons',
        'dict_sites',
        'dict_templates',
        'dict_work_types',
        'drafts',
        'entries',
        'entry_workers',
        'groundings',
        'journal_reviews',
        'journals',
        'meta',
        'outbox',
        'permits',
        'revisions',
        'shifts',
        'supervisor_cache',
        'sync_state',
      ].sort(),
    );
  });

  it('stores an entry and an outbox operation atomically', async () => {
    database = new LogbookDatabase('logbook-test');
    await database.open();

    await database.transaction('rw', database.entries, database.outbox, async () => {
      await database.entries.put(entry());
      await database.outbox.put(operation());
    });

    const stored = await database.entries.get(SEED_UUIDS.entry1);
    expect(stored?.text).toContain('трубопровода');
    expect(stored?.sync_status).toBe('pending');

    const pending = await database.outbox
      .where('status')
      .equals('pending')
      .toArray();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.op_id).toBe(SEED_UUIDS.entry1);
  });

  it('filters by index and keeps meta values', async () => {
    database = new LogbookDatabase('logbook-test');
    await database.open();

    await database.entries.put(entry());
    await database.meta.put({ key: 'schema_version', value: '1' });

    const byAuthor = await database.entries
      .where('author_id')
      .equals(SEED_UUIDS.worker)
      .count();
    expect(byAuthor).toBe(1);

    const meta = await database.meta.get('schema_version');
    expect(meta?.value).toBe('1');
  });

  it('indexes entries by journal_id', async () => {
    database = new LogbookDatabase('logbook-test');
    await database.open();

    await database.entries.bulkPut([
      { ...entry(), journal_id: DEFAULT_JOURNAL_ID },
      {
        ...entry(),
        id: SEED_UUIDS.entry2,
        journal_id: SEED_UUIDS.journalSubstation,
      },
    ]);

    const substation = await database.entries
      .where('journal_id')
      .equals(SEED_UUIDS.journalSubstation)
      .toArray();
    expect(substation.map((row) => row.id)).toEqual([SEED_UUIDS.entry2]);
  });

  it('upgrades a v2 offline cache and attaches old rows to the main journal', async () => {    const legacy = new Dexie('logbook-upgrade-test');
    legacy.version(2).stores({
      entries: 'id, author_id, performed_at, permit_id, sync_status, status, event_type',
      journal_reviews: 'id, period_start, period_end, reviewer_id, journal_key',
    });
    await legacy.open();
    await legacy.table('entries').put(entry());
    await legacy.table('journal_reviews').put({
      id: '01930000-0000-7000-8000-000000000999',
      journal_key: 'main',
      period_start: '2026-11-01',
      period_end: '2026-11-30',
      reviewer_id: SEED_UUIDS.supervisor,
      reviewed_at: '2026-11-30T10:00:00.000Z',
      entries_count: 1,
      remarks: null,
      content_hash: 'a'.repeat(64),
    });
    legacy.close();

    database = new LogbookDatabase('logbook-upgrade-test');
    await database.open();

    expect(database.verno).toBe(5);
    const stored = await database.entries.get(SEED_UUIDS.entry1);
    expect(stored?.journal_id).toBe(DEFAULT_JOURNAL_ID);
    expect(stored?.text).toContain('трубопровода');
    const review = await database.journal_reviews.get(
      '01930000-0000-7000-8000-000000000999',
    );
    expect(review?.journal_id).toBe(DEFAULT_JOURNAL_ID);
  });
});
