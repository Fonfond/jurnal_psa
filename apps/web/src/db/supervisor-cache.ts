import Dexie from 'dexie';
import type { JournalReview, Role } from '@logbook/shared';
import type { EntriesResponse } from '../api/types';
import {
  applyJournalReviews,
  applyServerEntry,
  getMeta,
  listLocalJournals,
  setMeta,
} from './repositories';
import { db, type ClientJournalEntry } from './schema';

/**
 * Role-dependent supervisor cache (ADR-16, SYN-02, OQ-21).
 *
 * A supervisor needs the department journal offline on site, but caching the
 * whole history would blow both the privacy and the storage budget. The cache
 * is therefore scoped to the last 7 days per journal, kept inside the
 * supervisor's own per-user IndexedDB and capped by a 10–20 MB budget
 * (15 MiB by default, shared between journals of the user).
 */

export const SUPERVISOR_CACHE_DAYS = 7;
export const SUPERVISOR_CACHE_BUDGET_BYTES = 15 * 1024 * 1024;
export const SUPERVISOR_CACHE_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const SUPERVISOR_CACHE_MAX_ENTRIES_PER_JOURNAL = 3000;
export const SUPERVISOR_CACHE_PAGE_SIZE = 100;
export const SUPERVISOR_CACHE_MAX_PAGES = 30;

export interface SupervisorCacheApi {
  entries(params: {
    from?: string;
    to?: string;
    cursor?: string;
    limit?: number;
    journal_id?: string;
  }): Promise<EntriesResponse>;
  reviews?(params: {
    from?: string;
    to?: string;
    journal_id?: string;
    limit?: number;
  }): Promise<{ items: JournalReview[] }>;
}

export interface SupervisorCacheUser {
  id: string;
  role: Role;
}

export interface JournalCacheStatus {
  journal_id: string;
  entries: number;
  reviews: number;
  bytes: number;
  window_from: string;
  window_to: string;
  updated_at: string;
}

export interface SupervisorCacheStatus {
  enabled: boolean;
  refreshed: boolean;
  reason: 'ok' | 'disabled' | 'throttled' | 'empty';
  window_days: number;
  budget_bytes: number;
  entries: number;
  bytes: number;
  updated_at: string | null;
  journals: JournalCacheStatus[];
}

export function isSupervisorCacheRole(role: Role | string | undefined): boolean {
  return role === 'supervisor' || role === 'admin';
}

/** The server `features.supervisor_cache` flag is authoritative when present. */
export function supervisorCacheEnabled(
  user: SupervisorCacheUser | null | undefined,
  featureFlag?: boolean,
): boolean {
  if (!user) return false;
  if (featureFlag === false) return false;
  return isSupervisorCacheRole(user.role);
}

export function byteLength(value: unknown): number {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(json).length;
  }
  return json.length;
}

export interface CacheWindow {
  /** ISO timestamp sent to the API. */
  from: string;
  to: string;
  /** date-only values used by the reviews endpoint. */
  fromDate: string;
  toDate: string;
}

export function cacheWindow(nowMs: number, days = SUPERVISOR_CACHE_DAYS): CacheWindow {
  const to = new Date(nowMs);
  const from = new Date(nowMs - days * 24 * 60 * 60 * 1000);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    fromDate: from.toISOString().slice(0, 10),
    toDate: to.toISOString().slice(0, 10),
  };
}

