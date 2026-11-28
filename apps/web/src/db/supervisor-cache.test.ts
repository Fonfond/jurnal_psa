import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_JOURNAL_ID,
  SEED_HLC,
  SEED_UUIDS,
  type Journal,
  type JournalEntry,
  type JournalReview,
} from '@logbook/shared';
import type { ApiUser } from '../api/types';
import { applyServerEntry, createLocalEntry } from './repositories';
import { db } from './schema';
import { activateUserDatabase } from './user-db';
import {
  SUPERVISOR_CACHE_BUDGET_BYTES,
  SUPERVISOR_CACHE_DAYS,
  cacheWindow,
  evictJournalCache,
  readSupervisorCacheStatus,
  refreshSupervisorCache,
  supervisorCacheEnabled,
  type SupervisorCacheApi,
} from './supervisor-cache';

const supervisor: ApiUser = {
  id: '01930000-0000-7000-8000-000000000901',
  full_name: 'Пётр Смирнов',
  role: 'supervisor',
  department: { id: '01930000-0000-7000-8000-000000000001', name: 'Участок' },
  status: 'active',
  email: 'supervisor@logbook.local',
};

const worker: ApiUser = {
  id: SEED_UUIDS.worker,
  full_name: 'Иван Петров',
  role: 'worker',
  department: { id: '01930000-0000-7000-8000-000000000001', name: 'Участок' },
  status: 'active',
  email: 'worker@logbook.local',
};

const NOW = Date.parse('2026-11-24T12:00:00.000Z');

function journal(id: string, key: string, order: number): Journal {
  return {
    id,
    journal_key: key,
    name: key,
    description: null,
    active: true,
    sort_order: order,
  };
}

function makeEntry(
  id: string,
  journalId: string,
  performedAt: string,
  authorId: string = SEED_UUIDS.worker,
  text = 'Запись подразделения',
): JournalEntry {
  return {
    id,
    author_id: authorId,
    performed_at: performedAt,
    performed_tz_offset_min: 180,
    performed_at_source: 'device_auto',
    performed_at_reason_id: null,
    performed_at_comment: null,
    shift_date: null,
    work_type_id: SEED_UUIDS.workTypePermit,
    site_id: SEED_UUIDS.siteWorkshop,
    site_name_raw: null,
    site_binding_status: 'linked',
    permit_id: null,
    permit_number_raw: null,
    permit_binding_status: 'not_required',
    permit_status_at_sync: null,
    permit_risk_flag: false,
    permit_risk_reason: null,
    text,
    comment: null,
    input_method: 'manual',
    asr_engine: null,
    asr_confidence: null,
    offline_created: false,
    status: 'active',
    sync_status: 'synced',
    version: 1,
    hlc: SEED_HLC.entry1,
    created_at_client: performedAt,
    created_at_server: performedAt,
    updated_at_client: performedAt,
    updated_at_server: performedAt,
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
    journal_id: journalId,
    journal_seq: 1,
  };
}

function makeApi(): SupervisorCacheApi & {
  entries: ReturnType<typeof vi.fn>;
  reviews: ReturnType<typeof vi.fn>;
} {
  const entries = vi.fn(async (params: {
    journal_id?: string;
    cursor?: string;
  }) => {
    if (params.cursor) {
      return { items: [], next_cursor: null, has_more: false };
    }
    if (params.journal_id === DEFAULT_JOURNAL_ID) {
      return {
        items: [
          makeEntry(
            '01930000-0000-7000-8000-000000001001',
            DEFAULT_JOURNAL_ID,
            '2026-11-24T08:00:00.000Z',
          ),
          makeEntry(
            '01930000-0000-7000-8000-000000001002',
            DEFAULT_JOURNAL_ID,
            '2026-10-01T08:00:00.000Z',
            SEED_UUIDS.worker,
            'Старая запись вне окна кэша',
          ),
        ],
        next_cursor: 'next',
        has_more: true,
      };
    }
    return {
      items: [
        makeEntry(
          '01930000-0000-7000-8000-000000001003',
          SEED_UUIDS.journalSubstation,
          '2026-11-23T08:00:00.000Z',
        ),
      ],
      next_cursor: null,
      has_more: false,
    };
  });
  const reviews = vi.fn(async (params: { journal_id?: string }) => ({
    items:
      params.journal_id === DEFAULT_JOURNAL_ID
        ? [
            {
              id: '01930000-0000-7000-8000-000000001100',
              journal_id: DEFAULT_JOURNAL_ID,
              journal_key: 'main',
              period_start: '2026-11-01',
              period_end: '2026-11-30',
              reviewer_id: supervisor.id,
              reviewed_at: '2026-11-24T10:00:00.000Z',
              entries_count: 2,
              remarks: null,
              content_hash: 'd'.repeat(64),
            } satisfies JournalReview,
          ]
        : [],
  }));
  return { entries, reviews } as SupervisorCacheApi & {
    entries: ReturnType<typeof vi.fn>;
    reviews: ReturnType<typeof vi.fn>;
  };
}

