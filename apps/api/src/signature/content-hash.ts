import { sha256, stableStringify } from '../common/context';

/**
 * Canonical content hash for an entry visa signature. Binds the signature to
 * the exact version, author, time, text and verification of the record.
 */
export function entryVisaContentHash(entry: Record<string, unknown>): string {
  const fields = [
    'id',
    'version',
    'author_id',
    'performed_at',
    'performed_at_source',
    'work_type_id',
    'site_id',
    'permit_id',
    'permit_number_raw',
    'event_type',
    'event_data',
    'text',
    'comment',
    'status',
    'verified_at',
    'verified_by',
  ];
  const payload: Record<string, unknown> = { schema: 'logbook.entry-visa.v1' };
  for (const field of fields) {
    payload[field] = entry[field] ?? null;
  }
  return sha256(stableStringify(payload));
}

/** Canonical hash of the entries covered by a shift handover. */
export function shiftEntriesHash(
  entries: Array<{
    id: string;
    version: number | string;
    hlc: string;
    journal_seq: number | string | null;
  }>,
): string {
  return sha256(
    stableStringify({
      schema: 'logbook.shift-entries.v1',
      entries: entries.map((entry) => ({
        id: entry.id,
        version: Number(entry.version),
        hlc: entry.hlc,
        journal_seq:
          entry.journal_seq === null ? null : Number(entry.journal_seq),
      })),
    }),
  );
}

/** Normalize DB timestamps/dates so hashes are stable across drivers. */
function iso(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

function dateOnly(value: unknown): string | null {
  const text = iso(value);
  return text ? text.slice(0, 10) : null;
}

/**
 * Handover content hash. Acceptance fields are intentionally excluded so the
 * outgoing signature stays valid after the incoming supervisor accepts.
 */
export function shiftHandoverContentHash(shift: Record<string, unknown>): string {
  const payload: Record<string, unknown> = {
    schema: 'logbook.shift-handover.v1',
    id: shift.id ?? null,
    journal_id: shift.journal_id ?? null,
    shift_date: dateOnly(shift.shift_date),
    period_start: iso(shift.period_start),
    period_end: iso(shift.period_end),
    handed_over_by: shift.handed_over_by ?? null,
    handed_over_at: iso(shift.handed_over_at),
    handover_comment: shift.handover_comment ?? null,
    entries_count: Number(shift.entries_count ?? 0),
    entries_hash: shift.entries_hash ?? null,
  };
  return sha256(stableStringify(payload));
}

/**
 * Acceptance content hash: binds the acceptance decision to the handover
 * snapshot, so the incoming signature covers exactly what was accepted.
 */
export function shiftAcceptanceContentHash(shift: Record<string, unknown>): string {
  const payload: Record<string, unknown> = {
    schema: 'logbook.shift-acceptance.v1',
    handover_hash: shiftHandoverContentHash(shift),
    status: shift.status ?? null,
    accepted_by: shift.accepted_by ?? null,
    accepted_at: iso(shift.accepted_at),
    acceptance_comment: shift.acceptance_comment ?? null,
  };
  return sha256(stableStringify(payload));
}

/** Current content hash for a shift version (1 = handover, 2 = acceptance). */
export function shiftContentHash(
  shift: Record<string, unknown>,
  version = Number(shift.version ?? 1),
): string {
  return version >= 2
    ? shiftAcceptanceContentHash(shift)
    : shiftHandoverContentHash(shift);
}
