import {
  DEFAULT_JOURNAL_ID,
  DEFAULT_JOURNAL_KEY,
  formatHlc,
  nextHlc,
  type ConflictRecord,
  type EntryRevision,
  type Grounding,
  type Hlc,
  type Journal,
  type JournalEntry,
  type JournalEventType,
  type JournalReview,
  type OutboxOperation,
  type Permit,
  type SyncPushResult,
  uuidv7,
} from '@logbook/shared';
import type { ApiUser, ChangeItem, SnapshotResponse } from '../api/types';
import { getDeviceMeta, setDeviceMeta } from './device-db';
import {
  applyServerShift,
  markShiftConflict,
} from './shift-repositories';
import {
  db,
  type AttachmentRow,
  type ClientJournalEntry,
  type SyncStateRow,
} from './schema';

export interface EntryInput {
  performed_at: string;
  performed_tz_offset_min: number;
  performed_at_source?: 'device_auto' | 'manual' | 'server_corrected';
  work_type_id: string;
  site_id: string | null;
  site_name_raw?: string | null;
  site_binding_status?: 'linked' | 'unresolved' | 'not_found' | 'not_required';
  permit_id: string | null;
  permit_number_raw?: string | null;
  permit_binding_status?: 'linked' | 'unresolved' | 'not_required';
  permit_status_at_sync?: string | null;
  permit_risk_flag?: boolean;
  permit_risk_reason?: string | null;
  shift_date?: string | null;
  text: string;
  comment?: string | null;
  input_method: 'manual' | 'voice';
  performed_at_comment?: string | null;
  /** C-08... */
  accept_server_time?: boolean;
  event_type?: JournalEventType;
  event_data?: Record<string, unknown> | null;
  late_entry?: boolean;
  /** Journal the entry is created in; defaults to `main` (JRN-03). */
  journal_id?: string | null;
}

const NODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomNode(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => NODE_ALPHABET[byte % NODE_ALPHABET.length]).join('');
}

export async function getMeta(key: string): Promise<string | null> {
  const row = await db.meta.get(key);
  return row?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}

export async function getDeviceId(): Promise<string> {
  const existing = await getDeviceMeta('device_id');
  if (existing) {
    return existing;
  }
  const id = uuidv7();
  await setDeviceMeta('device_id', id);
  return id;
}

export async function setDeviceId(id: string): Promise<void> {
  await setDeviceMeta('device_id', id);
}

/**
 * Stable installation id used for device registration (ADR-23). The legacy
 * locally generated `device_id` is reused as the install id on migration.
 * Device identity lives in the device database so it survives user switches.
 */
export async function getInstallId(): Promise<string> {
  const existing = await getDeviceMeta('install_id');
  if (existing) {
    return existing;
  }
  const legacyDeviceId = await getDeviceMeta('device_id');
  const installId = legacyDeviceId ?? uuidv7();
  await setDeviceMeta('install_id', installId);
  return installId;
}

/** Device key issued by the server at registration (device-bound sync). */
export async function getDeviceKey(deviceId: string): Promise<string | null> {
  return getDeviceMeta(`device_key:${deviceId}`);
}

export async function setDeviceKey(
  deviceId: string,
  key: string,
): Promise<void> {
  await setDeviceMeta(`device_key:${deviceId}`, key);
}

/**
 * CSRF token persisted for the service worker: a background flush after the
 * tab was closed cannot read the page memory, only IndexedDB.
 */
export async function setPersistedCsrfToken(token: string): Promise<void> {
  await setDeviceMeta('csrf_token', token);
}

export async function getPersistedCsrfToken(): Promise<string | null> {
  return getDeviceMeta('csrf_token');
}

async function getNodeId(): Promise<string> {
  const existing = await getDeviceMeta('device_node');
  if (existing) {
    return existing;
  }
  const node = randomNode();
  await setDeviceMeta('device_node', node);
  return node;
}

async function newHlc(): Promise<Hlc> {
  const node = await getNodeId();
  const last = await getDeviceMeta('hlc_last');
  const hlc = nextHlc(last, Date.now(), node);
  await setDeviceMeta('hlc_last', hlc);
  return hlc;
}