async function prepareUserDatabases(): Promise<void> {
  await activateUserDatabase(supervisor.id);
  await db.journals.bulkPut([
    journal(DEFAULT_JOURNAL_ID, 'main', 10),
    journal(SEED_UUIDS.journalSubstation, 'substation', 20),
  ]);
}

describe('supervisor cache (ADR-16/SYN-02)', () => {
  it('is only enabled for supervisor and admin roles', () => {
    expect(supervisorCacheEnabled({ id: supervisor.id, role: 'supervisor' })).toBe(
      true,
    );
    expect(supervisorCacheEnabled({ id: supervisor.id, role: 'admin' })).toBe(true);
    expect(supervisorCacheEnabled({ id: worker.id, role: 'worker' })).toBe(false);
    expect(supervisorCacheEnabled({ id: worker.id, role: 'auditor' })).toBe(false);
    expect(supervisorCacheEnabled(null)).toBe(false);
    // The server feature flag can disable the cache for every role.
    expect(
      supervisorCacheEnabled({ id: supervisor.id, role: 'supervisor' }, false),
    ).toBe(false);
  });

  it('uses a seven-day window', () => {
    const window = cacheWindow(NOW);
    expect(SUPERVISOR_CACHE_DAYS).toBe(7);
    expect(window.from).toBe('2026-11-17T12:00:00.000Z');
    expect(window.to).toBe('2026-11-24T12:00:00.000Z');
    expect(window.fromDate).toBe('2026-11-17');
  });

  it('returns disabled for a worker without touching the API', async () => {
    await prepareUserDatabases();
    const api = makeApi();
    const status = await refreshSupervisorCache({
      api,
      user: { id: worker.id, role: 'worker' },
      now: () => NOW,
    });
    expect(status.enabled).toBe(false);
    expect(status.reason).toBe('disabled');
    expect(api.entries).not.toHaveBeenCalled();
  });

  it('caches the last seven days per journal and stores reviews', async () => {
    await prepareUserDatabases();
    const api = makeApi();

    const status = await refreshSupervisorCache({
      api,
      user: { id: supervisor.id, role: 'supervisor' },
      now: () => NOW,
    });

    expect(status.enabled).toBe(true);
    expect(status.refreshed).toBe(true);
    expect(status.reason).toBe('ok');
    expect(status.entries).toBe(2);
    expect(status.journals).toHaveLength(2);
    expect(status.window_days).toBe(7);
    expect(status.budget_bytes).toBe(SUPERVISOR_CACHE_BUDGET_BYTES);
    // The seven-day window is sent to the API.
    expect(api.entries).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '2026-11-17T12:00:00.000Z',
        to: '2026-11-24T12:00:00.000Z',
        limit: 100,
      }),
    );
    expect(api.entries).toHaveBeenCalledWith(
      expect.objectContaining({ journal_id: SEED_UUIDS.journalSubstation }),
    );

    const cached = await db.entries.toArray();
    expect(cached.map((entry) => entry.id).sort()).toEqual([
      '01930000-0000-7000-8000-000000001001',
      '01930000-0000-7000-8000-000000001003',
    ]);
    // Out-of-window rows are not cached.
    expect(
      cached.some((entry) => entry.id === '01930000-0000-7000-8000-000000001002'),
    ).toBe(false);
    expect(await db.journal_reviews.count()).toBe(1);
    expect(await db.supervisor_cache.count()).toBe(2);
    const stored = await readSupervisorCacheStatus(NOW);
    expect(stored.entries).toBe(2);
    expect(stored.journals.find((row) => row.journal_id === DEFAULT_JOURNAL_ID))
      .toMatchObject({ reviews: 1, entries: 1 });
  });

  it('throttles refreshes for six hours unless forced', async () => {
    await prepareUserDatabases();
    const api = makeApi();
    await refreshSupervisorCache({
      api,
      user: { id: supervisor.id, role: 'supervisor' },
      now: () => NOW,
    });

    const throttled = await refreshSupervisorCache({
      api,
      user: { id: supervisor.id, role: 'supervisor' },
      now: () => NOW + 60 * 60 * 1000,
    });
    expect(throttled.refreshed).toBe(false);
    expect(throttled.reason).toBe('throttled');

    const forced = await refreshSupervisorCache({
      api,
      user: { id: supervisor.id, role: 'supervisor' },
      now: () => NOW + 60 * 60 * 1000,
      force: true,
    });
    expect(forced.refreshed).toBe(true);
  });

  it('never overwrites a locally pending entry with the cached copy', async () => {
    await prepareUserDatabases();
    const local = await createLocalEntry(
      {
        performed_at: '2026-11-24T08:00:00.000Z',
        performed_tz_offset_min: 480,
        work_type_id: SEED_UUIDS.workTypePermit,
        site_id: SEED_UUIDS.siteWorkshop,
        permit_id: null,
        text: 'Локальная правка',
        input_method: 'manual',
      },
      supervisor,
    );
    const api = makeApi();
    api.entries.mockImplementation(async (params: { journal_id?: string }) => {
      if (params.journal_id !== DEFAULT_JOURNAL_ID) {
        return { items: [], next_cursor: null, has_more: false };
      }
      return {
        items: [makeEntry(local.id, DEFAULT_JOURNAL_ID, local.performed_at, supervisor.id, 'Версия сервера')],
        next_cursor: null,
        has_more: false,
      };
    });

    await refreshSupervisorCache({
      api,
      user: { id: supervisor.id, role: 'supervisor' },
      now: () => NOW,
      force: true,
    });

    const stored = await db.entries.get(local.id);
    expect(stored?.text).toBe('Локальная правка');
    expect(stored?.sync_status).toBe('pending');
  });

  it('evicts cached remote entries outside the window or over budget', async () => {
    await prepareUserDatabases();
    await applyServerEntry(
      makeEntry(
        '01930000-0000-7000-8000-000000002001',
        DEFAULT_JOURNAL_ID,
        '2026-11-24T09:00:00.000Z',
      ),
    );
    await applyServerEntry(
      makeEntry(
        '01930000-0000-7000-8000-000000002002',
        DEFAULT_JOURNAL_ID,
        '2026-11-24T10:00:00.000Z',
      ),
    );
    // The supervisor's own entry is local working data and must stay.
    await applyServerEntry(
      makeEntry(
        '01930000-0000-7000-8000-000000002003',
        DEFAULT_JOURNAL_ID,
        '2026-11-24T11:00:00.000Z',
        supervisor.id,
      ),
    );

    const removed = await evictJournalCache(
      DEFAULT_JOURNAL_ID,
      supervisor.id,
      '2026-11-17T00:00:00.000Z',
      0,
    );
    expect(removed).toBe(2);
    expect(await db.entries.get('01930000-0000-7000-8000-000000002001')).toBe(
      undefined,
    );
    expect(await db.entries.get('01930000-0000-7000-8000-000000002003')).not.toBe(
      undefined,
    );
  });
});
