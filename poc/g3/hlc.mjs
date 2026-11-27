// PoC G3 — HLC fixed width 13:5:8. Standalone prototype; not product code.
export const HLC_RE = /^(\d{13}):(\d{5}):([A-Za-z0-9_-]{8})$/;
export const MAX_DRIFT_MS = 5 * 60 * 1000;

export function formatHlc(ms, counter, node) {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 9_999_999_999_999) {
    throw new Error(`HLC ms out of range: ${ms}`);
  }
  if (!Number.isInteger(counter) || counter < 0 || counter > 99_999) {
    throw new Error(`HLC counter out of range: ${counter}`);
  }
  const nodePart = String(node ?? 'poc00001').padEnd(8, '0').slice(0, 8);
  if (!/^[A-Za-z0-9_-]{8}$/.test(nodePart)) {
    throw new Error(`Invalid HLC node: ${node}`);
  }
  return `${String(ms).padStart(13, '0')}:${String(counter).padStart(5, '0')}:${nodePart}`;
}

export function parseHlc(value) {
  const match = HLC_RE.exec(value);
  if (!match) {
    throw new Error(`Invalid HLC: ${value}`);
  }
  return { ms: Number(match[1]), counter: Number(match[2]), node: match[3] };
}

export function compareHlc(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Monotonic tick. A wall-clock jump > 5 minutes is recorded as `clock_anomaly`
 * and does not move the clock backwards.
 */
export function tick(prev, now = Date.now(), node = 'poc00001') {
  if (!prev) {
    return { value: formatHlc(now, 0, node), anomaly: false };
  }
  const parsed = parseHlc(prev);
  const driftMs = now - parsed.ms;
  const anomaly = Math.abs(driftMs) > MAX_DRIFT_MS;
  let ms = parsed.ms;
  let counter = parsed.counter;
  if (now > parsed.ms) {
    ms = now;
    counter = 0;
  } else {
    counter += 1;
    if (counter > 99_999) {
      ms += 1;
      counter = 0;
    }
  }
  return { value: formatHlc(ms, counter, node), anomaly, drift_ms: driftMs };
}

export function createHlc(node = 'poc00001') {
  let last = null;
  return {
    now(nowMs = Date.now()) {
      const result = tick(last, nowMs, node);
      last = result.value;
      return result;
    },
    get last() {
      return last;
    },
  };
}