function payloadOf(input: EntryInput): Record<string, unknown> {
  return {
    performed_at: input.performed_at,
    performed_tz_offset_min: input.performed_tz_offset_min,
    performed_at_source: input.performed_at_source ?? 'device_auto',
    performed_at_comment: input.performed_at_comment ?? null,
    work_type_id: input.work_type_id,
    site_id: input.site_id,
    site_name_raw: input.site_id ? null : (input.site_name_raw ?? null),
    site_binding_status:
      input.site_binding_status ??
      (input.site_id
        ? 'linked'
        : input.site_name_raw
          ? 'unresolved'
          : 'not_required'),
    permit_id: input.permit_id,
    permit_number_raw: input.permit_id ? null : (input.permit_number_raw ?? null),
    permit_binding_status:
      input.permit_binding_status ??
      (input.permit_id ? 'linked' : input.permit_number_raw ? 'unresolved' : 'not_required'),
    permit_status_at_sync: input.permit_status_at_sync ?? null,
    permit_risk_flag: input.permit_risk_flag ?? false,
    permit_risk_reason: input.permit_risk_reason ?? null,
    shift_date: input.shift_date ?? null,
    text: input.text,
    comment: input.comment ?? null,
    input_method: input.input_method,
    offline_created: true,
    event_type: input.event_type ?? 'work',
    event_data: input.event_data ?? null,
    late_entry: input.late_entry ?? false,
    journal_id: input.journal_id ?? DEFAULT_JOURNAL_ID,
  };
}

function clocksFor(payload: Record<string, unknown>, hlc: Hlc): Record<string, Hlc> {
  return Object.fromEntries(Object.keys(payload).map((field) => [field, hlc]));
}

function baseEntry(
  id: string,
  user: ApiUser,
  payload: Record<string, unknown>,
  hlc: Hlc,
  deviceId: string,
  now: string,
): ClientJournalEntry {
  return {
    id,
    author_id: user.id,
    performed_at: String(payload.performed_at),
    performed_tz_offset_min: Number(payload.performed_tz_offset_min),
    performed_at_source:
      (payload.performed_at_source as 'device_auto' | 'manual' | 'server_corrected') ??
      'device_auto',
    performed_at_reason_id: null,
    performed_at_comment: (payload.performed_at_comment as string | null) ?? null,
    shift_date: (payload.shift_date as string | null) ?? null,
    work_type_id: String(payload.work_type_id),
    site_id: (payload.site_id as string | null) ?? null,
    site_name_raw: (payload.site_name_raw as string | null) ?? null,
    site_binding_status:
      (payload.site_binding_status as ClientJournalEntry['site_binding_status']) ??
      (payload.site_id ? 'linked' : 'not_required'),
    permit_id: (payload.permit_id as string | null) ?? null,
    permit_number_raw: (payload.permit_number_raw as string | null) ?? null,
    permit_binding_status:
      (payload.permit_binding_status as
        | 'linked'
        | 'unresolved'
        | 'not_found'
        | 'not_required') ?? 'not_required',
    permit_status_at_sync:
      (payload.permit_status_at_sync as JournalEntry['permit_status_at_sync']) ?? null,
    permit_risk_flag: Boolean(payload.permit_risk_flag),
    permit_risk_reason: (payload.permit_risk_reason as string | null) ?? null,
    text: String(payload.text),
    comment: (payload.comment as string | null) ?? null,
    input_method: (payload.input_method as 'manual' | 'voice') ?? 'manual',
    asr_engine: null,
    asr_confidence: null,
    offline_created: true,
    status: 'active',
    sync_status: 'pending',
    version: 0,
    hlc,
    created_at_client: now,
    created_at_server: null,
    updated_at_client: now,
    updated_at_server: null,
    deleted_at: null,
    deleted_by: null,
    delete_reason_id: null,
    device_id: deviceId,
    revision_no: 0,
    last_op_id: null,
    verified_at: null,
    verified_by: null,
    unverified_at: null,
    unverified_by: null,
    event_type: (payload.event_type as JournalEventType) ?? 'work',
    event_data: (payload.event_data as Record<string, unknown> | null) ?? null,
    late_entry: Boolean(payload.late_entry),
    journal_id: (payload.journal_id as string | null) ?? DEFAULT_JOURNAL_ID,
    journal_seq: null,
    field_clocks: clocksFor(payload, hlc),
  };
}

