/**
 * Outbox flush executed inside the service worker (SYN-05, ADR-03).
 *
 * This module deliberately avoids Dexie and the DOM: it runs after the tab was
 * closed, so it opens the per-user IndexedDB directly and speaks the same
 * `/v1/sync/push` protocol as the page engine. All state it needs (device id,
 * device key, CSRF token, active user) lives in the device database.
 */

const USER_DB_PREFIX = 'logbook:user:';
const DEVICE_DB_NAME = 'logbook:device';
const DEFAULT_ENDPOINT = '/v1/sync/push';
const MAX_OPS_PER_PUSH = 50;
const MAX_ATTEMPTS = 10;
const MIN_BACKOFF_MS = 2 * 60 * 1000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;

/** Mirrors `userDatabaseName` from db/user-db.ts without importing Dexie. */
export function workerUserDatabaseName(userId: string): string {
  return `${USER_DB_PREFIX}${userId}`;
}

export interface WorkerOutboxRow {
  op_id: string;
  user_id: string;
  device_id: string;
  entity_type: string;
  entity_id: string;
  op_type: 'create' | 'update' | 'delete';
  payload: Record<string, unknown>;
  field_clocks: Record<string, unknown>;
  base_version: number | null;
  hlc: string;
  created_at: string;
  attempts: number;
  next_attempt_at: string | null;
  status: 'pending' | 'in_flight' | 'dead';
  last_error_code?: string | null;
  last_error_message?: string | null;
}

export interface SwFlushOptions {
  userId?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  online?: () => boolean;
  /** Stop after this many operations (diagnostics/tests). */
  maxOperations?: number;
}

export interface SwFlushResult {
  status: 'ok' | 'skipped' | 'offline' | 'error';
  pushed: number;
  failed: number;
  conflicts: number;
  pending: number;
  reason?: string;
  retryable?: boolean;
  error?: string;
}

interface PushResult {
  op_id: string;
  status: 'applied' | 'duplicate' | 'rejected' | 'conflict';
  version?: number | null;
  error?: { code?: string; message?: string } | null;
}

const PERMANENT_CODES = new Set(['E-VAL-01', 'E-AUTH-02', 'E-VER-01', 'E-NOT-01']);

export function workerBackoffDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(MIN_BACKOFF_MS * 2 ** exponent, MAX_BACKOFF_MS);
}

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