export async function readSupervisorCacheStatus(
  nowMs = Date.now(),
  budgetBytes = SUPERVISOR_CACHE_BUDGET_BYTES,
): Promise<SupervisorCacheStatus> {
  const window = cacheWindow(nowMs);
  const rows = await db.supervisor_cache.toArray();
  const reviewCounts = new Map<string, number>();
  const reviews = await db.journal_reviews.toArray();
  for (const review of reviews) {
    const journalId = review.journal_id ?? 'main';
    reviewCounts.set(journalId, (reviewCounts.get(journalId) ?? 0) + 1);
  }
  const journals: JournalCacheStatus[] = rows
    .filter((row) => row.window_to >= window.from)
    .map((row) => ({
      journal_id: row.journal_id,
      entries: row.entries,
      reviews: reviewCounts.get(row.journal_id) ?? 0,
      bytes: row.bytes,
      window_from: row.window_from,
      window_to: row.window_to,
      updated_at: row.updated_at,
    }))
    .sort((left, right) => left.journal_id.localeCompare(right.journal_id));

  const entries = journals.reduce((sum, journal) => sum + journal.entries, 0);
  const bytes = journals.reduce((sum, journal) => sum + journal.bytes, 0);
  const updatedAt = journals.reduce<string | null>(
    (latest, journal) =>
      !latest || journal.updated_at > latest ? journal.updated_at : latest,
    null,
  );

  return {
    enabled: journals.length > 0,
    refreshed: false,
    reason: journals.length > 0 ? 'ok' : 'empty',
    window_days: SUPERVISOR_CACHE_DAYS,
    budget_bytes: budgetBytes,
    entries,
    bytes,
    updated_at: updatedAt,
    journals,
  };
}

/**
 * Drop cached entries that fall out of the cache window or exceed the
 * per-journal budget. Entries authored (or edited) by the supervisor and
 * entries with a pending outbox operation are never evicted: they are local
 * working data, not a remote copy.
 */
export async function evictJournalCache(
  journalId: string,
  userId: string,
  windowFrom: string,
  budgetBytes: number,
): Promise<number> {
  const all = await db.entries
    .where('[journal_id+performed_at]')
    .between([journalId, Dexie.minKey], [journalId, Dexie.maxKey])
    .toArray();

  const removable = all.filter(
    (entry) =>
      entry.author_id !== userId &&
      (entry.sync_status ?? 'synced') === 'synced' &&
      entry.status === 'active',
  );
  const fresh = removable.filter((entry) => entry.performed_at >= windowFrom);
  const stale = removable.filter((entry) => entry.performed_at < windowFrom);

  const evicted: string[] = stale.map((entry) => entry.id);
  let remainingBytes = fresh.reduce(
    (sum, entry) => sum + byteLength(entry),
    0,
  );
  const byAge = [...fresh].sort((left, right) =>
    left.performed_at.localeCompare(right.performed_at),
  );
  for (const entry of byAge) {
    if (remainingBytes <= budgetBytes) break;
    evicted.push(entry.id);
    remainingBytes -= byteLength(entry);
  }

  if (evicted.length > 0) {
    await db.transaction('rw', db.entries, db.revisions, db.outbox, async () => {
      for (const id of evicted) {
        const pending = await db.outbox.where('entity_id').equals(id).count();
        if (pending > 0) continue;
        await db.revisions.where('entry_id').equals(id).delete();
        await db.entries.delete(id);
      }
    });
  }

  return evicted.length;
}

export interface RefreshOptions {
  force?: boolean;
  now?: () => number;
  budgetBytes?: number;
  featureFlag?: boolean;
  api: SupervisorCacheApi;
  user: SupervisorCacheUser;
}

/**
 * Refresh the supervisor cache for every journal available on the device.
 * Throttled to once per 6 hours unless `force` is set; every journal gets an
 * equal share of the storage budget.
 */