async function writeRevision(
  tx: typeof db,
  entry: ClientJournalEntry,
  user: ApiUser,
  hlc: Hlc,
  diff: Record<string, { before: unknown; after: unknown }>,
  revisionNo: number,
): Promise<void> {
  const revision: EntryRevision = {
    id: uuidv7(),
    entry_id: entry.id,
    revision_no: revisionNo,
    changed_by: user.id,
    changed_at: new Date().toISOString(),
    source: 'client',
    hlc,
    base_version: entry.version,
    result_version: entry.version,
    diff,
    reason_id: null,
    reason_comment: null,
  };
  await tx.revisions.put(revision);
}

export async function createLocalEntry(
  input: EntryInput,
  user: ApiUser,
): Promise<ClientJournalEntry> {
  const hlc = await newHlc();
  const deviceId = await getDeviceId();
  const now = new Date().toISOString();
  const payload = payloadOf(input);
  const id = uuidv7();
  const opId = uuidv7();
  const entry = baseEntry(id, user, payload, hlc, deviceId, now);
  entry.last_op_id = opId;

  await db.transaction('rw', db.entries, db.revisions, db.outbox, async () => {
    await db.entries.put(entry);
    await writeRevision(
      db,
      entry,
      user,
      hlc,
      Object.fromEntries(
        Object.entries(payload).map(([field, after]) => [field, { before: null, after }]),
      ),
      0,
    );
    const op: OutboxOperation = {
      op_id: opId,
      user_id: user.id,
      device_id: deviceId,
      entity_type: 'entry',
      entity_id: id,
      op_type: 'create',
      payload,
      field_clocks: clocksFor(payload, hlc),
      base_version: null,
      hlc,
      created_at: now,
      attempts: 0,
      next_attempt_at: null,
      last_error_code: null,
      last_error_message: null,
      status: 'pending',
      sent_at: null,
      ack_at: null,
    };
    await db.outbox.put(op);
  });

  return entry;
}

