import Dexie from 'dexie';
import type { ApiSession, ApiUser } from '../api/types';
import {
  deleteDeviceMeta,
  getDeviceMeta,
  setDeviceMeta,
} from '../db/device-db';
import { userDatabaseName } from '../db/user-db';

/**
 * Local unlock and offline session restore (AUTH-03 / REP-03).
 *
 * The PIN is never stored in clear text: only a PBKDF2-SHA256 verifier
 * (random 16-byte salt, 150 000 iterations) is kept in the device database.
 * The record lives next to the device identity, not in the per-user database,
 * so it survives `lock()` (the user database is closed) and is removed on
 * `logout()` together with the user data. IndexedDB itself is not encrypted
 * (ADR-20/SYN-03): the verifier protects the PIN value, not the journal.
 */

export const OFFLINE_SESSION_PREFIX = 'offline_session:';
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;
export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCKOUT_MS = 5 * 60 * 1000;
export const PIN_PBKDF2_ITERATIONS = 150_000;

export interface PinVerifier {
  algorithm: 'PBKDF2-SHA256';
  salt: string;
  iterations: number;
  hash: string;
}

export interface OfflineSessionRecord {
  version: 1;
  user: ApiUser;
  session: ApiSession;
  pin: PinVerifier | null;
  /** Lock survives a reload: the PIN is required before the cache is opened. */
  locked: boolean;
  failed_attempts: number;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
}

export type PinFailureReason =
  | 'no-pin'
  | 'wrong-pin'
  | 'locked-out'
  | 'expired'
  | 'not-found'
  | 'unsupported';

export interface PinSuccess {
  ok: true;
  record: OfflineSessionRecord;
}

export interface PinFailure {
  ok: false;
  reason: PinFailureReason;
  message: string;
  attempts_left?: number;
  locked_until?: string | null;
}

export type UnlockResult = PinSuccess | PinFailure;

const WEAK_PINS = new Set([
  '0000',
  '1111',
  '2222',
  '3333',
  '4444',
  '5555',
  '6666',
  '7777',
  '8888',
  '9999',
  '1234',
  '4321',
  '0123',
  '3210',
  '12345',
  '54321',
  '123456',
  '654321',
  '1234567',
  '7654321',
  '12345678',
  '87654321',
]);

export function isPinSupported(): boolean {
  return (
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle !== 'undefined' &&
    typeof crypto.getRandomValues === 'function'
  );
}

