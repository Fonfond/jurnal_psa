// PoC G3 — append-only change log with monotonic seq. Not product code.
export class ChangeLog {
  constructor() {
    this.seq = 0;
    this.rows = [];
  }

  append({ entity_type = 'entry', entity_id, op = 'upsert', version = 1 }) {
    this.seq += 1;
    const row = {
      seq: this.seq,
      entity_type,
      entity_id,
      op,
      version,
      changed_at: new Date().toISOString(),
    };
    this.rows.push(row);
    return row;
  }

  page(sinceSeq = 0, limit = 100) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 1000));
    const filtered = this.rows.filter((row) => row.seq > sinceSeq);
    const slice = filtered.slice(0, safeLimit);
    return {
      changes: slice,
      next_seq: slice.length > 0 ? slice[slice.length - 1].seq : sinceSeq,
      has_more: filtered.length > slice.length,
    };
  }

  get size() {
    return this.rows.length;
  }
}
