import type {
  DeviceRegistrationInput,
  DeviceRegistrationResponse,
  Grounding,
  EntryAttachment,
  JournalReview,
  OutboxOperation,
  Role,
  Shift,
  SyncPushRequest,
  SyncPushResult,
} from '@logbook/shared';
import { api, ApiError } from '../api/client';
import type { ApiClient } from '../api/client';
import type {
  ChangesResponse,
  ConflictsResponse,
  DeviceRow,
  EntriesResponse,
  PermitsResponse,
  PushResponse,
  SnapshotResponse,
} from '../api/types';
import {
  applyChanges,
  applyConflictFromServer,
  applyPermits,
  applyServerEntry,
  applySnapshot,
  completeOperation,
  failOperation,
  getDeviceId,
  getDeviceKey,
  getInstallId,
  getMeta,
  getSyncCursor,
  markInFlight,
  pendingOperations,
  resetInFlight,
  saveConflicts,
  setDeviceId,
  setDeviceKey,
  setMeta,
  setSyncCursor,
} from '../db/repositories';
import { db } from '../db/schema';
import {
  applyServerShift,
  markShiftConflict,
} from '../db/shift-repositories';
import {
  refreshSupervisorCache,
  supervisorCacheEnabled,
  type SupervisorCacheApi,
} from '../db/supervisor-cache';
import { backoffDelayMs } from './backoff';

export interface SyncApi {
  devices(): Promise<{ items: DeviceRow[] }>;
  registerDevice(
    input: DeviceRegistrationInput,
  ): Promise<DeviceRegistrationResponse>;
  entries(params?: {
    limit?: number;
    from?: string;
    to?: string;
    journal_id?: string;
    cursor?: string;
  }): Promise<EntriesResponse>;
  snapshot(): Promise<SnapshotResponse>;
  permits(): Promise<PermitsResponse>;
  changes(sinceSeq: number, limit?: number): Promise<ChangesResponse>;
  push(body: SyncPushRequest, deviceKey?: string): Promise<PushResponse>;
  /** Paper-permit scan upload (PDF Blob, not part of /sync/push). */
  uploadAttachment?(
    entryId: string,
    pdf: Blob,
    pages: number,
    sha256: string,
  ): Promise<EntryAttachment>;
  /** Optional: server-side conflicts for the offline S-13 review (ADR-04). */
  conflicts?(): Promise<ConflictsResponse>;
  /** Optional: supervisor cache stores the journal reviews as well. */
  reviews?(params: {
    from?: string;
    to?: string;
    journal_id?: string;
    limit?: number;
  }): Promise<{ items: JournalReview[] }>;
  /** Optional: cached shift handovers (JRN-02). */
  shifts?(): Promise<{ items: Shift[] }>;
  /** Optional: grounding registry cache (JRN-06). */
  groundings?(): Promise<{ items: Grounding[] }>;
}

export interface SyncEngineOptions {
  apiClient?: SyncApi;
  now?: () => number;
  online?: () => boolean;
  appVersion?: string;
  /** Current account; the supervisor cache is only refreshed for its roles. */
  currentUser?: () => { id: string; role: Role } | null;
  /** Server feature flag `features.supervisor_cache` (undefined = by role). */
  supervisorCacheFeature?: boolean;
}

export interface SyncSummary {
  status: 'ok' | 'offline' | 'busy' | 'error';
  pushed: number;
  pulled: number;
  conflicts: number;
  error?: string;
}

interface LockManagerLike {
  request<T>(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown | null) => Promise<T>,
  ): Promise<T>;
}

const DEFAULT_APP_VERSION = import.meta.env.VITE_APP_VERSION ?? '0.2.0';
const PERMANENT_CODES = new Set([
  'E-VAL-01',
  'E-AUTH-02',
  'E-VER-01',
  'E-NOT-01',
]);
const SYNC_LOCK = 'logbook-sync';

function onlineDefault(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine;
}

function platformLabel(): string | undefined {
  if (typeof navigator === 'undefined') {
    return undefined;
  }
  const navigatorWithUa = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const value = navigatorWithUa.userAgentData?.platform ?? navigator.platform;
  return value ? value.slice(0, 40) : undefined;
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item !== undefined) {
          await worker(item);
        }
      }
    },
  );
  await Promise.all(workers);
}