export async function updateLocalEntry(
  entryId: string,
  patch: Partial<EntryInput>,
  user: ApiUser,
): Promise<ClientJournalEntry> {
  const hlc = await newHlc();
  const deviceId = await getDeviceId();
  const now = new Date().toISOString();

  return db.transaction('rw', db.entries, db.revisions, db.outbox, db.meta, async () => {
    const entry = await db.entries.get(entryId);
    if (!entry) {
      throw new Error('Запись не найдена');
    }

    const operations = await db.outbox.where('entity_id').equals(entryId).toArray();
    const createOp = operations.find(
      (op) => op.op_type === 'create' && op.status !== 'dead',
    );

    const payload: Record<string, unknown> = {};
    if (patch.performed_at !== undefined) payload.performed_at = patch.performed_at;
    if (patch.performed_tz_offset_min !== undefined) {
      payload.performed_tz_offset_min = patch.performed_tz_offset_min;
    }
    if (patch.work_type_id !== undefined) payload.work_type_id = patch.work_type_id;
    if (patch.site_id !== undefined) payload.site_id = patch.site_id;
    if (patch.permit_id !== undefined) payload.permit_id = patch.permit_id;
    if (patch.permit_number_raw !== undefined) {
      payload.permit_number_raw = patch.permit_number_raw;
    }
    if (patch.text !== undefined) payload.text = patch.text;
    if (patch.comment !== undefined) payload.comment = patch.comment;
    if (patch.input_method !== undefined) payload.input_method = patch.input_method;
    if (patch.shift_date !== undefined) payload.shift_date = patch.shift_date;
    if (patch.permit_risk_flag !== undefined) {
      payload.permit_risk_flag = patch.permit_risk_flag;
    }
    if (patch.permit_risk_reason !== undefined) {
      payload.permit_risk_reason = patch.permit_risk_reason;
    }
    if (patch.accept_server_time !== undefined) {
      payload.accept_server_time = patch.accept_server_time;
    }
    if (patch.event_type !== undefined) payload.event_type = patch.event_type;
    if (patch.event_data !== undefined) payload.event_data = patch.event_data;
    if (patch.late_entry !== undefined) payload.late_entry = patch.late_entry;
    // The journal is immutable once an entry reached the server. A not-yet-
    // synced entry may still be moved because only its create op exists.
    if (patch.journal_id !== undefined && createOp) {
      payload.journal_id = patch.journal_id ?? DEFAULT_JOURNAL_ID;
    }
    payload.permit_binding_status =
      patch.permit_binding_status ??
      ((patch.permit_id !== undefined ? patch.permit_id : entry.permit_id)
        ? 'linked'
        : (patch.permit_number_raw !== undefined
            ? patch.permit_number_raw
            : entry.permit_number_raw)
          ? 'unresolved'
          : 'not_required');
    payload.offline_created = true;

    const clocks = clocksFor(payload, hlc);
    const nextEntry: ClientJournalEntry = {
      ...entry,
      ...(payload as Partial<ClientJournalEntry>),
      hlc,
      sync_status: 'pending',
      updated_at_client: now,
      revision_no: entry.revision_no + 1,
      field_clocks: { ...(entry.field_clocks ?? {}), ...clocks },
    };

    if (createOp) {
      const mergedPayload = { ...createOp.payload, ...payload };
      await db.outbox.put({
        ...createOp,
        payload: mergedPayload,
        field_clocks: { ...createOp.field_clocks, ...clocks },
        hlc,
      });
    } else {
      await db.outbox.put({
        op_id: uuidv7(),
        user_id: user.id,
        device_id: deviceId,
        entity_type: 'entry',
        entity_id: entryId,
        op_type: 'update',
        payload,
        field_clocks: clocks,
        base_version: entry.version,
        hlc,
        created_at: now,
        attempts: 0,
        next_attempt_at: null,
        last_error_code: null,
        last_error_message: null,
        status: 'pending',
        sent_at: null,
        ack_at: null,
      });
    }

    await db.entries.put(nextEntry);
    await writeRevision(
      db,
      nextEntry,
      user,
      hlc,
      Object.fromEntries(
        Object.entries(payload).map(([field, after]) => [
          field,
          { before: (entry as unknown as Record<string, unknown>)[field] ?? null, after },
        ]),
      ),
      nextEntry.revision_no,
    );
    return nextEntry;
  });
}

export async function deleteLocalEntry(
  entryId: string,
  user: ApiUser,
): Promise<void> {
  const hlc = await newHlc();
  const deviceId = await getDeviceId();
  const now = new Date().toISOString();

  await db.transaction('rw', db.entries, db.revisions, db.outbox, db.meta, async () => {
    const entry = await db.entries.get(entryId);
    if (!entry) {
      return;
    }
    const operations = await db.outbox.where('entity_id').equals(entryId).toArray();
    const createOp = operations.find(
      (op) => op.op_type === 'create' && op.status !== 'dead',
    );
    if (createOp) {
      await db.outbox.delete(createOp.op_id);
      await db.revisions.where('entry_id').equals(entryId).delete();
      await db.entries.delete(entryId);
      return;
    }

    await db.outbox.put({
      op_id: uuidv7(),
      user_id: user.id,
      device_id: deviceId,
      entity_type: 'entry',
      entity_id: entryId,
      op_type: 'delete',
      payload: {},
      field_clocks: {},
      base_version: entry.version,
      hlc,
      created_at: now,
      attempts: 0,
      next_attempt_at: null,
      last_error_code: null,
      last_error_message: null,
      status: 'pending',
      sent_at: null,
      ack_at: null,
    });
    await db.entries.put({
      ...entry,
      status: 'deleted',
      sync_status: 'pending',
      deleted_at: now,
      deleted_by: user.id,
      hlc,
      updated_at_client: now,
    });
    const next = { ...entry, status: 'deleted' as const, version: entry.version };
    await writeRevision(
      db,
      next,
      user,
      hlc,
      { status: { before: entry.status, after: 'deleted' } },
      entry.revision_no + 1,
    );
  });
}

