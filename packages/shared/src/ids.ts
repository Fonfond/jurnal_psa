import type { UUID } from './types';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is UUID {
  return typeof value === 'string' && UUID_RE.test(value);
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * UUID v7: 48-bit Unix milliseconds + version + random.
 * Time-ordered at the millisecond level; suitable for client-generated IDs.
 */
export function uuidv7(nowMs: number = Date.now()): UUID {
  const bytes = randomBytes(16);
  let time = BigInt(Math.floor(nowMs));
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(time & 0xffn);
    time >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = toHex(bytes);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Fixed UUIDs used by deterministic seed data. */
export const SEED_UUIDS = {
  departmentMain: '01930000-0000-7000-8000-000000000001',
  departmentSecond: '01930000-0000-7000-8000-000000000002',
  worker: '01930000-0000-7000-8000-000000000101',
  supervisor: '01930000-0000-7000-8000-000000000102',
  admin: '01930000-0000-7000-8000-000000000103',
  deviceWorker: '01930000-0000-7000-8000-000000000201',
  deviceSupervisor: '01930000-0000-7000-8000-000000000202',
  deviceAdmin: '01930000-0000-7000-8000-000000000203',
  workTypePermit: '01930000-0000-7000-8000-000000000301',
  workTypeSimple: '01930000-0000-7000-8000-000000000302',
  workTypeHighRisk: '01930000-0000-7000-8000-000000000303',
  siteWorkshop: '01930000-0000-7000-8000-000000000401',
  siteField: '01930000-0000-7000-8000-000000000402',
  templatePermit: '01930000-0000-7000-8000-000000000501',
  templateSimple: '01930000-0000-7000-8000-000000000502',
  reasonLateEntry: '01930000-0000-7000-8000-000000000601',
  reasonCorrection: '01930000-0000-7000-8000-000000000602',
  reasonDelete: '01930000-0000-7000-8000-000000000603',
  permitActive: '01930000-0000-7000-8000-000000000701',
  permitClosed: '01930000-0000-7000-8000-000000000702',
  permitAnnulled: '01930000-0000-7000-8000-000000000703',
  entry1: '01930000-0000-7000-8000-000000000801',
  entry2: '01930000-0000-7000-8000-000000000802',
  entry3: '01930000-0000-7000-8000-000000000803',
  entry4: '01930000-0000-7000-8000-000000000804',
  entry5: '01930000-0000-7000-8000-000000000805',
  revision1: '01930000-0000-7000-8000-000000000901',
  journalMain: '01930000-0000-7000-8000-000000001001',
  journalSubstation: '01930000-0000-7000-8000-000000001002',
} as const;

/**
 * Default journal. Entries created without an explicit `journal_id` belong to
 * the primary operational journal; the server and the offline cache both fall
 * back to it (backward compatibility with pre-multi-journal clients).
 */
export const DEFAULT_JOURNAL_KEY = 'main';
export const DEFAULT_JOURNAL_ID = SEED_UUIDS.journalMain;

