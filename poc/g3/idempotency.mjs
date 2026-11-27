// PoC G3 — op_id deduplication. Not product code.
export class IdempotencyStore {
  constructor({ ttlMs = 24 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.records = new Map();
  }

  get(opId) {
    const record = this.records.get(opId);
    if (!record) return null;
    if (this.now() - record.createdAt > this.ttlMs) {
      this.records.delete(opId);
      return null;
    }
    return record.result;
  }

  put(opId, result) {
    this.records.set(opId, { result, createdAt: this.now() });
  }

  execute(opId, fn) {
    const existing = this.get(opId);
    if (existing) {
      return { ...existing, duplicate: true };
    }
    const result = fn();
    this.put(opId, result);
    return { ...result, duplicate: false };
  }

  get size() {
    return this.records.size;
  }
}
