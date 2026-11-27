import { create } from 'zustand';
import { api } from '../api/client';
import { getMeta, outboxCounts, pendingConflictCount } from '../db/repositories';
import {
  readSupervisorCacheStatus,
  refreshSupervisorCache,
  supervisorCacheEnabled,
  type SupervisorCacheStatus,
} from '../db/supervisor-cache';
import {
  readBackgroundSyncStatus,
  type BackgroundSyncRegistration,
} from '../sync/background-sync';
import { SyncEngine, type SyncSummary } from '../sync/engine';
import { useAuthStore } from './auth';

export const syncEngine = new SyncEngine({
  currentUser: () => {
    const user = useAuthStore.getState().user;
    return user ? { id: user.id, role: user.role } : null;
  },
});

interface SyncState {
  status: 'idle' | 'syncing' | 'ok' | 'error' | 'offline';
  pending: number;
  dead: number;
  conflicts: number;
  lastSync: string | null;
  error: string | null;
  lastSummary: SyncSummary | null;
  cache: SupervisorCacheStatus | null;
  backgroundSync: BackgroundSyncRegistration | null;
  refresh: () => Promise<void>;
  sync: (engine?: SyncEngine) => Promise<SyncSummary>;
  refreshSupervisorCache: () => Promise<SupervisorCacheStatus | null>;
  record: (summary: SyncSummary) => void;
  recordBackgroundSync: (status: BackgroundSyncRegistration) => void;
}

export const useSyncStore = create<SyncState>((set, get) => ({
  status: 'idle',
  pending: 0,
  dead: 0,
  conflicts: 0,
  lastSync: null,
  error: null,
  lastSummary: null,
  cache: null,
  backgroundSync: null,

  async refresh() {
    const [counts, conflicts, lastSync, error, cache, backgroundSync] =
      await Promise.all([
        outboxCounts(),
        pendingConflictCount(),
        getMeta('sync_last_at'),
        getMeta('sync_error'),
        readSupervisorCacheStatus().catch(() => null),
        readBackgroundSyncStatus().catch(() => null),
      ]);
    set({
      pending: counts.pending + counts.inFlight,
      dead: counts.dead,
      conflicts,
      lastSync,
      error: error || null,
      cache,
      backgroundSync,
    });
  },

  async sync(engine = syncEngine) {
    set({ status: 'syncing', error: null });
    const summary = await engine.syncNow();
    await get().refresh();
    if (summary.status === 'offline') {
      set({ status: 'offline' });
    } else if (summary.status === 'error') {
      set({ status: 'error', error: summary.error ?? 'Ошибка синхронизации' });
    } else if (summary.status === 'busy') {
      set({ status: 'idle' });
    } else {
      set({ status: 'ok', lastSummary: summary });
    }
    return summary;
  },

  async refreshSupervisorCache() {
    const user = useAuthStore.getState().user;
    if (!user) return null;
    const status = await refreshSupervisorCache({
      api,
      user,
      force: true,
    });
    set({ cache: status });
    return status;
  },

  record(summary) {
    set({ lastSummary: summary });
    if (summary.status === 'offline') {
      set({ status: 'offline' });
    } else if (summary.status === 'error') {
      set({ status: 'error', error: summary.error ?? 'Ошибка синхронизации' });
    } else if (summary.status === 'ok') {
      set({ status: 'ok', error: null });
    }
    void get().refresh();
  },

  recordBackgroundSync(status) {
    set({ backgroundSync: status });
  },
}));

export { supervisorCacheEnabled };