export async function listLocalEntries(options: {
  status?: 'active' | 'deleted';
  search?: string;
  journal_id?: string;
} = {}): Promise<ClientJournalEntry[]> {
  const status = options.status ?? 'active';
  let rows = await db.entries.where('status').equals(status).toArray();
  if (rows.length === 0 && status === 'active') {
    rows = (await db.entries.toArray()).filter((row) => row.status === 'active');
  }
  if (options.journal_id) {
    rows = rows.filter(
      (row) => (row.journal_id ?? DEFAULT_JOURNAL_ID) === options.journal_id,
    );
  }
  const search = options.search?.trim().toLowerCase();
  if (search) {
    rows = rows.filter(
      (row) =>
        row.text.toLowerCase().includes(search) ||
        (row.permit_number_raw ?? '').toLowerCase().includes(search),
    );
  }
  return rows.sort((left, right) =>
    right.performed_at.localeCompare(left.performed_at),
  );
}

/** Built-in journal catalogue used before the first snapshot is cached. */
function defaultJournal(): Journal {
  return {
    id: DEFAULT_JOURNAL_ID,
    journal_key: DEFAULT_JOURNAL_KEY,
    name: 'Основной оперативный журнал',
    description: null,
    active: true,
    sort_order: 10,
  };
}

/** Journals available on this device (snapshot cache); never empty. */
export async function listLocalJournals(): Promise<Journal[]> {
  const rows = await db.journals.toArray();
  const active = rows.filter((row) => row.active !== false);
  if (active.length === 0) {
    return [defaultJournal()];
  }
  return active.sort(
    (left, right) =>
      (left.sort_order ?? 100) - (right.sort_order ?? 100) ||
      left.journal_key.localeCompare(right.journal_key),
  );
}

export function journalName(
  journalId: string | null | undefined,
  journals: Journal[],
): string {
  const id = journalId ?? DEFAULT_JOURNAL_ID;
  return journals.find((journal) => journal.id === id)?.name ?? 'Журнал';
}

export async function getLocalEntry(
  id: string,
): Promise<{ entry: ClientJournalEntry | null; revisions: EntryRevision[] }> {
  const [entry, revisions] = await Promise.all([
    db.entries.get(id),
    db.revisions.where('entry_id').equals(id).sortBy('revision_no'),
  ]);
  return { entry: entry ?? null, revisions };
}

export async function applyServerEntry(entry: JournalEntry): Promise<void> {
  await db.entries.put({
    ...entry,
    sync_status: 'synced',
    field_clocks: undefined,
  } as ClientJournalEntry);
}

export async function applyServerEntryMerged(
  entry: JournalEntry,
): Promise<void> {
  await applyServerEntry(entry);
}

const CHANGE_CONFLICT_FIELDS = [
  'performed_at',
  'performed_tz_offset_min',
  'performed_at_source',
  'work_type_id',
  'site_id',
  'permit_id',
  'permit_number_raw',
  'permit_binding_status',
  'permit_risk_flag',
  'permit_risk_reason',
  'text',
  'comment',
  'input_method',
  'event_type',
  'event_data',
  'late_entry',
] as const;

