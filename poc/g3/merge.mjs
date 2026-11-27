// PoC G3 — minimal field merge for C-01..C-12. Not product code.
import { compareHlc } from './hlc.mjs';

export const FIELD_NAMES = [
  'text',
  'performed_at',
  'permit_id',
  'performed_at_source',
  'permit_risk_flag',
  'late_entry',
];

export function createEntry({
  id = 'e1',
  text = 'Начальный текст',
  performed_at = '2026-11-24T08:00:00.000Z',
  permit_id = null,
  performed_at_source = 'device_auto',
  permit_risk_flag = false,
  late_entry = false,
  author_id = 'u-author',
  hlc = '0000000000001:00000:poc00001',
  verified = false,
} = {}) {
  const clocks = {};
  for (const field of FIELD_NAMES) clocks[field] = hlc;
  return {
    id,
    fields: { text, performed_at, permit_id, performed_at_source, permit_risk_flag, late_entry },
    clocks,
    version: 1,
    updated_hlc: hlc,
    author_id,
    verified,
    verified_by: verified ? 'u-supervisor' : null,
    deleted: false,
    deleted_hlc: null,
    permit_status: 'active',
    conflicts: [],
    revisions: [],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function conflict(state, field, reason) {
  state.conflicts.push({ field, reason, resolution: 'pending' });
}

function reject(state, result, reason) {
  return { state, result: 'rejected', reason, changed: false };
}

function validate(fields) {
  if (typeof fields.text !== 'string' || fields.text.trim().length === 0) {
    return 'invalid:text';
  }
  if (fields.text.length > 2000) return 'invalid:text_too_long';
  return null;
}

function isPrivileged(actor) {
  return actor.role === 'supervisor' || actor.role === 'admin';
}

/**
 * Apply one operation to the current entry state.
 * Returns { state, result: applied|conflict|rejected|duplicate, changed, reason }.
 */
export function applyOperation(inputState, operation) {
  const state = clone(inputState);
  const op = operation;

  if (op.type === 'create') {
    if (state) {
      return { state, result: 'duplicate', changed: false, reason: 'C-07: entry already exists' };
    }
    const invalid = validate(op.fields);
    if (invalid) return { state, result: 'conflict', changed: false, reason: `C-10: ${invalid}` };
    const next = createEntry({
      ...op.fields,
      id: op.entry_id,
      author_id: op.actor.id,
      hlc: op.hlc,
      verified: false,
    });
    next.clocks = { ...next.clocks, ...(op.field_clocks ?? {}) };
    return { state: next, result: 'applied', changed: true };
  }

  if (!state) {
    return { state, result: 'rejected', changed: false, reason: 'entry not found' };
  }

  if (state.deleted) {
    const canRestore = op.type === 'update' && op.actor.role === 'admin';
    if (!canRestore) {
      return {
        state,
        result: 'conflict',
        changed: false,
        reason: 'C-06: restore is admin-only',
      };
    }
    if (compareHlc(op.hlc, state.deleted_hlc ?? state.updated_hlc) <= 0) {
      return { state, result: 'rejected', changed: false, reason: 'stale restore' };
    }
  }

  if (state.verified && !isPrivileged(op.actor)) {
    return {
      state,
      result: 'conflict',
      changed: false,
      reason: 'C-03: verified entry is editable by supervisor/admin only',
    };
  }

  if (op.type === 'delete') {
    if (state.verified && !isPrivileged(op.actor)) {
      return { state, result: 'conflict', changed: false, reason: 'C-03: verified delete denied' };
    }
    if (compareHlc(op.hlc, state.updated_hlc) < 0) {
      return { state, result: 'rejected', changed: false, reason: 'C-05: delete is older' };
    }
    state.revisions.push({
      field: '_entity',
      value: clone(state.fields),
      hlc: state.updated_hlc,
      lost: true,
      reason: 'C-05: delete wins',
    });
    state.deleted = true;
    state.deleted_hlc = op.hlc;
    state.updated_hlc = op.hlc;
    state.version += 1;
    return { state, result: 'applied', changed: true, reason: 'C-05: delete wins' };
  }

  if (op.type !== 'update') {
    return { state, result: 'rejected', changed: false, reason: 'unsupported op' };
  }

  if (state.deleted) {
    state.deleted = false;
    state.deleted_hlc = null;
  }

  if (state.permit_status === 'annulled' && op.fields.permit_id) {
    conflict(state, 'permit_status', 'C-09: permit annulled after offline edit');
    if (typeof op.fields.text === 'string') {
      state.fields.text = op.fields.text;
      state.clocks.text = op.field_clocks?.text ?? op.hlc;
    }
    state.fields.permit_risk_flag = true;
    state.fields.permit_risk_reason = 'permit_annulled_after_offline';
    state.version += 1;
    state.updated_hlc = op.hlc;
    return { state, result: 'conflict', changed: true, reason: 'C-09: saved with risk flag' };
  }

  const acceptedTime =
    state.fields.performed_at_source === 'server_corrected' &&
    op.fields.performed_at !== undefined &&
    !op.accept_server_time;

  if (acceptedTime) {
    conflict(state, 'performed_at', 'C-08: server correction requires consent');
    return { state, result: 'conflict', changed: false, reason: 'C-08: consent required' };
  }

  let changed = false;
  const next = clone(state);
  for (const field of FIELD_NAMES) {
    if (!(field in (op.fields ?? {}))) continue;
    const incomingClock = op.field_clocks?.[field] ?? op.hlc;
    const currentClock = next.clocks[field] ?? '0000000000000:00000:poc00001';
    const cmp = compareHlc(incomingClock, currentClock);
    if (cmp < 0) {
      next.revisions.push({ field, value: op.fields[field], hlc: incomingClock, lost: true });
      continue;
    }
    if (cmp === 0 && op.actor.id < next.author_id) {
      next.revisions.push({ field, value: op.fields[field], hlc: incomingClock, lost: true });
      continue;
    }
    next.fields[field] = op.fields[field];
    next.clocks[field] = incomingClock;
    changed = true;
  }

  if (!changed) {
    return { state: next, result: 'rejected', changed: false, reason: 'C-11: server is newer' };
  }

  if (op.accept_server_time && next.fields.performed_at_source === 'server_corrected') {
    next.fields.performed_at_source = 'manual';
  }

  const invalid = validate(next.fields);
  if (invalid) {
    return { state, result: 'conflict', changed: false, reason: `C-10: ${invalid}` };
  }

  next.version = state.version + 1;
  next.updated_hlc = op.hlc;
  if (next.fields.permit_risk_flag !== state.fields.permit_risk_flag) {
    // C-09 risk flag is written by the server path above; keep field merge honest.
  }
  return { state: next, result: 'applied', changed: true };
}

export function applyBatch(state, operations) {
  let current = state;
  const results = [];
  for (const operation of operations) {
    const outcome = applyOperation(current, operation);
    current = outcome.state;
    results.push({ op_id: operation.op_id, status: outcome.result, reason: outcome.reason });
  }
  return { state: current, results };
}
