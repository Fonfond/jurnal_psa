/// <reference lib="webworker" />
/**
 * Logbook service worker (SYN-05, ADR-03).
 *
 * Responsibilities:
 *  - cache the app shell / offline fallback (navigateFallback behaviour);
 *  - never cache `/v1/` responses (the client IndexedDB is the offline store);
 *  - flush the IndexedDB outbox on Background Sync and Periodic Sync even when
 *    every tab is closed, then ask open clients to pull changes.
 *
 * The manifest injected by vite-plugin-pwa (`self.__WB_MANIFEST`) is used as a
 * plain precache list, so no Workbox runtime is required in the bundle.
 */

import { flushOutboxInWorker, type SwFlushResult } from '../sync/sw-flush';

interface PrecacheEntry {
  url: string;
  revision: string | null;
}

interface SwScope {
  addEventListener(
    type: 'install' | 'activate' | 'fetch' | 'message' | 'sync' | 'periodicsync',
    listener: (event: Event) => void,
  ): void;
  skipWaiting(): Promise<void>;
  clients: {
    claim(): Promise<void>;
    matchAll(options?: { type?: string; includeUncontrolled?: boolean }): Promise<
      Array<{ postMessage(message: unknown): void }>
    >;
  };
}

interface ExtendableEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface TaggedEventLike extends ExtendableEventLike {
  tag: string;
}

interface MessageEventLike extends ExtendableEventLike {
  data?: unknown;
}

interface FetchEventLike extends ExtendableEventLike {
  request: Request;
  respondWith(response: Promise<Response> | Response): void;
}

declare const self: ServiceWorkerGlobalScope;

const scope = self as unknown as SwScope;

const PRECACHE_NAME = 'logbook-precache-v1';
const RUNTIME_NAME = 'logbook-runtime-v1';
const OFFLINE_URL = '/offline.html';
const API_PREFIX = '/v1/';
const SYNC_TAG = 'logbook-sync';

const PRECACHE_MANIFEST =
  (self as unknown as { __WB_MANIFEST?: PrecacheEntry[] }).__WB_MANIFEST ?? [];

scope.addEventListener('install', ((event: ExtendableEventLike) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE_NAME);
      const urls = new Set<string>([OFFLINE_URL]);
      for (const entry of PRECACHE_MANIFEST) {
        if (entry.url) urls.add(entry.url);
      }
      await Promise.all(
        [...urls].map((url) => cache.add(url).catch(() => undefined)),
      );
      await scope.skipWaiting();
    })(),
  );
}) as (event: Event) => void);

scope.addEventListener('activate', ((event: ExtendableEventLike) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([PRECACHE_NAME, RUNTIME_NAME]);
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => !keep.has(name)).map((name) => caches.delete(name)),
      );
      await scope.clients.claim();
    })(),
  );
}) as (event: Event) => void);

scope.addEventListener('fetch', ((event: FetchEventLike) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // API responses are never cached: offline state lives in IndexedDB.
  if (url.pathname.startsWith(API_PREFIX)) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }
  event.respondWith(handleAsset(request));
}) as (event: Event) => void);

async function handleNavigation(request: Request): Promise<Response> {
  try {
    return await fetch(request);
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    const shell = await caches.match('/index.html');
    if (shell) return shell;
    const offline = await caches.match(OFFLINE_URL);
    if (offline) return offline;
    return new Response('Офлайн', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function handleAsset(request: Request): Promise<Response> {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(RUNTIME_NAME);
      await cache.put(request, response.clone()).catch(() => undefined);
    }
    return response;
  } catch {
    const offline = await caches.match(OFFLINE_URL);
    return offline ?? new Response('', { status: 504 });
  }
}

async function notifyClients(message: unknown): Promise<void> {
  const clients = await scope.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  for (const client of clients) {
    client.postMessage(message);
  }
}

async function runBackgroundFlush(source: string): Promise<void> {
  const result: SwFlushResult = await flushOutboxInWorker();
  await notifyClients({ type: 'LOGBOOK_SW_FLUSHED', source, result });
  if (result.pushed > 0 || result.conflicts > 0) {
    // Ask an open tab to pull server changes / refresh conflicts.
    await notifyClients({ type: 'LOGBOOK_SYNC', source, result });
  }
  if (result.status === 'offline' || (result.status === 'error' && result.retryable)) {
    // Rejecting the sync event lets the browser retry with its own backoff.
    throw new Error(result.error ?? 'background sync failed');
  }
}

scope.addEventListener('sync', ((event: TaggedEventLike) => {
  if (event.tag !== SYNC_TAG) return;
  event.waitUntil(runBackgroundFlush('sync'));
}) as (event: Event) => void);

scope.addEventListener('periodicsync', ((event: TaggedEventLike) => {
  if (event.tag !== SYNC_TAG) return;
  event.waitUntil(runBackgroundFlush('periodicsync'));
}) as (event: Event) => void);

scope.addEventListener('message', ((event: MessageEventLike) => {
  const data = event.data as { type?: string } | null;
  if (data?.type === 'LOGBOOK_FLUSH') {
    event.waitUntil(runBackgroundFlush('message'));
  }
  if (data?.type === 'SKIP_WAITING') {
    event.waitUntil(scope.skipWaiting());
  }
}) as (event: Event) => void);

export {};
