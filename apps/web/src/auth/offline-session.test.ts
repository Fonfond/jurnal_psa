import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiSession, ApiUser } from '../api/types';
import {
  activateUserDatabase,
  userDatabaseName,
} from '../db/user-db';
import {
  PIN_MAX_ATTEMPTS,
  OFFLINE_SESSION_PREFIX,
  clearOfflinePin,
  clearOfflineSession,
  hasOfflinePin,
  isPinSupported,
  lastOfflineUserId,
  offlineSessionKey,
  readOfflineSession,
  rememberOfflineSession,
  restoreOfflineSession,
  setOfflinePin,
  validatePin,
  verifyOfflinePin,
} from './offline-session';
import { getDeviceMeta, setDeviceMeta } from '../db/device-db';

const user: ApiUser = {
  id: '01930000-0000-7000-8000-000000000101',
  full_name: 'Иван Петров',
  role: 'worker',
  department: { id: '01930000-0000-7000-8000-000000000001', name: 'Участок №3' },
  status: 'active',
  email: 'worker@logbook.local',
};

const NOW = Date.parse('2026-11-25T10:00:00.000Z');

function session(validUntil = '2026-12-25T10:00:00.000Z'): ApiSession {
  return {
    offline_valid_until: validUntil,
    refresh_expires_at: validUntil,
  };
}

async function seedRecord(validUntil?: string): Promise<void> {
  await activateUserDatabase(user.id);
  await rememberOfflineSession(user, session(validUntil), NOW);
}

beforeEach(() => {
  // Fake IndexedDB is reset by the shared test setup after every test.
});

describe('offline PIN verifier (AUTH-03)', () => {
  it('is supported and validates PIN format', () => {
    expect(isPinSupported()).toBe(true);
    expect(validatePin('2468')).toBeNull();
    expect(validatePin('123')).toContain('4');
    expect(validatePin('123456789')).toContain('8');
    expect(validatePin('abcd')).not.toBeNull();
    expect(validatePin('1234')).toContain('простой');
    expect(validatePin('1111')).toContain('простой');
  });

  it('stores only a salted PBKDF2 hash, never the PIN itself', async () => {
    await seedRecord();
    const record = await setOfflinePin(user.id, '2468', NOW);

    expect(record.pin).toMatchObject({
      algorithm: 'PBKDF2-SHA256',
      iterations: 150_000,
    });
    expect(record.pin?.salt).toEqual(expect.any(String));
    expect(record.pin?.hash).toEqual(expect.any(String));

    const raw = await getDeviceMeta(offlineSessionKey(user.id));
    expect(raw).not.toContain('2468');
    expect(raw).toContain('PBKDF2-SHA256');
    expect(await hasOfflinePin(user.id)).toBe(true);
  });

  it('unlocks with the right PIN and limits wrong attempts', async () => {
    await seedRecord();
    await setOfflinePin(user.id, '2468', NOW);

    const wrong = await verifyOfflinePin(user.id, '1357', NOW);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.reason).toBe('wrong-pin');
      expect(wrong.attempts_left).toBe(PIN_MAX_ATTEMPTS - 1);
    }

    for (let attempt = 2; attempt < PIN_MAX_ATTEMPTS; attempt += 1) {
      const result = await verifyOfflinePin(user.id, '1357', NOW);
      expect(result.ok).toBe(false);
    }
    const locked = await verifyOfflinePin(user.id, '1357', NOW);
    expect(locked.ok).toBe(false);
    if (!locked.ok) {
      expect(locked.reason).toBe('locked-out');
      expect(locked.attempts_left).toBe(0);
      expect(locked.locked_until).toEqual(expect.any(String));
    }

    // Correct PIN is refused while the lockout is active…
    const during = await verifyOfflinePin(user.id, '2468', NOW);
    expect(during.ok).toBe(false);

    // …and accepted after five minutes.
    const after = await verifyOfflinePin(user.id, '2468', NOW + 5 * 60 * 1000 + 1);
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.record.failed_attempts).toBe(0);
      expect(after.record.locked_until).toBeNull();
    }
  });

  it('rejects weak PINs and PIN setup without a cached profile', async () => {
    await expect(setOfflinePin(user.id, '2468')).rejects.toThrow(
      'Профиль не сохранён',
    );
    await seedRecord();
    await expect(setOfflinePin(user.id, '1234')).rejects.toThrow('простой');
  });

  it('keeps lock state and clears the PIN/record explicitly', async () => {
    await seedRecord();
    await setOfflinePin(user.id, '2468', NOW);

    expect((await readOfflineSession(user.id))?.locked).toBe(false);
    await rememberOfflineSession(user, session(), NOW);
    expect((await readOfflineSession(user.id))?.pin).not.toBeNull();

    await clearOfflinePin(user.id);
    expect(await hasOfflinePin(user.id)).toBe(false);
    const noPin = await verifyOfflinePin(user.id, '2468', NOW);
    expect(noPin.ok).toBe(false);
    if (!noPin.ok) expect(noPin.reason).toBe('no-pin');

    await setOfflinePin(user.id, '2468', NOW);
    await clearOfflineSession(user.id);
    expect(await getDeviceMeta(offlineSessionKey(user.id))).toBeNull();
  });

  it('expires the offline session and never creates an empty user database', async () => {
    await seedRecord('2026-11-24T10:00:00.000Z');
    expect(await restoreOfflineSession(NOW)).toBeNull();

    await seedRecord();
    const valid = await restoreOfflineSession(NOW);
    expect(valid?.record.user.id).toBe(user.id);
    expect(valid?.locked).toBe(false);

    // A record without a per-user database (e.g. cleared user data) is not
    // restorable and must not silently create an empty database.
    await setDeviceMeta('last_user_id', '01930000-0000-7000-8000-000000000102');
    expect(
      await restoreOfflineSession(NOW),
    ).toBeNull();
  });

  it('uses last_user_id for restore and keeps the key format stable', async () => {
    await seedRecord();
    await setOfflinePin(user.id, '2468', NOW);
    expect(await lastOfflineUserId()).toBe(user.id);
    expect(offlineSessionKey(user.id)).toBe(
      `${OFFLINE_SESSION_PREFIX}${user.id}`,
    );
    expect(userDatabaseName(user.id)).toBe(`logbook:user:${user.id}`);
    expect(await restoreOfflineSession(NOW)).not.toBeNull();
  });
});
