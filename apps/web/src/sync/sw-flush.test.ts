import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { SEED_HLC, SEED_UUIDS } from '@logbook/shared';
import {
  DeviceDatabase,
  getDeviceMeta,
} from '../db/device-db';
import { LogbookDatabase } from '../db/schema';
import { userDatabaseName } from '../db/user-db';
import {
  flushOutboxInWorker,
  workerBackoffDelayMs,
  workerUserDatabaseName,
  type WorkerOutboxRow,
} from './sw-flush';

const USER_ID = '01930000-0000-7000-8000-000000000101';
const DEVICE_ID = '01930000-0000-7000-8000-000000000201';
const NOW = Date.parse('2026-11-24T12:00:00.000Z');

function op(overrides: Partial<WorkerOutboxRow> = {}): WorkerOutboxRow {
  return {
    op_id: '01930000-0000-7000-8000-000000000301',
    user_id: USER_ID,
    device_id: DEVICE_ID,
    entity_type: 'entry',
    entity_id: '01930000-0000-7000-8000-000000000401',
    op_type: 'create',
    payload: { text: 'Запись из очереди' },
    field_clocks: { text: SEED_HLC.entry1 },
    base_version: null,
    hlc: SEED_HLC.entry1,
    created_at: '2026-11-24T08:00:00.000Z',
    attempts: 0,
    next_attempt_at: null,
    status: 'pending',
    ...overrides,
  };
}

async function seed(options: {
  active?: boolean;
  deviceKey?: boolean;
  operations?: WorkerOutboxRow[];
} = {}): Promise<void> {
  const device = new DeviceDatabase();
  await device.open();
  await device.meta.clear();
  if (options.active !== false) {
    await device.meta.put({ key: 'active_user_id', value: USER_ID });
  }
  await device.meta.put({ key: 'device_id', value: DEVICE_ID });
  if (options.deviceKey !== false) {
    await device.meta.put({ key: `device_key:${DEVICE_ID}`, value: 'device-key-1' });
  }
  await device.meta.put({ key: 'csrf_token', value: 'csrf-1' });
  await device.close();

  const database = new LogbookDatabase(workerUserDatabaseName(USER_ID));
  await database.open();
  if (options.operations?.length) {
    await database.outbox.bulkPut(options.operations as never);
  }
  await database.close();
}

async function userOutbox(): Promise<WorkerOutboxRow[]> {
  const database = new LogbookDatabase(workerUserDatabaseName(USER_ID));
  await database.open();
  const rows = (await database.outbox.toArray()) as unknown as WorkerOutboxRow[];
  await database.close();
  return rows;
}

async function userMeta(key: string): Promise<string | null> {
  const database = new LogbookDatabase(workerUserDatabaseName(USER_ID));
  await database.open();
  const row = await database.meta.get(key);
  await database.close();
  return row?.value ?? null;
}

function response(body: unknown, status = 200): Response {
  const raw = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => raw,
  } as unknown as Response;
}

const fetchMock = (body: unknown, status = 200) =>
  vi.fn(async () => response(body, status)) as unknown as typeof fetch;