/** Open a database only when it exists (never creates one). */
export async function openIfExists(name: string): Promise<IDBDatabase | null> {
  const factory = indexedDB as IDBFactory & {
    databases?: () => Promise<Array<{ name?: string }>>;
  };
  if (typeof factory.databases === 'function') {
    try {
      const databases = await factory.databases();
      if (!databases.some((database) => database.name === name)) {
        return null;
      }
    } catch {
      // Fall through to the upgrade-abort probe.
    }
  }
  return new Promise((resolve) => {
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => {
      request.transaction?.abort();
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function readStore<T>(
  database: IDBDatabase,
  storeName: string,
): Promise<T[]> {
  if (!database.objectStoreNames.contains(storeName)) {
    return [];
  }
  const transaction = database.transaction(storeName, 'readonly');
  const rows = await requestToPromise(
    transaction.objectStore(storeName).getAll() as IDBRequest<T[]>,
  );
  await transactionDone(transaction);
  return rows;
}

async function readMeta(
  database: IDBDatabase,
  key: string,
): Promise<string | null> {
  if (!database.objectStoreNames.contains('meta')) {
    return null;
  }
  const transaction = database.transaction('meta', 'readonly');
  const row = await requestToPromise(
    transaction.objectStore('meta').get(key) as IDBRequest<
      { key: string; value: string } | undefined
    >,
  );
  await transactionDone(transaction);
  return row?.value ?? null;
}

async function writeMeta(
  database: IDBDatabase,
  values: Record<string, string>,
): Promise<void> {
  if (!database.objectStoreNames.contains('meta')) {
    return;
  }
  const transaction = database.transaction('meta', 'readwrite');
  const store = transaction.objectStore('meta');
  for (const [key, value] of Object.entries(values)) {
    store.put({ key, value });
  }
  await transactionDone(transaction);
}

async function updateOperations(
  database: IDBDatabase,
  patches: Array<{ op_id: string; row: WorkerOutboxRow | null }>,
): Promise<void> {
  if (!database.objectStoreNames.contains('outbox')) {
    return;
  }
  const transaction = database.transaction('outbox', 'readwrite');
  const store = transaction.objectStore('outbox');
  for (const patch of patches) {
    if (patch.row) {
      store.put(patch.row);
    } else {
      store.delete(patch.op_id);
    }
  }
  await transactionDone(transaction);
}

function parsePushResults(payload: unknown): PushResult[] {
  const body = payload as { results?: unknown } | null;
  if (!body || !Array.isArray(body.results)) {
    return [];
  }
  return body.results.filter(
    (result): result is PushResult =>
      Boolean(result) && typeof (result as PushResult).op_id === 'string',
  );
}

function dueOperations(rows: WorkerOutboxRow[], nowMs: number): WorkerOutboxRow[] {
  return rows
    .filter(
      (row) =>
        row.status === 'pending' || row.status === 'in_flight',
    )
    .filter(
      (row) => !row.next_attempt_at || Date.parse(row.next_attempt_at) <= nowMs,
    )
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
}

/**
 * Flush the outbox of the active (or provided) user from the service worker.
 * Applies the same result semantics as the page engine: acknowledged and
 * conflicting operations leave the queue, transient failures are retried with
 * backoff, permanent rejections become `dead`.
 */
export async function flushOutboxInWorker(
  options: SwFlushOptions = {},
): Promise<SwFlushResult> {
  const now = options.now ?? (() => Date.now());
  const nowMs = now();
  const fetchImpl = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  const online =
    options.online ??
    (() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  if (!online()) {
    return { status: 'offline', pushed: 0, failed: 0, conflicts: 0, pending: 0 };
  }
  if (!fetchImpl) {
    return {
      status: 'error',
      pushed: 0,
      failed: 0,
      conflicts: 0,
      pending: 0,
      error: 'fetch недоступен в service worker',
      retryable: false,
    };
  }

  const device = await openIfExists(DEVICE_DB_NAME).catch(() => null);
  if (!device) {
    return { status: 'skipped', pushed: 0, failed: 0, conflicts: 0, pending: 0, reason: 'no-device' };
  }

  let userId = options.userId ?? null;
  let deviceId: string | null = null;
  let csrfToken: string | null = null;
  let deviceKey: string | null = null;
  try {
    userId ??= (await readMeta(device, 'active_user_id')) || null;
    deviceId = (await readMeta(device, 'device_id')) || null;
    csrfToken = (await readMeta(device, 'csrf_token')) || null;
    if (deviceId) {
      deviceKey = (await readMeta(device, `device_key:${deviceId}`)) || null;
    }
  } finally {
    device.close();
  }

  if (!userId) {
    return { status: 'skipped', pushed: 0, failed: 0, conflicts: 0, pending: 0, reason: 'no-active-user' };
  }
  if (!deviceId || !deviceKey) {
    return { status: 'skipped', pushed: 0, failed: 0, conflicts: 0, pending: 0, reason: 'no-device-key' };
  }

  const userDatabase = await openIfExists(workerUserDatabaseName(userId)).catch(
    () => null,
  );
  if (!userDatabase) {
    return { status: 'skipped', pushed: 0, failed: 0, conflicts: 0, pending: 0, reason: 'no-user-database' };
  }

  let pushed = 0;
  let failed = 0;
  let conflicts = 0;
  let retryable = false;
  let errorMessage: string | undefined;

  try {
    const rows = await readStore<WorkerOutboxRow>(userDatabase, 'outbox');
    let due = dueOperations(rows, nowMs);
    if (options.maxOperations) {
      due = due.slice(0, options.maxOperations);
    }
    if (due.length === 0) {
      return { status: 'skipped', pushed: 0, failed: 0, conflicts: 0, pending: 0, reason: 'empty' };
    }

    for (let offset = 0; offset < due.length; offset += MAX_OPS_PER_PUSH) {
      const chunk = due.slice(offset, offset + MAX_OPS_PER_PUSH);
      const body = {
        device_id: deviceId,
        app_version: 'sw',
        ops: chunk.map((operation) => ({
          op_id: operation.op_id,
          entity_type: operation.entity_type,
          entity_id: operation.entity_id,
          op_type: operation.op_type,
          base_version: operation.base_version,
          hlc: operation.hlc,
          client_time: operation.created_at,
          payload: operation.payload,
          field_clocks: operation.field_clocks,
        })),
      };

      let response: Response;
      try {
        response = await fetchImpl(options.endpoint ?? DEFAULT_ENDPOINT, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-Device-Key': deviceKey,
            ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
          },
          body: JSON.stringify(body),
        });
      } catch (caught) {
        // Network failure: schedule a retry, keep the rows.
        const message = caught instanceof Error ? caught.message : 'Нет соединения';
        await updateOperations(
          userDatabase,
          chunk.map((operation) => ({
            op_id: operation.op_id,
            row: {
              ...operation,
              attempts: operation.attempts + 1,
              status: 'pending',
              next_attempt_at: new Date(
                nowMs + workerBackoffDelayMs(operation.attempts + 1),
              ).toISOString(),
            },
          })),
        );
        failed += chunk.length;
        retryable = true;
        errorMessage = message;
        await writeMeta(userDatabase, { sync_error: message });
        break;
      }

      if (response.status === 401 || response.status === 403) {
        // Session/device rejected: do not mutate or drop the queue.
        return {
          status: 'error',
          pushed,
          failed,
          conflicts,
          pending: chunk.length,
          error: `HTTP ${response.status}`,
          retryable: false,
        };
      }

      if (!response.ok) {
        await updateOperations(
          userDatabase,
          chunk.map((operation) => ({
            op_id: operation.op_id,
            row: {
              ...operation,
              attempts: operation.attempts + 1,
              status: 'pending',
              next_attempt_at: new Date(
                nowMs + workerBackoffDelayMs(operation.attempts + 1),
              ).toISOString(),
            },
          })),
        );
        failed += chunk.length;
        retryable = response.status >= 500 || response.status === 429;
        errorMessage = `HTTP ${response.status}`;
        await writeMeta(userDatabase, { sync_error: errorMessage });
        continue;
      }

      const raw = await response.text();
      let payload: unknown = null;
      try {
        payload = raw ? JSON.parse(raw) : null;
      } catch {
        payload = null;
      }
      const results = parsePushResults(payload);
      const patches: Array<{ op_id: string; row: WorkerOutboxRow | null }> = [];
      for (const operation of chunk) {
        const result = results.find((item) => item.op_id === operation.op_id);
        if (!result) {
          failed += 1;
          retryable = true;
          patches.push({
            op_id: operation.op_id,
            row: {
              ...operation,
              attempts: operation.attempts + 1,
              status: 'pending',
              next_attempt_at: new Date(
                nowMs + workerBackoffDelayMs(operation.attempts + 1),
              ).toISOString(),
            },
          });
          continue;
        }
        if (result.status === 'applied' || result.status === 'duplicate') {
          pushed += 1;
          patches.push({ op_id: operation.op_id, row: null });
          continue;
        }
        if (result.status === 'conflict') {
          conflicts += 1;
          patches.push({ op_id: operation.op_id, row: null });
          continue;
        }
        const code = result.error?.code ?? 'E-SRV-01';
        const message = result.error?.message ?? 'Операция отклонена сервером';
        if (PERMANENT_CODES.has(code)) {
          patches.push({
            op_id: operation.op_id,
            row: {
              ...operation,
              attempts: MAX_ATTEMPTS,
              status: 'dead',
              next_attempt_at: null,
              last_error_code: code,
              last_error_message: message,
            },
          });
          failed += 1;
        } else {
          patches.push({
            op_id: operation.op_id,
            row: {
              ...operation,
              attempts: operation.attempts + 1,
              status: 'pending',
              next_attempt_at: new Date(
                nowMs + workerBackoffDelayMs(operation.attempts + 1),
              ).toISOString(),
              last_error_code: code,
              last_error_message: message,
            },
          });
          failed += 1;
          retryable = true;
        }
      }
      await updateOperations(userDatabase, patches);
    }

    const remaining = await readStore<WorkerOutboxRow>(userDatabase, 'outbox');
    const pending = remaining.filter(
      (row) => row.status === 'pending' || row.status === 'in_flight',
    ).length;
    await writeMeta(userDatabase, {
      sync_last_at: new Date(nowMs).toISOString(),
      sync_error: errorMessage ?? '',
    });

    const result: SwFlushResult = {
      status: 'ok',
      pushed,
      failed,
      conflicts,
      pending,
      ...(errorMessage ? { error: errorMessage } : {}),
      retryable,
    };
    const deviceAgain = await openIfExists(DEVICE_DB_NAME).catch(() => null);
    if (deviceAgain) {
      try {
        await writeMeta(deviceAgain, {
          sw_last_flush: JSON.stringify({
            at: new Date(nowMs).toISOString(),
            ...result,
          }),
        });
      } finally {
        deviceAgain.close();
      }
    }
    return result;
  } finally {
    userDatabase.close();
  }
}
