import { compareHlc, validateEventData, type Hlc, type JournalEventType } from '@logbook/shared';

export const MERGEABLE_FIELDS = [
  'performed_at',
  'performed_tz_offset_min',
  'performed_at_source',
  'performed_at_reason_id',
  'performed_at_comment',
  'shift_date',
  'work_type_id',
  'site_id',
  'permit_id',
  'permit_number_raw',
  'permit_binding_status',
  'permit_status_at_sync',
  'permit_risk_flag',
  'permit_risk_reason',
  'text',
  'comment',
  'input_method',
  'asr_engine',
  'asr_confidence',
  'offline_created',
  'event_type',
  'event_data',
  'late_entry',
] as const;

export type MergeableField = (typeof MERGEABLE_FIELDS)[number];

export interface MergeableEntry {
  id: string;
  author_id: string;
  version: number;
  hlc: Hlc;
  verified_at: string | null;
  status: string;
  performed_at_source?: string;
  field_clocks?: Record<string, Hlc> | null;
  [key: string]: unknown;
}

export interface MergeOperation {
  op_type: 'create' | 'update' | 'delete';
  hlc: Hlc;
  field_clocks?: Record<string, Hlc>;
  payload: Record<string, unknown>;
  client_time: string;
}

export interface MergeConflict {
  field: string;
  local_value: unknown;
  remote_value: unknown;
  local_hlc: Hlc;
  remote_hlc: Hlc;
  reason: string;
}

export interface MergeDecision {
  applied: Record<string, { before: unknown; after: unknown }>;
  fieldClocks: Record<string, Hlc>;
  conflicts: MergeConflict[];
  blocked: boolean;
}

/**
 * Field-level LWW with HLC (ADR-04, C-01…C-12).
 * The server is authoritative; the client never merges.
 */
export function decideMerge(
  current: MergeableEntry,
  operation: MergeOperation,
  actor: { id: string; role: string },
): MergeDecision {
  const applied: Record<string, { before: unknown; after: unknown }> = {};
  const fieldClocks: Record<string, Hlc> = {
    ...(current.field_clocks ?? {}),
  };
  const conflicts: MergeConflict[] = [];
  let blocked = false;

  for (const field of MERGEABLE_FIELDS) {
    if (!(field in operation.payload)) {
      continue;
    }

    const before = current[field] ?? null;
    const after = operation.payload[field];
    if (before === after) {
      continue;
    }

    const currentClock = fieldClocks[field] ?? current.hlc;
    const incomingClock =
      operation.field_clocks?.[field] ?? operation.hlc;

    // C-08: a server-corrected time is replaced only with explicit consent.
    if (
      (field === 'performed_at' || field === 'performed_at_source') &&
      current.performed_at_source === 'server_corrected' &&
      operation.payload.accept_server_time !== true
    ) {
      conflicts.push({
        field,
        local_value: after,
        remote_value: before,
        local_hlc: incomingClock,
        remote_hlc: currentClock,
        reason: 'server_correction_requires_consent',
      });
      continue;
    }

    // C-03: verified entry cannot be edited by its author.
    if (
      current.verified_at !== null &&
      actor.id === current.author_id
    ) {
      blocked = true;
      conflicts.push({
        field,
        local_value: after,
        remote_value: before,
        local_hlc: incomingClock,
        remote_hlc: currentClock,
        reason: 'verified_entry',
      });
      continue;
    }

    const comparison = compareHlc(incomingClock, currentClock);
    if (comparison > 0) {
      applied[field] = { before, after };
      fieldClocks[field] = incomingClock;
      if (
        field === 'performed_at' &&
        !('performed_at_source' in operation.payload)
      ) {
        applied.performed_at_source = {
          before: current.performed_at_source ?? null,
          after: 'manual',
        };
        fieldClocks.performed_at_source = incomingClock;
      }
      continue;
    }

    if (comparison < 0) {
      conflicts.push({
        field,
        local_value: after,
        remote_value: before,
        local_hlc: incomingClock,
        remote_hlc: currentClock,
        reason: 'older_change',
      });
      continue;
    }

    // Equal clocks with different values: server state wins (C-12 tie-break).
    conflicts.push({
      field,
      local_value: after,
      remote_value: before,
      local_hlc: incomingClock,
      remote_hlc: currentClock,
      reason: 'equal_clock',
    });
  }

  if (current.status === 'deleted') {
    blocked = true;
  }

  return { applied, fieldClocks, conflicts, blocked };
}

/**
 * C-10: validate the merged candidate before touching the database.
 * Returns human-readable violations; an empty list means the state is valid.
 */
export function validateMergedEntry(entry: MergeableEntry): string[] {
  const errors: string[] = [];
  const text = typeof entry.text === 'string' ? entry.text.trim() : '';

  if (text.length < 10 || text.length > 2000) {
    errors.push('text_length');
  }
  if (entry.input_method === 'voice' && !entry.asr_engine) {
    errors.push('voice_requires_asr_engine');
  }
  if (entry.permit_risk_flag === true && !entry.permit_risk_reason) {
    errors.push('risk_requires_reason');
  }
  if (entry.permit_id && entry.permit_number_raw) {
    errors.push('permit_id_and_number_raw_are_exclusive');
  }
  if (entry.permit_binding_status === 'linked' && !entry.permit_id) {
    errors.push('linked_permit_requires_permit_id');
  }
  const offset = Number(entry.performed_tz_offset_min);
  if (!Number.isInteger(offset) || offset < -840 || offset > 840) {
    errors.push('performed_tz_offset_min_out_of_range');
  }

  const eventType = (entry.event_type ?? 'work') as JournalEventType;
  if (eventType !== 'work' && eventType !== 'other' && !entry.event_data) {
    errors.push('event_data_required');
  }
  if (entry.event_data !== undefined && entry.event_data !== null) {
    const eventResult = validateEventData(eventType, entry.event_data);
    if (!eventResult.success) {
      errors.push('invalid_event_data');
    }
  }

  return errors;
}
