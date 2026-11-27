import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SEED_UUIDS,
  type ConflictRecord,
  type JournalEntry,
  type SyncPushOp,
  type SyncPushRequest,
} from '@logbook/shared';
import { ApiError } from '../api/client';
import type { ApiUser } from '../api/types';
import {
  createLocalEntry,
  failOperation,
  getLocalEntry,
  getSyncCursor,
} from '../db/repositories';
import { db } from '../db/schema';
import type { SyncApi } from './engine';
import { SyncEngine } from './engine';
import { backoffDelayMs } from './backoff';

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

const snapshot = {
  snapshot_id: 'ds_test',
  work_types: { version: 1, items: [] },
  sites: { version: 1, items: [] },
  templates: { version: 1, items: [] },
  reasons: { version: 1, items: [] },
  departments: { version: 1, items: [] },
};

function makeApi(overrides: Partial<SyncApi> = {}): SyncApi {
  return {
    devices: vi.fn(async () => ({
      items: [
        {
          id: '01930000-0000-7000-8000-000000000201',
          name: 'Test device',
          platform: 'web',
          app_version: '0.2.0',
          status: 'active',
        },
      ],
    })),
    registerDevice: vi.fn(async () => ({
      device: {
        id: '01930000-0000-7000-8000-000000000201',
        install_id: 'install-test-1',
        name: 'Test device',
        platform: 'web',
        app_version: '0.2.0',
        status: 'active' as const,
      },
      device_key: 'device-key-test',
    })),
    entries: vi.fn(async () => ({ items: [], next_cursor: null, has_more: false })),
    snapshot: vi.fn(async () => snapshot),
    permits: vi.fn(async () => ({ items: [], next_cursor: null })),
    changes: vi.fn(async () => ({ next_seq: 0, has_more: false, changes: [] })),
    push: vi.fn(async () => ({ server_time: new Date().toISOString(), results: [] })),
    ...overrides,
  };
}

function merged(entry: JournalEntry): JournalEntry {
  return {
    ...entry,
    version: 1,
    sync_status: 'synced',
    created_at_server: new Date().toISOString(),
    updated_at_server: new Date().toISOString(),
  };
}

beforeEach(async () => {
  for (const table of db.tables) {
    await table.clear();
  }
});

