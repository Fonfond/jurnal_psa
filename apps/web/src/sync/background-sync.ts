import { getDeviceMeta, setDeviceMeta } from '../db/device-db';

/**
 * Background Sync / Periodic Sync registration (SYN-05, ADR-03).
 *
 * The service worker performs the actual outbox flush after the tab is closed.
 * The page only registers the tags; every capability is feature-detected and
 * the fallback is communicated honestly (iOS has neither Background Sync nor
 * Periodic Sync in standalone PWAs).
 */

export const BACKGROUND_SYNC_TAG = 'logbook-sync';
export const PERIODIC_SYNC_TAG = 'logbook-sync';
export const PERIODIC_SYNC_MIN_INTERVAL_MS = 15 * 60 * 1000;

export interface SyncRegistrationLike {
  sync?: { register(tag: string): Promise<void> };
  periodicSync?: {
    register(tag: string, options: { minInterval: number }): Promise<void>;
    unregister?(tag: string): Promise<void>;
  };
}

export interface SyncCapabilities {
  serviceWorker: boolean;
  backgroundSync: boolean;
  periodicSync: boolean;
  platform: 'ios' | 'other';
  message: string;
}

export function isIosLike(navigatorLike?: Navigator): boolean {
  if (!navigatorLike) {
    return false;
  }
  const agent = navigatorLike.userAgent ?? '';
  if (/iPad|iPhone|iPod/.test(agent)) {
    return true;
  }
  // iPadOS 13+ reports a desktop Safari user agent.
  return (
    (navigatorLike.platform === 'MacIntel' || agent.includes('Macintosh')) &&
    (navigatorLike.maxTouchPoints ?? 0) > 1
  );
}

export function detectSyncCapabilities(
  options: {
    registration?: SyncRegistrationLike | null;
    navigator?: Navigator;
  } = {},
): SyncCapabilities {
  const navigatorLike =
    options.navigator ??
    (typeof navigator === 'undefined' ? undefined : navigator);
  const registration = options.registration ?? null;
  const backgroundSync = Boolean(registration?.sync);
  const periodicSync = Boolean(registration?.periodicSync);
  const serviceWorker = Boolean(navigatorLike?.serviceWorker);
  const platform = isIosLike(navigatorLike) ? 'ios' : 'other';

  return {
    serviceWorker,
    backgroundSync,
    periodicSync,
    platform,
    message: syncCapabilitiesMessage({
      serviceWorker,
      backgroundSync,
      periodicSync,
      platform,
    }),
  };
}

export function syncCapabilitiesMessage(
  capabilities: Pick<
    SyncCapabilities,
    'backgroundSync' | 'periodicSync' | 'platform' | 'serviceWorker'
  >,
): string {
  if (!capabilities.serviceWorker) {
    return 'Service worker недоступен: синхронизация выполняется при открытой вкладке.';
  }
  if (capabilities.platform === 'ios') {
    return 'iOS не поддерживает Background Sync: очередь отправится при следующем открытии приложения.';
  }
  if (!capabilities.backgroundSync) {
    return 'Браузер не поддерживает Background Sync: очередь отправится при открытии вкладки.';
  }
  if (!capabilities.periodicSync) {
    return 'Background Sync включён; Periodic Sync недоступен — дополнительно работает таймер в приложении.';
  }
  return 'Фоновая и периодическая синхронизация включены: очередь отправится даже после закрытия вкладки.';
}

export interface BackgroundSyncRegistration {
  registered: boolean;
  periodic: boolean;
  capabilities: SyncCapabilities;
  error: string | null;
  at: string;
}

async function resolveRegistration(
  registration?: SyncRegistrationLike,
): Promise<SyncRegistrationLike | null> {
  if (registration) return registration;
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
    return null;
  }
  try {
    return (await navigator.serviceWorker.ready) as unknown as SyncRegistrationLike;
  } catch {
    return null;
  }
}

/**
 * Register both Background Sync and Periodic Sync tags. Never throws: the
 * result is stored on the device for the UI and for RUNBOOK diagnostics.
 */
export async function registerBackgroundSync(
  options: {
    registration?: SyncRegistrationLike;
    periodicMinIntervalMs?: number;
    now?: () => number;
    navigator?: Navigator;
    persist?: boolean;
  } = {},
): Promise<BackgroundSyncRegistration> {
  const now = options.now ?? (() => Date.now());
  const registration = await resolveRegistration(options.registration);
  const capabilities = detectSyncCapabilities({
    registration,
    navigator: options.navigator,
  });
  let registered = false;
  let periodic = false;
  let error: string | null = null;

  if (registration?.sync) {
    try {
      await registration.sync.register(BACKGROUND_SYNC_TAG);
      registered = true;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Background Sync недоступен';
    }
  }

  if (registration?.periodicSync) {
    try {
      await registration.periodicSync.register(PERIODIC_SYNC_TAG, {
        minInterval: options.periodicMinIntervalMs ?? PERIODIC_SYNC_MIN_INTERVAL_MS,
      });
      periodic = true;
    } catch (caught) {
      // Chrome rejects Periodic Sync on low site engagement; that is expected.
      error ??= caught instanceof Error ? caught.message : 'Periodic Sync недоступен';
    }
  }

  const result: BackgroundSyncRegistration = {
    registered,
    periodic,
    capabilities,
    error,
    at: new Date(now()).toISOString(),
  };
  if (options.persist !== false) {
    await setDeviceMeta('background_sync_status', JSON.stringify(result)).catch(
      () => undefined,
    );
  }
  return result;
}

export async function unregisterPeriodicSync(
  options: { registration?: SyncRegistrationLike } = {},
): Promise<void> {
  const registration = await resolveRegistration(options.registration);
  try {
    await registration?.periodicSync?.unregister?.(PERIODIC_SYNC_TAG);
  } catch {
    // Nothing to unregister.
  }
}

export async function readBackgroundSyncStatus(): Promise<BackgroundSyncRegistration | null> {
  const raw = await getDeviceMeta('background_sync_status');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BackgroundSyncRegistration;
  } catch {
    return null;
  }
}