export async function refreshSupervisorCache(
  options: RefreshOptions,
): Promise<SupervisorCacheStatus> {
  const { api, user } = options;
  const now = options.now ?? (() => Date.now());
  const nowMs = now();
  const budget = options.budgetBytes ?? SUPERVISOR_CACHE_BUDGET_BYTES;

  if (!supervisorCacheEnabled(user, options.featureFlag)) {
    return {
      ...(await readSupervisorCacheStatus(nowMs, budget)),
      enabled: false,
      refreshed: false,
      reason: 'disabled',
    };
  }

  const lastRefresh = await getMeta(`supervisor_cache_at:${user.id}`);
  if (
    !options.force &&
    lastRefresh &&
    nowMs - Date.parse(lastRefresh) < SUPERVISOR_CACHE_MIN_INTERVAL_MS
  ) {
    return {
      ...(await readSupervisorCacheStatus(nowMs, budget)),
      enabled: true,
      refreshed: false,
      reason: 'throttled',
    };
  }

  const journals = await listLocalJournals();
  const window = cacheWindow(nowMs);
  const perJournalBudget = Math.max(
    1 * 1024 * 1024,
    Math.floor(budget / Math.max(1, journals.length)),
  );

  for (const journal of journals) {
    let cursor: string | null = null;
    let applied = 0;
    for (let page = 0; page < SUPERVISOR_CACHE_MAX_PAGES; page += 1) {
      const response = await api.entries({
        from: window.from,
        to: window.to,
        journal_id: journal.id,
        limit: SUPERVISOR_CACHE_PAGE_SIZE,
        cursor: cursor ?? undefined,
      });
      for (const entry of response.items) {
        if (entry.performed_at < window.from) continue;
        // Never overwrite a locally edited/pending row with the server state.
        const pending = await db.outbox.where('entity_id').equals(entry.id).count();
        if (pending > 0) continue;
        const local = await db.entries.get(entry.id);
        if (local && (local.sync_status ?? 'synced') !== 'synced') continue;
        await applyServerEntry(entry);
        applied += 1;
      }
      cursor = response.next_cursor;
      if (!response.has_more || !cursor) break;
      if (applied >= SUPERVISOR_CACHE_MAX_ENTRIES_PER_JOURNAL) break;
    }

    let reviews = 0;
    if (api.reviews) {
      try {
        const response = await api.reviews({
          from: window.fromDate,
          to: window.toDate,
          journal_id: journal.id,
          limit: 100,
        });
        const scoped = response.items.filter(
          (review) => (review.journal_id ?? journal.id) === journal.id,
        );
        if (scoped.length > 0) {
          await applyJournalReviews(scoped);
          reviews = scoped.length;
        }
      } catch {
        // Reviews are an optional part of the cache: a failure must not break
        // the entry cache or the sync run.
      }
    }

    await evictJournalCache(journal.id, user.id, window.from, perJournalBudget);
    const cachedEntries = await countJournalCache(journal.id, window.from, user.id);
    const row = {
      journal_id: journal.id,
      user_id: user.id,
      window_from: window.from,
      window_to: window.to,
      entries: cachedEntries.entries,
      bytes: cachedEntries.bytes,
      updated_at: new Date(nowMs).toISOString(),
    };
    await db.supervisor_cache.put(row);
    await setMeta(
      `supervisor_cache_journal:${journal.id}`,
      JSON.stringify({ ...row, reviews }),
    );
  }

  await setMeta(`supervisor_cache_at:${user.id}`, new Date(nowMs).toISOString());
  const status = await readSupervisorCacheStatus(nowMs, budget);
  await setMeta('supervisor_cache_status', JSON.stringify(status));
  return { ...status, enabled: true, refreshed: true, reason: 'ok' };
}

async function countJournalCache(
  journalId: string,
  windowFrom: string,
  userId: string,
): Promise<{ entries: number; bytes: number }> {
  const rows = (await db.entries
    .where('[journal_id+performed_at]')
    .between([journalId, windowFrom], [journalId, Dexie.maxKey])
    .toArray()) as ClientJournalEntry[];
  const visible = rows.filter(
    (entry) => entry.status === 'active' && (entry.sync_status ?? 'synced') === 'synced',
  );
  return {
    entries: visible.length,
    bytes: visible.reduce((sum, entry) => sum + byteLength(entry), 0),
  };
}

/** Remove every supervisor cache row and cached remote entries (logout). */
export async function clearSupervisorCache(userId: string): Promise<number> {
  const rows = await db.supervisor_cache.toArray();
  let removed = 0;
  for (const row of rows) {
    removed += await evictJournalCache(row.journal_id, userId, row.window_to, 0);
  }
  await db.supervisor_cache.clear();
  await setMeta('supervisor_cache_status', '');
  return removed;
}