describe('service worker outbox flush (SYN-05)', () => {
  it('exposes the same per-user database name as the app', () => {
    expect(workerUserDatabaseName(USER_ID)).toBe(userDatabaseName(USER_ID));
  });

  it('pushes pending operations with device and CSRF headers', async () => {
    await seed({ operations: [op()] });
    const fetchImpl = fetchMock({
      server_time: '2026-11-24T12:00:00.000Z',
      results: [
        {
          op_id: '01930000-0000-7000-8000-000000000301',
          status: 'applied',
          version: 1,
          duplicate: false,
          merged_entry: null,
          resolution: null,
          conflicts: null,
          error: null,
        },
      ],
    });

    const result = await flushOutboxInWorker({
      fetchImpl,
      now: () => NOW,
    });

    expect(result.status).toBe('ok');
    expect(result.pushed).toBe(1);
    expect(result.pending).toBe(0);
    expect(await userOutbox()).toHaveLength(0);

    const [url, init] = (fetchImpl as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/v1/sync/push');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['X-Device-Key']).toBe(
      'device-key-1',
    );
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBe(
      'csrf-1',
    );
    const body = JSON.parse(String(init.body)) as {
      device_id: string;
      ops: Array<{ entity_type: string; op_id: string }>;
    };
    expect(body.device_id).toBe(DEVICE_ID);
    expect(body.ops[0]?.entity_type).toBe('entry');
    expect(await userMeta('sync_last_at')).toBe('2026-11-24T12:00:00.000Z');
    expect(await getDeviceMeta('sw_last_flush')).toContain('"pushed":1');
  });

  it('sends shift operations with their entity type', async () => {
    await seed({
      operations: [
        op({
          entity_type: 'shift',
          entity_id: '01930000-0000-7000-8000-000000000402',
          op_type: 'create',
        }),
      ],
    });
    const fetchImpl = fetchMock({
      server_time: '2026-11-24T12:00:00.000Z',
      results: [
        {
          op_id: '01930000-0000-7000-8000-000000000301',
          status: 'applied',
          version: 1,
          duplicate: false,
          merged_entry: null,
          merged_shift: null,
          resolution: null,
          conflicts: null,
          error: null,
        },
      ],
    });

    await flushOutboxInWorker({ fetchImpl, now: () => NOW });

    const [, init] = (fetchImpl as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      ops: Array<{ entity_type: string }>;
    };
    expect(body.ops[0]?.entity_type).toBe('shift');
  });

  it('drops conflicting operations and counts them', async () => {
    await seed({ operations: [op()] });
    const fetchImpl = fetchMock({
      server_time: '2026-11-24T12:00:00.000Z',
      results: [
        {
          op_id: '01930000-0000-7000-8000-000000000301',
          status: 'conflict',
          version: 2,
          duplicate: false,
          merged_entry: null,
          resolution: null,
          conflicts: [{ field: 'text', reason: 'version', local_hlc: 'a', remote_hlc: 'b' }],
          error: null,
        },
      ],
    });

    const result = await flushOutboxInWorker({ fetchImpl, now: () => NOW });
    expect(result.conflicts).toBe(1);
    expect(result.pushed).toBe(0);
    expect(await userOutbox()).toHaveLength(0);
  });

  it('marks permanent rejections as dead and retries transient ones', async () => {
    await seed({
      operations: [
        op(),
        op({
          op_id: '01930000-0000-7000-8000-000000000302',
          entity_id: '01930000-0000-7000-8000-000000000402',
        }),
      ],
    });
    const fetchImpl = fetchMock({
      server_time: '2026-11-24T12:00:00.000Z',
      results: [
        {
          op_id: '01930000-0000-7000-8000-000000000301',
          status: 'rejected',
          version: null,
          duplicate: false,
          merged_entry: null,
          resolution: null,
          conflicts: null,
          error: { code: 'E-VAL-01', message: 'Некорректные данные' },
        },
        {
          op_id: '01930000-0000-7000-8000-000000000302',
          status: 'rejected',
          version: null,
          duplicate: false,
          merged_entry: null,
          resolution: null,
          conflicts: null,
          error: { code: 'E-SRV-01', message: 'Сервер недоступен' },
        },
      ],
    });

    const result = await flushOutboxInWorker({ fetchImpl, now: () => NOW });

    expect(result.failed).toBe(2);
    expect(result.retryable).toBe(true);
    const rows = await userOutbox();
    const dead = rows.find(
      (row) => row.op_id === '01930000-0000-7000-8000-000000000301',
    );
    expect(dead?.status).toBe('dead');
    expect(dead?.attempts).toBe(10);
    const retry = rows.find(
      (row) => row.op_id === '01930000-0000-7000-8000-000000000302',
    );
    expect(retry?.status).toBe('pending');
    expect(retry?.attempts).toBe(1);
    expect(retry?.next_attempt_at).toBe(
      new Date(NOW + workerBackoffDelayMs(1)).toISOString(),
    );
  });

  it('reschedules on a network failure without losing the queue', async () => {
    await seed({ operations: [op()] });
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const result = await flushOutboxInWorker({ fetchImpl, now: () => NOW });

    expect(result.status).toBe('ok');
    expect(result.failed).toBe(1);
    expect(result.retryable).toBe(true);
    const rows = await userOutbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.status).toBe('pending');
  });

  it('keeps the queue untouched when the session is rejected', async () => {
    await seed({ operations: [op()] });
    const fetchImpl = fetchMock({ error: { code: 'E-AUTH-01' } }, 401);

    const result = await flushOutboxInWorker({ fetchImpl, now: () => NOW });

    expect(result.status).toBe('error');
    expect(result.retryable).toBe(false);
    const rows = await userOutbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attempts).toBe(0);
    expect(rows[0]?.status).toBe('pending');
  });

  it('skips when there is no active user, no device key or nothing to send', async () => {
    await seed({ active: false });
    expect(
      (await flushOutboxInWorker({ now: () => NOW, fetchImpl: fetchMock({}) }))
        .reason,
    ).toBe('no-active-user');

    await seed({ deviceKey: false });
    expect(
      (
        await flushOutboxInWorker({
          now: () => NOW,
          fetchImpl: fetchMock({}),
        })
      ).reason,
    ).toBe('no-device-key');

    await seed({ operations: [] });
    expect(
      (await flushOutboxInWorker({ now: () => NOW, fetchImpl: fetchMock({}) }))
        .reason,
    ).toBe('empty');
  });

  it('reports offline without touching the queue', async () => {
    await seed({ operations: [op()] });
    const fetchImpl = fetchMock({});
    const result = await flushOutboxInWorker({
      fetchImpl,
      now: () => NOW,
      online: () => false,
    });
    expect(result.status).toBe('offline');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await userOutbox()).toHaveLength(1);
  });

  it('ignores operations scheduled for a later retry', async () => {
    await seed({
      operations: [
        op({ next_attempt_at: new Date(NOW + 60_000).toISOString() }),
      ],
    });
    const fetchImpl = fetchMock({});
    const result = await flushOutboxInWorker({ fetchImpl, now: () => NOW });
    expect(result.reason).toBe('empty');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