export async function applyChanges(changes: ChangeItem[]): Promise<number> {
  if (changes.length === 0) {
    return 0;
  }
  let applied = 0;
  await db.transaction(
    'rw',
    [db.entries, db.permits, db.outbox, db.conflicts, db.shifts, db.groundings],
    async () => {
    for (const change of changes) {
      if (change.entity_type === 'permit') {
        if (change.op === 'upsert' && change.entity) {
          await db.permits.put(change.entity as unknown as Permit);
          applied += 1;
        }
        continue;
      }

      if (change.entity_type === 'grounding') {
        // Grounding registry is server-derived from grounding events.
        if (change.op === 'upsert' && change.entity) {
          await db.groundings.put(change.entity as unknown as Grounding);
          applied += 1;
        }
        continue;
      }

      if (change.entity_type === 'shift') {
        // Shift handovers are cached for the offline supervisor screen; a
        // pending local operation wins and is flagged as a conflict instead.
        if (change.op === 'upsert' && change.entity) {
          const shiftId = String(change.entity.id ?? change.entity_id ?? '');
          if (shiftId) {
            const pending = await db.outbox
              .where('entity_id')
              .equals(shiftId)
              .count();
            if (pending > 0) {
              await markShiftConflict(shiftId, 'shift_conflict');
            } else {
              await applyServerShift(change.entity as never);
              applied += 1;
            }
          }
        }
        continue;
      }

      const id = change.entity?.id
        ? String(change.entity.id)
        : (change.entity_id ?? '');
      if (!id) {
        continue;
      }

      if (change.op === 'delete') {
        const pending = await db.outbox.where('entity_id').equals(id).count();
        if (pending > 0) {
          const local = await db.entries.get(id);
          if (local) {
            await saveChangeConflict(
              local,
              null,
              '_entity',
              { status: local.status },
              { status: 'deleted' },
            );
            await db.entries.update(id, { sync_status: 'conflict' });
          }
        } else {
          await db.entries.delete(id);
          applied += 1;
        }
        continue;
      }

      if (change.entity) {
        const pending = await db.outbox.where('entity_id').equals(id).count();
        if (pending > 0) {
          const local = await db.entries.get(id);
          if (!local) {
            continue;
          }
          const remote = change.entity as unknown as ClientJournalEntry;
          let differences = 0;
          for (const field of CHANGE_CONFLICT_FIELDS) {
            if (local[field] !== remote[field]) {
              await saveChangeConflict(
                local,
                remote,
                field,
                local[field] ?? null,
                remote[field] ?? null,
              );
              differences += 1;
            }
          }
          if (differences > 0) {
            await db.entries.update(id, { sync_status: 'conflict' });
          }
        } else {
          await applyServerEntry(change.entity as unknown as JournalEntry);
          applied += 1;
        }
      }
    }
  });
  return applied;
}

/** Persist a pending conflict when a server change races a local pending op. */
async function saveChangeConflict(
  local: ClientJournalEntry,
  remote: ClientJournalEntry | null,
  field: string,
  localValue: unknown,
  remoteValue: unknown,
): Promise<void> {
  const existing = await db.conflicts.where('entry_id').equals(local.id).toArray();
  if (
    existing.some(
      (conflict) =>
        conflict.field === field && conflict.resolution === 'pending',
    )
  ) {
    return;
  }
  const record: ConflictRecord = {
    id: uuidv7(),
    entry_id: local.id,
    field,
    local_value: localValue,
    remote_value: remoteValue,
    local_hlc: local.hlc,
    remote_hlc: remote?.hlc ?? local.hlc,
    resolution: 'pending',
    resolved_by: null,
    resolved_at: null,
  };
  await db.conflicts.put(record);
}

export async function applySnapshot(snapshot: SnapshotResponse): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.dict_work_types,
      db.dict_sites,
      db.dict_templates,
      db.dict_reasons,
      db.dict_departments,
      db.journals,
      db.meta,
    ],
    async () => {
      await db.dict_work_types.bulkPut(snapshot.work_types.items);
      await db.dict_sites.bulkPut(snapshot.sites.items);
      await db.dict_templates.bulkPut(snapshot.templates.items);
      await db.dict_reasons.bulkPut(snapshot.reasons.items);
      await db.dict_departments.bulkPut(snapshot.departments.items);
      if (snapshot.journals) {
        await db.journals.bulkPut(snapshot.journals.items);
      }
      await db.meta.put({ key: 'snapshot_id', value: snapshot.snapshot_id });
      await db.meta.put({
        key: 'dict_versions',
        value: JSON.stringify({
          work_types: snapshot.work_types.version,
          sites: snapshot.sites.version,
          templates: snapshot.templates.version,
          reasons: snapshot.reasons.version,
          departments: snapshot.departments.version,
          journals: snapshot.journals?.version ?? 0,
        }),
      });
    },
  );
}

export async function applyPermits(permits: Permit[]): Promise<void> {
  await db.permits.bulkPut(permits);
}

export async function applyJournalReviews(
  reviews: JournalReview[],
): Promise<void> {
  await db.journal_reviews.bulkPut(reviews);
}

export async function listLocalReviews(): Promise<JournalReview[]> {
  const rows = await db.journal_reviews.toArray();
  return rows.sort((left, right) =>
    right.reviewed_at.localeCompare(left.reviewed_at),
  );
}

const MAX_SCAN_BYTES = 20 * 1024 * 1024;
const MAX_SCAN_PAGES = 10;