describe('SyncEngine', () => {
  it('pushes an operation, applies the merged entry and clears the outbox', async () => {
    const local = await createLocalEntry(input, user);
    const apiMock = makeApi({
      push: vi.fn(async (request: SyncPushRequest) => ({
        server_time: new Date().toISOString(),
        results: request.ops.map((op: SyncPushOp) => ({
          op_id: op.op_id,
          status: 'applied' as const,
          version: 1,
          duplicate: false,
          merged_entry: merged(local as unknown as JournalEntry),
          resolution: null,
          conflicts: null,
          error: null,
        })),
      })),
    });
    const engine = new SyncEngine({
      apiClient: apiMock,
      online: () => true,
    });

    const summary = await engine.syncNow();

    expect(summary.status).toBe('ok');
    expect(summary.pushed).toBe(1);
    expect(await db.outbox.count()).toBe(0);
    const stored = await db.entries.get(local.id);
    expect(stored?.sync_status).toBe('synced');
    expect(stored?.version).toBe(1);
    expect(apiMock.push).toHaveBeenCalledTimes(1);
    const request = (apiMock.push as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]?.[0] as { device_id: string; ops: unknown[] };
    expect(request.device_id).toBe('01930000-0000-7000-8000-000000000201');
    expect(request.ops).toHaveLength(1);
  });

  it('treats duplicate=true as a successful acknowledgement', async () => {
    const local = await createLocalEntry(input, user);
    const apiMock = makeApi({
      push: vi.fn(async (request: SyncPushRequest) => ({
        server_time: new Date().toISOString(),
        results: request.ops.map((op: SyncPushOp) => ({
          op_id: op.op_id,
          status: 'applied' as const,
          version: 1,
          duplicate: true,
          merged_entry: merged(local as unknown as JournalEntry),
          resolution: null,
          conflicts: null,
          error: null,
        })),
      })),
    });

    const summary = await new SyncEngine({
      apiClient: apiMock,
      online: () => true,
    }).syncNow();

    expect(summary.status).toBe('ok');
    expect(summary.pushed).toBe(1);
    expect(await db.outbox.count()).toBe(0);
  });

  it('stores conflicts and marks the entry as conflicting', async () => {
    const local = await createLocalEntry(input, user);
    const apiMock = makeApi({
      push: vi.fn(async (request: SyncPushRequest) => ({
        server_time: new Date().toISOString(),
        results: request.ops.map((op: SyncPushOp) => ({
          op_id: op.op_id,
          status: 'conflict' as const,
          version: 2,
          duplicate: false,
          merged_entry: {
            ...merged(local as unknown as JournalEntry),
            text: 'Серверный текст',
          },
          resolution: { text: 'remote' as const },
          conflicts: [
            {
              field: 'text',
              reason: 'older_change',
              local_hlc: '1795000000000:00000:test0001',
              remote_hlc: '1795000000001:00000:test0001',
            },
          ],
          error: null,
        })),
      })),
    });

    const summary = await new SyncEngine({
      apiClient: apiMock,
      online: () => true,
    }).syncNow();

    expect(summary.conflicts).toBe(1);
    const stored = await db.entries.get(local.id);
    expect(stored?.sync_status).toBe('conflict');
    expect(stored?.text).toBe('Серверный текст');
    const conflicts = await db.conflicts.toArray();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ field: 'text', resolution: 'pending' });
  });

  it('schedules exponential backoff after a network error', async () => {
    await createLocalEntry(input, user);
    const apiMock = makeApi({
      push: vi.fn(async () => {
        throw new ApiError(0, 'E-NET-01', 'Нет соединения');
      }),
    });

    const before = Date.now();
    await new SyncEngine({
      apiClient: apiMock,
      online: () => true,
    }).syncNow();

    const operations = await db.outbox.toArray();
    expect(operations).toHaveLength(1);
    expect(operations[0]?.attempts).toBe(1);
    expect(operations[0]?.status).toBe('pending');
    const next = Date.parse(operations[0]!.next_attempt_at!);
    expect(next).toBeGreaterThanOrEqual(before + 2 * 60 * 1000 - 1000);
  });

  it('applies changes and advances the changes cursor', async () => {
    const local = await createLocalEntry(input, user);
    await db.outbox.clear();
    const serverEntry: JournalEntry = {
      ...(local as unknown as JournalEntry),
      text: 'Текст из changes',
      version: 5,
      sync_status: 'synced',
    };
    const apiMock = makeApi({
      changes: vi.fn(async () => ({
        next_seq: 7,
        has_more: false,
        changes: [
          {
            seq: 7,
            entity_type: 'entry' as const,
            op: 'upsert' as const,
            entity: serverEntry as unknown as Record<string, unknown>,
          },
        ],
      })),
    });

    await new SyncEngine({
      apiClient: apiMock,
      online: () => true,
    }).syncNow();

    expect((await getLocalEntry(local.id)).entry?.text).toBe('Текст из changes');
    expect(await getSyncCursor()).toBe(7);
  });

  it('returns offline without touching the outbox when navigator is offline', async () => {
    await createLocalEntry(input, user);
    const summary = await new SyncEngine({
      apiClient: makeApi(),
      online: () => false,
    }).syncNow();

    expect(summary.status).toBe('offline');
    expect(await db.outbox.count()).toBe(1);
  });

  it('escalates an operation to dead after ten attempts', async () => {
    await createLocalEntry(input, user);
    const operation = (await db.outbox.toArray())[0]!;
    const ninth = { ...operation, attempts: 9 };
    await db.outbox.put(ninth);

    await failOperation(ninth, { code: 'E-NET-01', message: 'network' }, 1000);

    const stored = await db.outbox.get(operation.op_id);
    expect(stored).toMatchObject({
      status: 'dead',
      attempts: 10,
      next_attempt_at: null,
      last_error_code: 'E-NET-01',
    });
  });
  it('pulls server-side conflicts into Dexie and does not duplicate them', async () => {
    const conflict = (id: string, field: string): ConflictRecord => ({
      id,
      entry_id: SEED_UUIDS.entry1,
      field,
      local_value: 'локальное значение',
      remote_value: 'серверное значение',
      local_hlc: '1795000000200:00001:test0001',
      remote_hlc: '1795000000300:00002:test0002',
      resolution: 'pending',
      resolved_by: null,
      resolved_at: null,
    });
    const conflicts = vi.fn(async () => ({
      items: [conflict('conflict-1', 'text'), conflict('conflict-2', 'comment')],
    }));
    const engine = new SyncEngine({
      apiClient: makeApi({ conflicts }),
      online: () => true,
    });

    const first = await engine.syncNow();

    expect(first.status).toBe('ok');
    expect(conflicts).toHaveBeenCalledTimes(1);
    expect(await db.conflicts.count()).toBe(2);
    expect(await db.conflicts.get('conflict-1')).toMatchObject({
      field: 'text',
      resolution: 'pending',
    });
    await engine.syncNow();

    expect(await db.conflicts.count()).toBe(2);
    const pulledAt = await db.meta.get('server_conflicts_pulled_at');
    expect(pulledAt?.value).toEqual(expect.any(String));
  });

  it('updates an existing conflict when the server resolves it', async () => {
    await db.conflicts.put({
      id: 'conflict-1',
      entry_id: SEED_UUIDS.entry1,
      field: 'text',
      local_value: 'локальное',
      remote_value: 'серверное',
      local_hlc: '1795000000200:00001:test0001',
      remote_hlc: '1795000000300:00002:test0002',
      resolution: 'pending',
      resolved_by: null,
      resolved_at: null,
    });
    const resolved: ConflictRecord = {
      id: 'conflict-1',
      entry_id: SEED_UUIDS.entry1,
      field: 'text',
      local_value: 'локальное',
      remote_value: 'серверное',
      local_hlc: '1795000000200:00001:test0001',
      remote_hlc: '1795000000300:00002:test0002',
      resolution: 'remote',
      resolved_by: SEED_UUIDS.supervisor,
      resolved_at: '2026-11-25T08:00:00.000Z',
    };
    const engine = new SyncEngine({
      apiClient: makeApi({ conflicts: vi.fn(async () => ({ items: [resolved] })) }),
      online: () => true,
    });

    await engine.syncNow();

    expect(await db.conflicts.count()).toBe(1);
    expect(await db.conflicts.get('conflict-1')).toMatchObject({
      resolution: 'remote',
      resolved_at: '2026-11-25T08:00:00.000Z',
    });
  });

  it('keeps a successful sync when the conflicts request fails', async () => {
    const engine = new SyncEngine({
      apiClient: makeApi({
        conflicts: vi.fn(async () => {
          throw new Error('conflicts unavailable');
        }),
      }),
      online: () => true,
    });

    const summary = await engine.syncNow();

    expect(summary.status).toBe('ok');
    expect(summary.pushed).toBe(0);
    expect(await db.conflicts.count()).toBe(0);
  });
});

describe('backoffDelayMs', () => {
  it('grows from 2 to 15 minutes', () => {
    expect(backoffDelayMs(1)).toBe(2 * 60 * 1000);
    expect(backoffDelayMs(2)).toBe(4 * 60 * 1000);
    expect(backoffDelayMs(3)).toBe(8 * 60 * 1000);
    expect(backoffDelayMs(10)).toBe(15 * 60 * 1000);
  });
});
