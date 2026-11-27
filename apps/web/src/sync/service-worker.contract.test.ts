import { describe, expect, it } from 'vitest';
import serviceWorkerSource from '../sw/service-worker.ts?raw';

/**
 * Contract test for the custom service worker (SYN-05, ADR-03).
 * The worker itself runs in a browser, so the build-time source is asserted:
 * Background Sync / Periodic Sync handlers, offline shell caching, no API
 * caching and the shared outbox flush implementation.
 */
describe('custom service worker contract', () => {
  it('handles Background Sync and Periodic Sync for the logbook tag', () => {
    expect(serviceWorkerSource).toContain("addEventListener('sync'");
    expect(serviceWorkerSource).toContain("addEventListener('periodicsync'");
    expect(serviceWorkerSource).toContain("const SYNC_TAG = 'logbook-sync'");
    expect(serviceWorkerSource).toContain('runBackgroundFlush');
  });

  it('flushes the outbox through the shared worker implementation', () => {
    expect(serviceWorkerSource).toContain(
      "from '../sync/sw-flush'",
    );
    expect(serviceWorkerSource).toContain('flushOutboxInWorker()');
    expect(serviceWorkerSource).toContain("type: 'LOGBOOK_SW_FLUSHED'");
    expect(serviceWorkerSource).toContain("type: 'LOGBOOK_SYNC'");
  });

  it('precaches the shell, keeps the offline fallback and never caches the API', () => {
    expect(serviceWorkerSource).toContain('self.__WB_MANIFEST');
    expect(serviceWorkerSource).toContain('/offline.html');
    expect(serviceWorkerSource).toContain("startsWith(API_PREFIX)");
    expect(serviceWorkerSource).toContain("const API_PREFIX = '/v1/'");
  });

  it('retries the sync event when the flush is offline or failed', () => {
    expect(serviceWorkerSource).toContain("result.status === 'offline'");
    expect(serviceWorkerSource).toContain('result.retryable');
    expect(serviceWorkerSource).toContain('throw new Error');
  });
});
