import { describe, expect, it, vi } from 'vitest';
import { getDeviceMeta } from '../db/device-db';
import {
  BACKGROUND_SYNC_TAG,
  PERIODIC_SYNC_TAG,
  detectSyncCapabilities,
  isIosLike,
  registerBackgroundSync,
  syncCapabilitiesMessage,
  unregisterPeriodicSync,
  type SyncRegistrationLike,
} from './background-sync';

function fakeNavigator(overrides: Partial<Navigator> = {}): Navigator {
  return {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    platform: 'Win32',
    maxTouchPoints: 0,
    serviceWorker: {},
    onLine: true,
    ...overrides,
  } as unknown as Navigator;
}

function fakeRegistration(overrides: Partial<SyncRegistrationLike> = {}): SyncRegistrationLike {
  return {
    sync: { register: vi.fn(async () => undefined) },
    periodicSync: {
      register: vi.fn(async () => undefined),
      unregister: vi.fn(async () => undefined),
    },
    ...overrides,
  };
}

describe('background sync registration (SYN-05)', () => {
  it('detects iOS, including iPadOS desktop user agents', () => {
    expect(isIosLike(fakeNavigator({ userAgent: 'iPhone; CPU iPhone OS 17_0' }))).toBe(
      true,
    );
    expect(
      isIosLike(
        fakeNavigator({
          userAgent: 'Macintosh; Intel Mac OS X 10_15_7',
          platform: 'MacIntel',
          maxTouchPoints: 5,
        }),
      ),
    ).toBe(true);
    expect(isIosLike(fakeNavigator())).toBe(false);
    expect(isIosLike(undefined)).toBe(false);
  });

  it('reports honest capabilities for a browser without Background Sync', () => {
    const capabilities = detectSyncCapabilities({
      registration: {},
      navigator: fakeNavigator(),
    });
    expect(capabilities.backgroundSync).toBe(false);
    expect(capabilities.periodicSync).toBe(false);
    expect(capabilities.platform).toBe('other');
    expect(capabilities.message).toContain('не поддерживает Background Sync');
    expect(capabilities.message).toContain('при открытии вкладки');
  });

  it('explains the iOS fallback instead of pretending to sync', () => {
    const capabilities = detectSyncCapabilities({
      registration: fakeRegistration(),
      navigator: fakeNavigator({
        userAgent: 'iPhone; CPU iPhone OS 17_0 like Mac OS X',
        platform: 'iPhone',
        maxTouchPoints: 5,
      }),
    });
    expect(capabilities.platform).toBe('ios');
    expect(capabilities.message).toContain('iOS не поддерживает Background Sync');
    expect(capabilities.message).toContain('следующем открытии');
  });

  it('describes the full capability set when both APIs exist', () => {
    const message = syncCapabilitiesMessage({
      serviceWorker: true,
      backgroundSync: true,
      periodicSync: true,
      platform: 'other',
    });
    expect(message).toContain('Фоновая и периодическая');
  });

  it('registers both tags and persists the capability status', async () => {
    const registration = fakeRegistration();

    const status = await registerBackgroundSync({
      registration,
      navigator: fakeNavigator(),
      now: () => Date.parse('2026-11-24T12:00:00.000Z'),
      periodicMinIntervalMs: 60_000,
    });

    expect(status.registered).toBe(true);
    expect(status.periodic).toBe(true);
    expect(status.error).toBeNull();
    expect(registration.sync?.register).toHaveBeenCalledWith(BACKGROUND_SYNC_TAG);
    expect(registration.periodicSync?.register).toHaveBeenCalledWith(
      PERIODIC_SYNC_TAG,
      { minInterval: 60_000 },
    );
    const stored = await getDeviceMeta('background_sync_status');
    expect(stored).toContain('"registered":true');
    expect(stored).toContain('"periodic":true');
  });

  it('tolerates a rejected Periodic Sync and keeps Background Sync', async () => {
    const registration = fakeRegistration({
      periodicSync: {
        register: vi.fn(async () => {
          throw new Error('Periodic Sync requires site engagement');
        }),
      },
    });

    const status = await registerBackgroundSync({
      registration,
      navigator: fakeNavigator(),
      persist: false,
    });

    expect(status.registered).toBe(true);
    expect(status.periodic).toBe(false);
    expect(status.error).toContain('site engagement');
  });

  it('does nothing when the service worker is unavailable', async () => {
    const status = await registerBackgroundSync({
      registration: undefined,
      navigator: fakeNavigator({ serviceWorker: undefined }),
      persist: false,
    });
    expect(status.registered).toBe(false);
    expect(status.periodic).toBe(false);
    expect(status.capabilities.serviceWorker).toBe(false);
    expect(status.capabilities.message).toContain('Service worker недоступен');
  });

  it('unregisters the periodic tag without throwing', async () => {
    const registration = fakeRegistration();
    await unregisterPeriodicSync({ registration });
    expect(registration.periodicSync?.unregister).toHaveBeenCalledWith(
      PERIODIC_SYNC_TAG,
    );
  });
});