/**
 * Create one offline paper-permit scan and its upload operation. The PDF Blob
 * lives in the per-user IndexedDB; PostgreSQL will only receive metadata after
 * the server upload succeeds.
 */
export async function createPermitScan(
  entryId: string,
  pdf: Blob,
  pages: number,
  sha256: string,
  user: ApiUser,
): Promise<AttachmentRow> {
  if (!Number.isInteger(pages) || pages < 1 || pages > MAX_SCAN_PAGES) {
    throw new Error('Скан должен содержать от 1 до 10 страниц');
  }
  if (pdf.size <= 0 || pdf.size > MAX_SCAN_BYTES) {
    throw new Error('Скан должен быть не больше 20 МБ');
  }
  if (pdf.type !== 'application/pdf') {
    throw new Error('Скан должен быть PDF');
  }
  const existing = await db.attachments
    .where('entry_id')
    .equals(entryId)
    .filter((row) => !row.deleted_at)
    .first();
  if (existing) {
    throw new Error('У записи уже есть скан наряда');
  }

  const hlc = await newHlc();
  const deviceId = await getDeviceId();
  const id = uuidv7();
  const now = new Date().toISOString();
  const row: AttachmentRow = {
    id,
    entry_id: entryId,
    kind: 'permit_scan',
    mime_type: 'application/pdf',
    pages,
    sha256,
    size_bytes: pdf.size,
    status: 'local',
    created_by: user.id,
    created_at: now,
    created_at_local: now,
    blob: pdf,
    last_error: null,
  };
  const operation: OutboxOperation = {
    op_id: uuidv7(),
    user_id: user.id,
    device_id: deviceId,
    entity_type: 'attachment',
    entity_id: id,
    op_type: 'create',
    payload: {
      entry_id: entryId,
      pages,
      sha256,
      size_bytes: pdf.size,
    },
    field_clocks: {},
    base_version: null,
    hlc,
    created_at: now,
    attempts: 0,
    next_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    status: 'pending',
    sent_at: null,
    ack_at: null,
  };

  await db.transaction('rw', db.attachments, db.outbox, async () => {
    await db.attachments.put(row);
    await db.outbox.put(operation);
  });
  return row;
}

export async function listLocalAttachments(entryId: string): Promise<AttachmentRow[]> {
  return db.attachments
    .where('entry_id')
    .equals(entryId)
    .filter((row) => !row.deleted_at)
    .toArray();
}

/** Remove a still-local scan and its not-yet-sent upload operation. */
export async function deleteLocalAttachment(id: string): Promise<void> {
  await db.transaction('rw', db.attachments, db.outbox, async () => {
    await db.outbox.where('entity_id').equals(id).delete();
    await db.attachments.delete(id);
  });
}

export async function saveConflicts(
  op: OutboxOperation,
  result: SyncPushResult,
  remoteEntry: JournalEntry | null,
): Promise<void> {
  const conflicts = result.conflicts;
  if (!conflicts || conflicts.length === 0) {
    return;
  }
  await db.transaction('rw', db.conflicts, async () => {
    for (const conflict of conflicts) {
      const record: ConflictRecord = {
        id: uuidv7(),
        entry_id: op.entity_id,
        field: conflict.field,
        local_value: op.payload[conflict.field] ?? null,
        remote_value:
          remoteEntry && conflict.field in remoteEntry
            ? (remoteEntry as unknown as Record<string, unknown>)[conflict.field]
            : null,
        local_hlc: conflict.local_hlc as Hlc,
        remote_hlc: conflict.remote_hlc as Hlc,
        resolution: 'pending',
        resolved_by: null,
        resolved_at: null,
      };
      await db.conflicts.put(record);
    }
  });
}

export async function applyConflictFromServer(
  conflict: ConflictRecord,
): Promise<void> {
  await db.conflicts.put(conflict);
}

export async function listConflicts(): Promise<ConflictRecord[]> {
  return db.conflicts.orderBy('id').reverse().toArray();
}

export async function resolveLocalConflict(
  id: string,
  resolution: 'local' | 'remote' | 'manual',
): Promise<void> {
  await db.conflicts.update(id, {
    resolution,
    resolved_at: new Date().toISOString(),
  });
}

