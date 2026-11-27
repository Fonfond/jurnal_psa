import Dexie from 'dexie';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../api/client';
import type { ApiSession, ApiUser, MeResponse } from '../api/types';
import { createLocalEntry } from '../db/repositories';
import { getDeviceMeta } from '../db/device-db';
import { closeActiveDatabase, userDatabaseName } from '../db/user-db';
import {
  writeOfflineSession,
  type OfflineSessionRecord,
} from '../auth/offline-session';
import { useAuthStore } from './auth';

const user: ApiUser = {
  id: '01930000-0000-7000-8000-000000000101',
  full_name: 'Иван Петров',
  role: 'worker',
  department: { id: '01930000-0000-7000-8000-000000000001', name: 'Участок №3' },
  status: 'active',
  email: 'worker@logbook.local',
};

const other: ApiUser = {
  ...user,
  id: '01930000-0000-7000-8000-000000000102',
  full_name: 'Петров Пётр Петрович',
  role: 'supervisor',
  email: 'supervisor@logbook.local',
};

const input = {
  performed_at: '2026-11-25T08:00:00.000Z',
  performed_tz_offset_min: 480,
  work_type_id: '01930000-0000-7000-8000-000000000302',
  site_id: '01930000-0000-7000-8000-000000000402',
  permit_id: null,
  text: 'Проверил оборудование на участке',
  input_method: 'manual' as const,
};

function session(): ApiSession {
  return {
    offline_valid_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    refresh_expires_at: new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    ).toISOString(),
  };
}

function meResponse(account: ApiUser = user): MeResponse {
  return {
    user: account,
    session: session(),
    signature: undefined,
    features: {
      voice: false,
      web_speech: false,
      attachments: false,
      supervisor_cache: false,
    },
  };
}

function resetStore(): void {
  useAuthStore.setState({
    user: null,
    session: null,
    loading: false,
    initialized: false,
    error: null,
    locked: false,
    offline: false,
    pinConfigured: false,
    signature: null,
    features: null,
  });
}

beforeEach(() => {
  resetStore();
  vi.restoreAllMocks();
  vi.spyOn(api, 'logout').mockResolvedValue();
  vi.spyOn(api, 'login').mockResolvedValue({
    user,
    session: session(),
    csrf_token: 'csrf-token',
  });
  vi.spyOn(api, 'me').mockResolvedValue(meResponse());
});

async function loginAs(account: ApiUser = user): Promise<void> {
  vi.mocked(api.login).mockResolvedValue({
    user: account,
    session: session(),
    csrf_token: 'csrf-token',
  });
  vi.mocked(api.me).mockResolvedValue(meResponse(account));
  await useAuthStore.getState().login(account.email ?? 'worker@logbook.local', 'pw');
}

function simulateReload(): void {
  resetStore();
}

