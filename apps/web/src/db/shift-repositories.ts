import {
  DEFAULT_JOURNAL_ID,
  nextHlc,
  uuidv7,
  type Hlc,
  type Shift,
  type ShiftHandoverInput,
  type SyncStatus,
} from '@logbook/shared';
import type { ApiUser } from '../api/types';
import { db } from './schema';
import { getDeviceId, getMeta, setMeta } from './repositories';

/**
 * Offline-first shift handover (JRN-02).
 *
 * The outgoing supervisor hands the shift over offline, the incoming one
 * accepts or rejects it offline; both operations land in the shared outbox and
 * are replayed by the sync engine with idempotency and version conflicts.
 */
export interface ClientShift extends Shift {
  sync_status?: SyncStatus;
  sync_error?: string | null;
}

export interface ShiftHandoverLocalInput {
  journal_id?: string;
  shift_date: string;
  period_start: string;
  period_end: string;
  handover_comment: string;
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

async function getNodeId(): Promise<string> {
  const existing = await getMeta('device_node');
  if (existing) {
    return existing;
  }
  const node = randomNode();
  await setMeta('device_node', node);
  return node;
}

async function newHlc(): Promise<Hlc> {
  const node = await getNodeId();
  const last = await getMeta('hlc_last');
  const hlc = nextHlc(last, Date.now(), node);
  await setMeta('hlc_last', hlc);
  return hlc;
}

function normalizeShift(row: Shift): ClientShift {
  return {
    ...row,
    journal_id: row.journal_id ?? DEFAULT_JOURNAL_ID,
    sync_status: row.sync_status ?? 'synced',
  };
}

/** Local entries covered by the shift window (display hint; server wins). */
async function countLocalEntries(
  journalId: string,
  periodStart: string,
  periodEnd: string,
): Promise<number> {
  const rows = await db.entries
    .where('journal_id')
    .equals(journalId)
    .toArray();
  return rows.filter(
    (entry) =>
      entry.status === 'active' &&
      Date.parse(entry.performed_at) >= Date.parse(periodStart) &&
      Date.parse(entry.performed_at) < Date.parse(periodEnd),
  ).length;
}

export async function createShiftLocal(
  input: ShiftHandoverLocalInput,
  user: ApiUser,
): Promise<ClientShift> {
  const journalId = input.journal_id ?? DEFAULT_JOURNAL_ID;
  const hlc = await newHlc();
  const deviceId = await getDeviceId();
  const now = new Date().toISOString();
  const id = uuidv7();
  const opId = uuidv7();
  const entriesCount = await countLocalEntries(
    journalId,
    input.period_start,
    input.period_end,
  );

  const shift: ClientShift = {
    id,
    journal_id: journalId,
    shift_date: input.shift_date,
    period_start: input.period_start,
    period_end: input.period_end,
    status: 'handed_over',
    handed_over_by: user.id,
    handed_over_by_name: user.full_name,
    handed_over_at: now,
    handover_comment: input.handover_comment,
    accepted_by: null,
    accepted_at: null,
    acceptance_comment: null,
    rejected_by: null,
    rejected_at: null,
    rejection_reason: null,
    entries_count: entriesCount,
    entries_hash: '',
    content_hash: '',
    version: 1,
    hlc,
    created_at_client: now,
    created_at_server: null,
    updated_at_client: now,
    updated_at_server: null,
    device_id: deviceId,
    last_op_id: opId,
    sync_status: 'pending',
    sync_error: null,
  };

  const payload: Record<string, unknown> = {
    journal_id: journalId,
    shift_date: input.shift_date,
    period_start: input.period_start,
    period_end: input.period_end,
    handover_comment: input.handover_comment,
  };

  await db.transaction('rw', db.shifts, db.outbox, async () => {
    await db.shifts.put(shift as unknown as Shift);
    await db.outbox.put({
      op_id: opId,
      user_id: user.id,
      device_id: deviceId,
      entity_type: 'shift',
      entity_id: id,
      op_type: 'create',
      payload,
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
    });
  });

  return shift;
}

export async function acceptShiftLocal(
  id: string,
  comment: string | null,
  user: ApiUser,
): Promise<ClientShift> {
  return shiftDecisionLocal(id, 'accept', comment, null, user);
}

export async function rejectShiftLocal(
  id: string,
  reason: string,
  user: ApiUser,
): Promise<ClientShift> {
  return shiftDecisionLocal(id, 'reject', null, reason, user);
}

async function shiftDecisionLocal(
  id: string,
  action: 'accept' | 'reject',
  comment: string | null,
  rejectionReason: string | null,
  user: ApiUser,
): Promise<ClientShift> {
  const hlc = await newHlc();
  const deviceId = await getDeviceId();
  const now = new Date().toISOString();
  const opId = uuidv7();

  return db.transaction('rw', db.shifts, db.outbox, async () => {
    const current = await db.shifts.get(id);
    if (!current) {
      throw new Error('Смена не найдена');
    }
    if (current.status !== 'handed_over') {
      throw new Error('Смена уже принята или отклонена');
    }
    if (current.handed_over_by === user.id) {
      throw new Error('Смену принимает другой руководитель: нельзя принять свою смену');
    }

    const next: ClientShift = {
      ...(current as ClientShift),
      status: action === 'accept' ? 'accepted' : 'rejected',
      ...(action === 'accept'
        ? {
            accepted_by: user.id,
            accepted_by_name: user.full_name,
            accepted_at: now,
            acceptance_comment: comment,
          }
        : {
            rejected_by: user.id,
            rejected_by_name: user.full_name,
            rejected_at: now,
            rejection_reason: rejectionReason,
          }),
      updated_at_client: now,
      hlc,
      last_op_id: opId,
      sync_status: 'pending',
      sync_error: null,
    };

    await db.shifts.put(next as unknown as Shift);
    await db.outbox.put({
      op_id: opId,
      user_id: user.id,
      device_id: deviceId,
      entity_type: 'shift',
      entity_id: id,
      op_type: 'update',
      payload:
        action === 'accept'
          ? { action, comment }
          : { action, rejection_reason: rejectionReason },
      field_clocks: {},
      base_version: current.version,
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

    return next;
  });
}

export async function listLocalShifts(options: {
  status?: Shift['status'];
  journal_id?: string;
} = {}): Promise<ClientShift[]> {
  let rows = await db.shifts.toArray();
  if (options.status) {
    rows = rows.filter((row) => row.status === options.status);
  }
  if (options.journal_id) {
    rows = rows.filter(
      (row) => (row.journal_id ?? DEFAULT_JOURNAL_ID) === options.journal_id,
    );
  }
  return rows
    .map((row) => normalizeShift(row))
    .sort(
      (left, right) =>
        right.shift_date.localeCompare(left.shift_date) ||
        right.handed_over_at.localeCompare(left.handed_over_at),
    );
}

export async function getLocalShift(id: string): Promise<ClientShift | null> {
  const row = await db.shifts.get(id);
  return row ? normalizeShift(row) : null;
}

/**
 * Store the server shift state. A pending local operation is kept visible but
 * flagged as a conflict so the supervisor can review the server decision.
 */
export async function applyServerShift(
  shift: Shift,
  options: { conflict?: string | null } = {},
): Promise<void> {
  await db.shifts.put({
    ...shift,
    sync_status: options.conflict ? 'conflict' : 'synced',
    sync_error: options.conflict ?? null,
  } as unknown as Shift);
}

export async function markShiftConflict(
  id: string,
  reason: string,
): Promise<void> {
  const current = await db.shifts.get(id);
  if (!current) {
    return;
  }
  await db.shifts.put({
    ...current,
    sync_status: 'conflict',
    sync_error: reason,
  } as unknown as Shift);
}

/** Drop the local conflict flag after the server state was reviewed. */
export async function resolveShiftConflict(id: string): Promise<void> {
  const current = await db.shifts.get(id);
  if (!current) {
    return;
  }
  await db.shifts.put({
    ...current,
    sync_status: 'synced',
    sync_error: null,
  } as unknown as Shift);
}

export async function pendingShiftCount(): Promise<number> {
  const ids = (await db.shifts.toCollection().primaryKeys()) as string[];
  if (ids.length === 0) {
    return 0;
  }
  return db.outbox.where('entity_id').anyOf(ids).count();
}
