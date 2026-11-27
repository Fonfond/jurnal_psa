import {
  registerBackgroundSync,
  type BackgroundSyncRegistration,
} from './background-sync';
import type { SyncEngine, SyncSummary } from './engine';

export interface SyncTriggerOptions {
  intervalMs?: number;
  focusThrottleMs?: number;
  onResult?: (summary: SyncSummary) => void;
  onBackgroundSync?: (status: BackgroundSyncRegistration) => void;
}

/**
 * Starts the sync schedule:
 * app start, `online`, focus/visibility (≤ once per 30 s), 5-minute timer.
 *
 * Background Sync / Periodic Sync (SYN-05) are registered on start and on
 * `offline`, so the custom service worker flushes the outbox even when the tab
 * is closed. Where the API is unavailable (iOS) the timer + focus triggers are
 * the honest fallback and the capability message is surfaced to the UI.
 */
export function startSyncTriggers(
  engine: SyncEngine,
  options: SyncTriggerOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? 5 * 60 * 1000;
  const focusThrottleMs = options.focusThrottleMs ?? 30 * 1000;
  let lastFocusSync = 0;
  let disposed = false;

  const run = (): void => {
    if (disposed) return;
    void engine.syncNow().then((summary) => {
      options.onResult?.(summary);
    });
  };

  const register = (): void => {
    if (disposed) return;
    void registerBackgroundSync({ periodicMinIntervalMs: intervalMs }).then(
      (status) => options.onBackgroundSync?.(status),
    );
  };

  run();
  register();

  const onOnline = (): void => {
    register();
    run();
  };

  const onOffline = (): void => {
    // The browser queues the sync and fires it when connectivity returns.
    register();
  };

  const onFocus = (): void => {
    const now = Date.now();
    if (now - lastFocusSync < focusThrottleMs) {
      return;
    }
    lastFocusSync = now;
    run();
  };

  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') {
      onFocus();
    }
  };

  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisibility);
  const timer = window.setInterval(run, intervalMs);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const data = event.data as { type?: string } | null;
      if (data?.type === 'LOGBOOK_SYNC') {
        // The service worker pushed operations: pull the merged changes.
        run();
      }
    });
  }

  return () => {
    disposed = true;
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisibility);
    window.clearInterval(timer);
  };
}