/** Returns a user-facing validation error, or `null` for a valid PIN. */
export function validatePin(pin: string): string | null {
  if (!new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`).test(pin)) {
    return `PIN — от ${PIN_MIN_LENGTH} до ${PIN_MAX_LENGTH} цифр`;
  }
  if (WEAK_PINS.has(pin)) {
    return 'Слишком простой PIN: выберите другой';
  }
  return null;
}

export function offlineSessionKey(userId: string): string {
  return `${OFFLINE_SESSION_PREFIX}${userId}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function derivePinHash(
  pin: string,
  salt: Uint8Array,
  iterations: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return bytesToBase64(new Uint8Array(bits));
}

function sameHash(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function parseRecord(raw: string | null): OfflineSessionRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as OfflineSessionRecord;
    if (!value || value.version !== 1 || !value.user?.id || !value.session) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export async function readOfflineSession(
  userId: string,
): Promise<OfflineSessionRecord | null> {
  return parseRecord(await getDeviceMeta(offlineSessionKey(userId)));
}

export async function writeOfflineSession(
  record: OfflineSessionRecord,
): Promise<void> {
  await setDeviceMeta(
    offlineSessionKey(record.user.id),
    JSON.stringify(record),
  );
}

export async function clearOfflineSession(userId: string): Promise<void> {
  await deleteDeviceMeta(offlineSessionKey(userId)).catch(() => undefined);
}

export async function lastOfflineUserId(): Promise<string | null> {
  return getDeviceMeta('last_user_id');
}

/**
 * Remember the account/session snapshot for offline restore. The PIN verifier
 * and lock state are preserved if they already exist.
 */
export async function rememberOfflineSession(
  user: ApiUser,
  session: ApiSession,
  now = Date.now(),
): Promise<OfflineSessionRecord> {
  const existing = await readOfflineSession(user.id);
  const record: OfflineSessionRecord = {
    version: 1,
    user,
    session,
    pin: existing?.pin ?? null,
    locked: existing?.locked ?? false,
    failed_attempts: existing?.failed_attempts ?? 0,
    locked_until: existing?.locked_until ?? null,
    created_at: existing?.created_at ?? new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
  };
  await writeOfflineSession(record);
  return record;
}

export async function markOfflineLocked(
  userId: string,
  locked: boolean,
  now = Date.now(),
): Promise<OfflineSessionRecord | null> {
  const record = await readOfflineSession(userId);
  if (!record) return null;
  const next: OfflineSessionRecord = {
    ...record,
    locked,
    failed_attempts: locked ? record.failed_attempts : 0,
    locked_until: locked ? record.locked_until : null,
    updated_at: new Date(now).toISOString(),
  };
  await writeOfflineSession(next);
  return next;
}

export async function setOfflinePin(
  userId: string,
  pin: string,
  now = Date.now(),
): Promise<OfflineSessionRecord> {
  const error = validatePin(pin);
  if (error) {
    throw new Error(error);
  }
  if (!isPinSupported()) {
    throw new Error('PIN недоступен: браузер не поддерживает WebCrypto');
  }
  const record = await readOfflineSession(userId);
  if (!record) {
    throw new Error('Профиль не сохранён на устройстве — войдите заново');
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePinHash(pin, salt, PIN_PBKDF2_ITERATIONS);
  const next: OfflineSessionRecord = {
    ...record,
    pin: {
      algorithm: 'PBKDF2-SHA256',
      salt: bytesToBase64(salt),
      iterations: PIN_PBKDF2_ITERATIONS,
      hash,
    },
    failed_attempts: 0,
    locked_until: null,
    updated_at: new Date(now).toISOString(),
  };
  await writeOfflineSession(next);
  return next;
}

export async function clearOfflinePin(userId: string, now = Date.now()): Promise<void> {
  const record = await readOfflineSession(userId);
  if (!record) return;
  await writeOfflineSession({
    ...record,
    pin: null,
    failed_attempts: 0,
    locked_until: null,
    updated_at: new Date(now).toISOString(),
  });
}

/** PIN configured for the account? */
export async function hasOfflinePin(userId: string): Promise<boolean> {
  return Boolean((await readOfflineSession(userId))?.pin);
}

export async function verifyOfflinePin(
  userId: string,
  pin: string,
  now = Date.now(),
): Promise<UnlockResult> {
  const record = await readOfflineSession(userId);
  if (!record) {
    return {
      ok: false,
      reason: 'not-found',
      message: 'Сохранённая сессия не найдена — войдите заново',
    };
  }
  if (Date.parse(record.session.offline_valid_until) <= now) {
    return {
      ok: false,
      reason: 'expired',
      message: 'Срок офлайн-сессии истёк — войдите при подключении к сети',
    };
  }
  if (!record.pin) {
    return {
      ok: false,
      reason: 'no-pin',
      message: 'PIN не задан — разблокировка доступна по паролю',
    };
  }
  if (record.locked_until && Date.parse(record.locked_until) > now) {
    return {
      ok: false,
      reason: 'locked-out',
      message: `Слишком много попыток. Повторите после ${new Date(
        record.locked_until,
      ).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`,
      attempts_left: 0,
      locked_until: record.locked_until,
    };
  }
  if (!isPinSupported()) {
    return {
      ok: false,
      reason: 'unsupported',
      message: 'PIN недоступен: браузер не поддерживает WebCrypto',
    };
  }

  const hash = await derivePinHash(
    pin,
    base64ToBytes(record.pin.salt),
    record.pin.iterations,
  );
  if (!sameHash(hash, record.pin.hash)) {
    const attempts = record.failed_attempts + 1;
    const lockedOut = attempts >= PIN_MAX_ATTEMPTS;
    const lockedUntil = lockedOut
      ? new Date(now + PIN_LOCKOUT_MS).toISOString()
      : record.locked_until;
    const next: OfflineSessionRecord = {
      ...record,
      failed_attempts: attempts,
      locked_until: lockedUntil,
      updated_at: new Date(now).toISOString(),
    };
    await writeOfflineSession(next);
    return {
      ok: false,
      reason: lockedOut ? 'locked-out' : 'wrong-pin',
      message: lockedOut
        ? `Слишком много попыток. Блокировка на ${
            PIN_LOCKOUT_MS / 60_000
          } минут`
        : `Неверный PIN. Осталось попыток: ${PIN_MAX_ATTEMPTS - attempts}`,
      attempts_left: Math.max(0, PIN_MAX_ATTEMPTS - attempts),
      locked_until: lockedUntil,
    };
  }

  const next: OfflineSessionRecord = {
    ...record,
    failed_attempts: 0,
    locked_until: null,
    updated_at: new Date(now).toISOString(),
  };
  await writeOfflineSession(next);
  return { ok: true, record: next };
}

export interface RestoredOfflineSession {
  record: OfflineSessionRecord;
  locked: boolean;
}

/**
 * Can the last account be restored without the network? Requires an unexpired
 * offline session and an existing per-user database (never creates an empty
 * one just for the login screen).
 */
export async function restoreOfflineSession(
  now = Date.now(),
): Promise<RestoredOfflineSession | null> {
  const userId = await lastOfflineUserId();
  if (!userId) return null;
  const record = await readOfflineSession(userId);
  if (!record) return null;
  if (Date.parse(record.session.offline_valid_until) <= now) {
    await clearOfflineSession(userId);
    return null;
  }
  if (!(await Dexie.exists(userDatabaseName(userId)))) {
    return null;
  }
  return { record, locked: record.locked };
}