/**
 * Client sync engine (ADR-03/ADR-04):
 * Web Locks → outbox groups by entity → ≤50 ops per push → server merge → changes.
 */
export class SyncEngine {
  private readonly api: SyncApi;
  private readonly now: () => number;
  private readonly online: () => boolean;
  private readonly appVersion: string;
  private readonly currentUser: () => { id: string; role: Role } | null;
  private readonly supervisorCacheFeature?: boolean;
  private running = false;

  constructor(options: SyncEngineOptions = {}) {
    this.api = options.apiClient ?? api;
    this.now = options.now ?? (() => Date.now());
    this.online = options.online ?? onlineDefault;
    this.appVersion = options.appVersion ?? DEFAULT_APP_VERSION;
    this.currentUser = options.currentUser ?? (() => null);
    this.supervisorCacheFeature = options.supervisorCacheFeature;
  }

  async syncNow(): Promise<SyncSummary> {
    if (!this.online()) {
      return { status: 'offline', pushed: 0, pulled: 0, conflicts: 0 };
    }

    const locks = (
      typeof navigator !== 'undefined'
        ? (navigator as unknown as { locks?: LockManagerLike }).locks
        : undefined
    );
    if (locks?.request) {
      return locks.request(SYNC_LOCK, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          return { status: 'busy', pushed: 0, pulled: 0, conflicts: 0 };
        }
        return this.run();
      });
    }

    if (this.running) {
      return { status: 'busy', pushed: 0, pulled: 0, conflicts: 0 };
    }
    return this.run();
  }

  private async run(): Promise<SyncSummary> {
    if (this.running) {
      return { status: 'busy', pushed: 0, pulled: 0, conflicts: 0 };
    }
    this.running = true;
    try {
      await resetInFlight();
      await this.bootstrap();
      const pushed = await this.push();
      const attachmentsUploaded = await this.uploadPendingAttachments();
      const pulled = await this.pullChanges();
      await this.refreshSupervisorCacheIfNeeded();
      await this.pullConflictsIfAvailable();
      await setMeta('sync_last_at', new Date(this.now()).toISOString());
      await setMeta('sync_error', '');
      return {
        status: 'ok',
        pushed: pushed.pushed + attachmentsUploaded,
        pulled: pulled.pulled,
        conflicts: pushed.conflicts,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Не удалось синхронизировать';
      await setMeta('sync_error', message);
      return {
        status: 'error',
        pushed: 0,
        pulled: 0,
        conflicts: 0,
        error: message,
      };
    } finally {
      this.running = false;
    }
  }

  /**
   * Device registration (ADR-23): idempotent by install_id. The server returns
   * a device key once; it is stored locally and sent with every push.
   */
  private async registerDevice(): Promise<void> {
    const installId = await getInstallId();
    const knownDeviceId = await getMeta('device_id');
    const knownKey = knownDeviceId ? await getDeviceKey(knownDeviceId) : null;
    const registration = await this.api.registerDevice({
      install_id: installId,
      name: 'Logbook web',
      platform: platformLabel(),
      app_version: this.appVersion,
      rotate_key: Boolean(knownDeviceId) && !knownKey,
    });
    await setDeviceId(registration.device.id);
    if (registration.device_key) {
      await setDeviceKey(registration.device.id, registration.device_key);
    }
  }

  private async bootstrap(): Promise<void> {
    await this.registerDevice();

    if (!(await getMeta('snapshot_id'))) {
      const snapshot = await this.api.snapshot();
      await applySnapshot(snapshot);
    }

    if ((await db.permits.count()) === 0) {
      const permits = await this.api.permits();
      await applyPermits(permits.items);
    }

    if ((await db.entries.count()) === 0) {
      const entries = await this.api.entries({ limit: 100 });
      for (const entry of entries.items) {
        await applyServerEntry(entry);
      }
    }

    if (this.api.shifts && (await db.shifts.count()) === 0) {
      const shifts = await this.api.shifts();
      if (shifts.items.length > 0) {
        await db.shifts.bulkPut(
          shifts.items.map((shift) => ({ ...shift, sync_status: 'synced' })),
        );
      }
    }

    if (this.api.groundings && (await db.groundings.count()) === 0) {
      const groundings = await this.api.groundings();
      if (groundings.items.length > 0) {
        await db.groundings.bulkPut(groundings.items);
      }
    }
  }

  private async push(): Promise<{ pushed: number; conflicts: number }> {
    const operations = (await pendingOperations(this.now())).filter(
      (operation) => operation.entity_type !== 'attachment',
    );
    if (operations.length === 0) {
      return { pushed: 0, conflicts: 0 };
    }

    const groups = new Map<string, OutboxOperation[]>();
    for (const operation of operations) {
      const list = groups.get(operation.entity_id) ?? [];
      list.push(operation);
      groups.set(operation.entity_id, list);
    }

    let pushed = 0;
    let conflicts = 0;
    await runWithConcurrency([...groups.values()], 3, async (group) => {
      const result = await this.pushGroup(group);
      pushed += result.pushed;
      conflicts += result.conflicts;
    });
    return { pushed, conflicts };
  }

  private async pushGroup(
    operations: OutboxOperation[],
  ): Promise<{ pushed: number; conflicts: number }> {
    let pushed = 0;
    let conflicts = 0;

    for (let offset = 0; offset < operations.length; offset += 50) {
      const chunk = operations.slice(offset, offset + 50);
      await markInFlight(chunk.map((operation) => operation.op_id));

      try {
        const deviceId = await getDeviceId();
        const deviceKey = await getDeviceKey(deviceId);
        const response = await this.api.push(
          {
            device_id: deviceId,
            app_version: this.appVersion,
            ops: chunk.map((operation) => ({
              op_id: operation.op_id,
              entity_type: operation.entity_type as 'entry' | 'shift',
              entity_id: operation.entity_id,
              op_type: operation.op_type,
              base_version: operation.base_version,
              hlc: operation.hlc,
              client_time: operation.created_at,
              payload: operation.payload,
              field_clocks: operation.field_clocks,
            })),
          },
          deviceKey ?? undefined,
        );

        for (const result of response.results) {
          const operation = chunk.find((item) => item.op_id === result.op_id);
          if (!operation) {
            continue;
          }
          const handled = await this.handleResult(operation, result);
          if (handled === 'pushed') {
            pushed += 1;
          } else if (handled === 'conflict') {
            conflicts += 1;
          }
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          await resetInFlight();
          throw error;
        }
        const code = error instanceof ApiError ? error.code : 'E-NET-01';
        const message =
          error instanceof Error ? error.message : 'Не удалось отправить операции';
        for (const operation of chunk) {
          await failOperation(
            operation,
            { code, message },
            backoffDelayMs(operation.attempts + 1),
          );
        }
      }
    }

    return { pushed, conflicts };
  }

  private async uploadPendingAttachments(): Promise<number> {
    if (!this.api.uploadAttachment) return 0;
    const operations = (await pendingOperations(this.now())).filter(
      (operation) => operation.entity_type === 'attachment',
    );
    let uploaded = 0;
    for (const operation of operations) {
      const row = await db.attachments.get(operation.entity_id);
      if (!row?.blob) {
        await failOperation(
          operation,
          { code: 'E-VAL-01', message: 'PDF скан не найден локально' },
          backoffDelayMs(operation.attempts + 1),
        );
        continue;
      }
      await markInFlight([operation.op_id]);
      await db.attachments.update(row.id, { status: 'uploading', last_error: null });
      try {
        const attachment = await this.api.uploadAttachment(
          row.entry_id,
          row.blob,
          row.pages,
          row.sha256,
        );
        await db.attachments.update(row.id, {
          status: 'uploaded',
          server_id: attachment.id,
          url: attachment.url,
          last_error: null,
        });
        await completeOperation(operation.op_id);
        uploaded += 1;
      } catch (error) {
        const code = error instanceof ApiError ? error.code : 'E-NET-01';
        const message =
          error instanceof Error ? error.message : 'Не удалось загрузить скан';
        await db.attachments.update(row.id, { status: 'error', last_error: message });
        await failOperation(
          operation,
          { code, message },
          backoffDelayMs(operation.attempts + 1),
        );
      }
    }
    return uploaded;
  }

  private async handleResult(
    operation: OutboxOperation,
    result: SyncPushResult,
  ): Promise<'pushed' | 'conflict' | 'failed'> {
    if (result.status === 'rejected') {
      const code = result.error?.code ?? 'E-SRV-01';
      const message = result.error?.message ?? 'Операция отклонена сервером';
      if (PERMANENT_CODES.has(code)) {
        await db.outbox.update(operation.op_id, {
          status: 'dead',
          attempts: 10,
          next_attempt_at: null,
          last_error_code: code,
          last_error_message: message,
        });
      } else {
        await failOperation(
          operation,
          { code, message },
          backoffDelayMs(operation.attempts + 1),
        );
      }
      return 'failed';
    }

    if (result.merged_entry) {
      await applyServerEntry(result.merged_entry);
    } else if (result.merged_shift) {
      // Shift handover result (JRN-02): store the server state so the shift
      // screen works from the same per-user cache.
      await applyServerShift(result.merged_shift);
    } else if (result.version !== null) {
      await db.entries.update(operation.entity_id, {
        version: result.version,
        sync_status: 'synced',
      });
    }

    if (result.status === 'conflict') {
      if (operation.entity_type === 'shift') {
        const reason = result.conflicts?.[0]?.reason ?? 'shift_conflict';
        if (result.merged_shift) {
          await applyServerShift(result.merged_shift, { conflict: reason });
        } else {
          await markShiftConflict(operation.entity_id, reason);
        }
      } else {
        await saveConflicts(operation, result, result.merged_entry);
        await db.entries.update(operation.entity_id, { sync_status: 'conflict' });
      }
      await completeOperation(operation.op_id);
      return 'conflict';
    }

    await completeOperation(operation.op_id);
    return 'pushed';
  }

  /**
   * Pull conflicts created by another device (S-13). Best effort: a conflict
   * list failure must not fail the journal sync; the next run retries.
   */
  private async pullConflictsIfAvailable(): Promise<void> {
    if (!this.api.conflicts) {
      return;
    }
    try {
      await pullServerConflicts(this.api as Pick<ApiClient, 'conflicts'>);
      await setMeta(
        'server_conflicts_pulled_at',
        new Date(this.now()).toISOString(),
      );
    } catch {
      // Conflicts are a secondary surface; keep the successful push/pull.
    }
  }

  /**
   * Supervisor cache (ADR-16): cache the last 7 days of the department journal
   * for offline review. Best effort: a cache failure never fails the sync.
   */
  private async refreshSupervisorCacheIfNeeded(): Promise<void> {
    const user = this.currentUser();
    if (!supervisorCacheEnabled(user, this.supervisorCacheFeature) || !user) {
      return;
    }
    try {
      await refreshSupervisorCache({
        api: this.api as unknown as SupervisorCacheApi,
        user,
        now: this.now,
        featureFlag: this.supervisorCacheFeature,
      });
    } catch {
      // Offline review is a convenience; the journal itself already synced.
    }
  }

  private async pullChanges(): Promise<{ pulled: number }> {    let cursor = await getSyncCursor();
    let pulled = 0;

    for (let page = 0; page < 20; page += 1) {
      const response = await this.api.changes(cursor, 200);
      if (response.changes.length === 0) {
        break;
      }
      pulled += await applyChanges(response.changes);
      cursor = response.next_seq;
      await setSyncCursor(cursor, new Date(this.now()).toISOString());
      if (!response.has_more) {
        break;
      }
    }

    return { pulled };
  }
}

export function createSyncEngine(options: SyncEngineOptions = {}): SyncEngine {
  return new SyncEngine(options);
}

/**
 * Pull server-side conflicts into the local Dexie store (S-13).
 *
 * Conflict ids are stable on the server, so `put` is idempotent; an unchanged
 * record is skipped to avoid needless live-query churn on every sync.
 */
export async function pullServerConflicts(
  apiClient: Pick<ApiClient, 'conflicts'>,
): Promise<number> {
  const response = await apiClient.conflicts();
  let applied = 0;
  for (const conflict of response.items) {
    const existing = await db.conflicts.get(conflict.id);
    if (
      existing &&
      existing.resolution === conflict.resolution &&
      existing.resolved_at === conflict.resolved_at &&
      existing.remote_hlc === conflict.remote_hlc
    ) {
      continue;
    }
    await applyConflictFromServer(conflict);
    applied += 1;
  }
  return applied;
}
