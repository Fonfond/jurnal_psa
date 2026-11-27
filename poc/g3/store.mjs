// PoC G3 — in-memory sync store: push, idempotency, change_log. Not product code.
import { ChangeLog } from './change-log.mjs';
import { IdempotencyStore } from './idempotency.mjs';
import { applyOperation } from './merge.mjs';

export function createStore({ now = () => Date.now() } = {}) {
  const entries = new Map();
  const changeLog = new ChangeLog();
  const idempotency = new IdempotencyStore({ now });

  function applyOne(operation) {
    return idempotency.execute(operation.op_id, () => {
      const state = entries.get(operation.entry_id) ?? null;
      const outcome = applyOperation(state, operation);
      if ((outcome.result === 'applied' || outcome.result === 'conflict') && outcome.state) {
        entries.set(operation.entry_id, outcome.state);
        changeLog.append({
          entity_type: 'entry',
          entity_id: operation.entry_id,
          op: outcome.state.deleted ? 'delete' : 'upsert',
          version: outcome.state.version,
        });
      }
      return {
        op_id: operation.op_id,
        status: outcome.result,
        reason: outcome.reason ?? null,
        version: outcome.state?.version ?? null,
      };
    });
  }

  function push(operations) {
    const results = operations.map(applyOne);
    return {
      results,
      processed: results.length,
      duplicates: results.filter((result) => result.duplicate).length,
    };
  }

  function changes(sinceSeq = 0, limit = 100) {
    return changeLog.page(sinceSeq, limit);
  }

  function getEntry(id) {
    return entries.get(id) ?? null;
  }

  function snapshot() {
    return [...entries.entries()].map(([id, entry]) => ({ id, ...entry }));
  }

  return { push, changes, getEntry, snapshot, changeLog, idempotency, entries };
}