export async function pendingOperations(now = Date.now()): Promise<OutboxOperation[]> {
  const rows = await db.outbox.where('status').equals('pending').toArray();
  return rows.filter(
    (op) => !op.next_attempt_at || Date.parse(op.next_attempt_at) <= now,
  );
}

/**
 * S-10 queue: every outbox operation in creation order.
 *
 * `created_at` is not a Dexie index (see the outbox store declaration), so
 * `orderBy('created_at')` throws `SchemaError` and the /sync screen turns
 * white. Sort the (small) queue in memory instead — no schema/upgrade change
 * is needed for a read-only screen.
 */
export async function allOperations(): Promise<OutboxOperation[]> {
  const rows = await db.outbox.toArray();
  return rows.sort((left, right) => left.created_at.localeCompare(right.created_at));
}

export async function markInFlight(opIds: string[]): Promise<void> {
  if (opIds.length === 0) return;
  await db.outbox.where('op_id').anyOf(opIds).modify({
    status: 'in_flight' as OutboxOperation['status'],
    sent_at: new Date().toISOString(),
  });
}

export async function completeOperation(opId: string): Promise<void> {
  await db.outbox.delete(opId);
}

export async function failOperation(
  op: OutboxOperation,
  error: { code: string; message: string },
  delayMs: number,
): Promise<void> {
  const attempts = op.attempts + 1;
  const dead = attempts >= 10;
  await db.outbox.update(op.op_id, {
    attempts,
    status: dead ? 'dead' : 'pending',
    next_attempt_at: dead
      ? null
      : new Date(Date.now() + delayMs).toISOString(),
    last_error_code: error.code,
    last_error_message: error.message,
  });
}

export async function resetInFlight(): Promise<number> {
  return db.outbox
    .where('status')
    .equals('in_flight')
    .modify({ status: 'pending', next_attempt_at: null });
}

export async function retryDeadOperation(opId: string): Promise<void> {
  await db.outbox.update(opId, {
    status: 'pending',
    attempts: 0,
    next_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
  });
}

export async function outboxCounts(): Promise<{
  pending: number;
  dead: number;
  inFlight: number;
}> {
  const [pending, dead, inFlight] = await Promise.all([
    db.outbox.where('status').equals('pending').count(),
    db.outbox.where('status').equals('dead').count(),
    db.outbox.where('status').equals('in_flight').count(),
  ]);
  return { pending, dead, inFlight };
}

export async function pendingConflictCount(): Promise<number> {
  return db.conflicts.where('resolution').equals('pending').count();
}

export async function getSyncCursor(): Promise<number> {
  const row = await db.sync_state.get('changes');
  return row?.cursor ?? 0;
}

export async function setSyncCursor(cursor: number, successAt: string): Promise<void> {
  const row: SyncStateRow = {
    key: 'changes',
    cursor,
    last_success_at: successAt,
    last_attempt_at: successAt,
    server_time_offset_ms: 0,
  };
  await db.sync_state.put(row);
}

export async function saveDraft(
  userId: string,
  deviceId: string,
  payload: Record<string, unknown>,
  entryId: string | null,
): Promise<void> {
  await db.drafts.put({
    id: entryId ? `edit:${entryId}` : `new:${userId}`,
    user_id: userId,
    entry_id: entryId,
    payload,
    updated_at: new Date().toISOString(),
    device_id: deviceId,
  });
}

export async function loadDraft(
  userId: string,
  entryId: string | null,
): Promise<Record<string, unknown> | null> {
  const row = await db.drafts.get(entryId ? `edit:${entryId}` : `new:${userId}`);
  return row?.payload ?? null;
}

export async function clearDraft(
  userId: string,
  entryId: string | null,
): Promise<void> {
  await db.drafts.delete(entryId ? `edit:${entryId}` : `new:${userId}`);
}

export async function hasLocalData(): Promise<boolean> {
  return (await db.entries.count()) > 0;
}

/**
 * Called on explicit logout: every user-scoped store is cleared (SYN-02).
 * Device identity lives in the device database and is intentionally kept;
 * `lock` does not call this at all (ADR-10).
 */
export async function clearLocalUserData(): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) {
      await table.clear();
    }
  });
}

export { formatHlc };
