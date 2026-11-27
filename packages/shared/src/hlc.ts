import type { Hlc } from './types';

export type { Hlc };

export const HLC_PHYSICAL_DIGITS = 13;
export const HLC_COUNTER_DIGITS = 5;
export const HLC_NODE_LENGTH = 8;
export const HLC_MAX_COUNTER = 99_999;

export const HLC_RE = /^(\d{13}):(\d{5}):([A-Za-z0-9_-]{8})$/;

export interface HlcParts {
  physical: number;
  counter: number;
  node: string;
}

export function isHlc(value: unknown): value is Hlc {
  return typeof value === 'string' && HLC_RE.test(value);
}

export function assertNode(node: string): void {
  if (!new RegExp(`^[A-Za-z0-9_-]{${HLC_NODE_LENGTH}}$`).test(node)) {
    throw new Error(`HLC node must be ${HLC_NODE_LENGTH} chars [A-Za-z0-9_-]`);
  }
}

export function formatHlc(physicalMs: number, counter: number, node: string): Hlc {
  if (!Number.isInteger(physicalMs) || physicalMs < 0) {
    throw new Error('HLC physical time must be a non-negative integer');
  }
  if (!Number.isInteger(counter) || counter < 0 || counter > HLC_MAX_COUNTER) {
    throw new Error(`HLC counter must be 0..${HLC_MAX_COUNTER}`);
  }
  assertNode(node);
  const ms = String(physicalMs).padStart(HLC_PHYSICAL_DIGITS, '0');
  const c = String(counter).padStart(HLC_COUNTER_DIGITS, '0');
  if (ms.length !== HLC_PHYSICAL_DIGITS) {
    throw new Error('HLC physical time exceeds 13 digits');
  }
  return `${ms}:${c}:${node}`;
}

export function parseHlc(value: string): HlcParts {
  const match = HLC_RE.exec(value);
  if (!match) {
    throw new Error(`Invalid HLC value: ${value}`);
  }
  return {
    physical: Number(match[1]),
    counter: Number(match[2]),
    node: match[3],
  };
}

/** Lexicographic order of valid HLC strings equals chronological order. */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a === b) {
    return 0;
  }
  const left = parseHlc(a);
  const right = parseHlc(b);
  if (left.physical !== right.physical) {
    return left.physical < right.physical ? -1 : 1;
  }
  if (left.counter !== right.counter) {
    return left.counter < right.counter ? -1 : 1;
  }
  return left.node < right.node ? -1 : left.node > right.node ? 1 : 0;
}

export function maxHlc(values: Array<Hlc | null | undefined>): Hlc | null {
  let result: Hlc | null = null;
  for (const value of values) {
    if (!value || !isHlc(value)) {
      continue;
    }
    if (result === null || compareHlc(value, result) > 0) {
      result = value;
    }
  }
  return result;
}

/**
 * Generates the next HLC for a local event.
 * Physical time never moves backwards; equal physical time increments the counter.
 */
export function nextHlc(
  previous: Hlc | null | undefined,
  nowMs: number = Date.now(),
  node = 'node0001',
): Hlc {
  const prev = previous && isHlc(previous) ? parseHlc(previous) : null;
  const physical = Math.max(Math.floor(nowMs), prev?.physical ?? 0);
  let counter = physical === prev?.physical ? (prev?.counter ?? 0) + 1 : 0;
  let nextPhysical = physical;
  if (counter > HLC_MAX_COUNTER) {
    nextPhysical += 1;
    counter = 0;
  }
  return formatHlc(nextPhysical, counter, node);
}

/** Compares two HLC strings; returns the later one. */
export function laterHlc(a: Hlc, b: Hlc): Hlc {
  return compareHlc(a, b) >= 0 ? a : b;
}