describe('AUTH-03: PIN lock and offline session restore', () => {
  it('locks, keeps local data and unlocks with the PIN offline', async () => {
    await loginAs();
    await useAuthStore.getState().setPin('2468');
    expect(useAuthStore.getState().pinConfigured).toBe(true);

    await useAuthStore.getState().lock();

    expect(useAuthStore.getState()).toMatchObject({
      user: null,
      locked: true,
      pinConfigured: true,
    });
    expect(await Dexie.exists(userDatabaseName(user.id))).toBe(true);

    const result = await useAuthStore.getState().unlockWithPin('2468');

    expect(result.ok).toBe(true);
    expect(useAuthStore.getState()).toMatchObject({
      user: { id: user.id },
      locked: false,
    });
    const entry = await createLocalEntry(input, user);
    expect(entry.author_id).toBe(user.id);
  });

  it('rejects a wrong PIN and locks the unlock for five minutes', async () => {
    await loginAs();
    await useAuthStore.getState().setPin('2468');
    await useAuthStore.getState().lock();
    const now = Date.now();

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await useAuthStore
        .getState()
        .unlockWithPin('1357', now);
      expect(result.ok).toBe(false);
    }
    const lockedOut = await useAuthStore.getState().unlockWithPin('1357', now);
    expect(lockedOut.ok).toBe(false);
    if (!lockedOut.ok) {
      expect(lockedOut.reason).toBe('locked-out');
      expect(useAuthStore.getState().error).toContain('Слишком много попыток');
    }

    const stillLocked = await useAuthStore
      .getState()
      .unlockWithPin('2468', now);
    expect(stillLocked.ok).toBe(false);

    const unlocked = await useAuthStore
      .getState()
      .unlockWithPin('2468', now + 5 * 60 * 1000 + 1);
    expect(unlocked.ok).toBe(true);
    expect(useAuthStore.getState().user?.id).toBe(user.id);
  });

  it('restores the offline session after a reload without network', async () => {
    await loginAs();
    await closeActiveDatabase();
    simulateReload();
    vi.mocked(api.me).mockRejectedValue(
      new ApiError(0, 'E-NET-01', 'Нет соединения'),
    );

    await useAuthStore.getState().loadMe();

    expect(useAuthStore.getState()).toMatchObject({
      user: { id: user.id, role: 'worker' },
      offline: true,
      locked: false,
      initialized: true,
    });
    const entry = await createLocalEntry(input, user);
    expect(entry.sync_status).toBe('pending');
  });

  it('requires the PIN after reload when the session was locked', async () => {
    await loginAs();
    await useAuthStore.getState().setPin('2468');
    await useAuthStore.getState().lock();
    simulateReload();
    vi.mocked(api.me).mockRejectedValue(
      new ApiError(0, 'E-NET-01', 'Нет соединения'),
    );

    await useAuthStore.getState().loadMe();

    expect(useAuthStore.getState()).toMatchObject({
      user: null,
      locked: true,
      offline: true,
      pinConfigured: true,
      initialized: true,
    });
    const result = await useAuthStore.getState().unlockWithPin('2468');
    expect(result.ok).toBe(true);
    expect(useAuthStore.getState().user?.id).toBe(user.id);
  });

  it('clears the PIN and offline session on logout (user switch)', async () => {
    await loginAs(user);
    await useAuthStore.getState().setPin('2468');
    await useAuthStore.getState().logout();

    expect(await Dexie.exists(userDatabaseName(user.id))).toBe(false);
    expect(await getDeviceMeta(`offline_session:${user.id}`)).toBeNull();
    expect(useAuthStore.getState().pinConfigured).toBe(false);

    await loginAs(other);
    simulateReload();
    vi.mocked(api.me).mockRejectedValue(
      new ApiError(0, 'E-NET-01', 'Нет соединения'),
    );
    await useAuthStore.getState().loadMe();

    expect(useAuthStore.getState().user?.id).toBe(other.id);
    expect(await getDeviceMeta(`offline_session:${user.id}`)).toBeNull();
  });

  it('does not restore an expired offline session and clears it', async () => {
    await loginAs();
    const stored = await getDeviceMeta(`offline_session:${user.id}`);
    const record = JSON.parse(stored ?? '{}') as OfflineSessionRecord;
    await writeOfflineSession({
      ...record,
      session: {
        offline_valid_until: '2020-01-01T00:00:00.000Z',
        refresh_expires_at: '2020-01-01T00:00:00.000Z',
      },
    });
    simulateReload();
    vi.mocked(api.me).mockRejectedValue(
      new ApiError(0, 'E-NET-01', 'Нет соединения'),
    );

    await useAuthStore.getState().loadMe();

    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().initialized).toBe(true);
    expect(useAuthStore.getState().error).toContain('Офлайн-сессия');
    expect(await getDeviceMeta(`offline_session:${user.id}`)).toBeNull();
  });

  it('asks for a password when no PIN was configured before locking', async () => {
    await loginAs();
    await useAuthStore.getState().lock();
    simulateReload();
    vi.mocked(api.me).mockRejectedValue(
      new ApiError(0, 'E-NET-01', 'Нет соединения'),
    );

    await useAuthStore.getState().loadMe();

    expect(useAuthStore.getState()).toMatchObject({
      locked: true,
      pinConfigured: false,
      user: null,
    });
    const result = await useAuthStore.getState().unlockWithPin('2468');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no-pin');
    }

  });
});
