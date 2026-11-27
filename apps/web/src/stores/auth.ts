import { create } from 'zustand';
import { api, ApiError, setCsrfToken } from '../api/client';
import type { ApiSession, ApiUser, MeResponse, SignatureInfo } from '../api/types';
import {
  clearOfflinePin,
  clearOfflineSession,
  hasOfflinePin,
  lastOfflineUserId,
  markOfflineLocked,
  readOfflineSession,
  rememberOfflineSession,
  restoreOfflineSession,
  setOfflinePin,
  verifyOfflinePin,
  type UnlockResult,
} from '../auth/offline-session';
import {
  activateUserDatabase,
  closeActiveDatabase,
  deleteUserDatabase,
} from '../db/user-db';

interface AuthState {
  user: ApiUser | null;
  session: ApiSession | null;
  loading: boolean;
  initialized: boolean;
  error: string | null;
  /** Local session locked by the user; local data is kept (ADR-10). */
  locked: boolean;
  /** Session was restored from IndexedDB without a reachable server. */
  offline: boolean;
  /** PIN verifier exists for the last account on this device (AUTH-03). */
  pinConfigured: boolean;
  /** ЭП adapter state from `/v1/me` (OQ-04): provider, algorithm, caveat. */
  signature: SignatureInfo | null;
  features: MeResponse['features'] | null;
  login: (email: string, password: string) => Promise<void>;
  loadMe: () => Promise<void>;
  logout: () => Promise<void>;
  lock: () => Promise<void>;
  unlockWithPin: (pin: string, now?: number) => Promise<UnlockResult>;
  setPin: (pin: string) => Promise<void>;
  removePin: () => Promise<void>;
  clear: () => void;
}

/**
 * Load the ЭП adapter state and feature flags without failing the login when
 * the network hiccups: hints degrade to "неизвестно", they never block work.
 */
async function loadProfileExtras(): Promise<{
  signature: SignatureInfo | null;
  features: MeResponse['features'] | null;
}> {
  try {
    const me = await api.me();
    return { signature: me.signature ?? null, features: me.features ?? null };
  } catch {
    return { signature: null, features: null };
  }
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * Auth store with per-user local storage (SYN-02, ADR-10, ADR-16) and local
 * unlock / offline session restore (AUTH-03).
 *
 * `login`/`loadMe` open the IndexedDB database of the signed-in account before
 * exposing the user, so no screen can read another account's cache. `lock`
 * closes the database but keeps it on disk (and requires a PIN if one was
 * configured); `logout` deletes it together with the outbox, drafts, the
 * supervisor cache and the local PIN/offline session (AUTH-03/ADR-10).
 */
export const useAuthStore = create<AuthState>((set, get) => ({
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

  async login(email, password) {
    set({ loading: true, error: null });
    try {
      const response = await api.login(email, password);
      await activateUserDatabase(response.user.id);
      const extras = await loadProfileExtras();
      await rememberOfflineSession(response.user, response.session);
      await markOfflineLocked(response.user.id, false);
      set({
        user: response.user,
        session: response.session,
        loading: false,
        initialized: true,
        error: null,
        locked: false,
        offline: false,
        pinConfigured: await hasOfflinePin(response.user.id),
        ...extras,
      });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'Не удалось войти',
      });
      throw error;
    }
  },

  async loadMe() {
    set({ loading: true });
    try {
      const response = await api.me();
      const previous = await readOfflineSession(response.user.id);
      if (previous?.locked) {
        // Lock survives a reload: keep the snapshot, but do not expose the
        // journal until the PIN is verified.
        await rememberOfflineSession(response.user, response.session);
        await closeActiveDatabase().catch(() => undefined);
        set({
          user: null,
          session: null,
          loading: false,
          initialized: true,
          error: null,
          locked: true,
          offline: false,
          pinConfigured: Boolean(previous.pin),
          signature: null,
          features: null,
        });
        return;
      }
      await activateUserDatabase(response.user.id);
      await rememberOfflineSession(response.user, response.session);
      set({
        user: response.user,
        session: response.session,
        loading: false,
        initialized: true,
        error: null,
        locked: false,
        offline: false,
        pinConfigured: Boolean(previous?.pin),
        signature: response.signature ?? null,
        features: response.features ?? null,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setCsrfToken('');
        const last = await lastOfflineUserId();
        if (last) {
          await clearOfflineSession(last).catch(() => undefined);
        }
        await closeActiveDatabase().catch(() => undefined);
        set({
          user: null,
          session: null,
          loading: false,
          initialized: true,
          error: null,
          locked: false,
          offline: false,
          pinConfigured: false,
          signature: null,
          features: null,
        });
        return;
      }
      // No server: restore the last offline session from this device.
      const restored = await restoreOfflineSession().catch(() => null);
      if (restored) {
        if (restored.locked) {
          await closeActiveDatabase().catch(() => undefined);
          set({
            user: null,
            session: null,
            loading: false,
            initialized: true,
            error: null,
            locked: true,
            offline: true,
            pinConfigured: Boolean(restored.record.pin),
            signature: null,
            features: null,
          });
          return;
        }
        await activateUserDatabase(restored.record.user.id).catch(() => undefined);
        set({
          user: restored.record.user,
          session: restored.record.session,
          loading: false,
          initialized: true,
          error: null,
          locked: false,
          offline: true,
          pinConfigured: Boolean(restored.record.pin),
          signature: null,
          features: null,
        });
        return;
      }
      set({
        loading: false,
        initialized: true,
        error:
          'Нет соединения с сервером. Офлайн-сессия не найдена или истекла — войдите при подключении.',
        offline: isOffline(),
        pinConfigured: false,
      });
    }
  },

  async logout() {
    const current = get().user;
    const lastUser = await lastOfflineUserId().catch(() => null);
    try {
      await api.logout();
    } catch {
      // The local session is cleared even if the network is unavailable.
    }
    setCsrfToken('');
    const userId = current?.id ?? lastUser;
    if (userId) {
      await clearOfflineSession(userId).catch(() => undefined);
    }
    if (current) {
      await deleteUserDatabase(current.id).catch(() => undefined);
    } else {
      await closeActiveDatabase().catch(() => undefined);
    }
    set({
      user: null,
      session: null,
      error: null,
      locked: false,
      offline: false,
      pinConfigured: false,
      signature: null,
      features: null,
    });
  },

  async lock() {
    // ADR-10/AUTH-03: lock keeps local data, drops the in-memory session and
    // requires the PIN (or a password login) on return.
    const { user, session } = get();
    setCsrfToken('');
    if (user && session) {
      await rememberOfflineSession(user, session).catch(() => undefined);
      await markOfflineLocked(user.id, true).catch(() => undefined);
    }
    await closeActiveDatabase().catch(() => undefined);
    const lastUser = user?.id ?? (await lastOfflineUserId().catch(() => null));
    const pinConfigured = lastUser ? await hasOfflinePin(lastUser) : false;
    set({
      user: null,
      session: null,
      loading: false,
      initialized: true,
      error: null,
      locked: true,
      offline: false,
      pinConfigured,
      signature: null,
      features: null,
    });
  },

  async unlockWithPin(pin, now = Date.now()) {
    const userId = await lastOfflineUserId().catch(() => null);
    if (!userId) {
      const result: UnlockResult = {
        ok: false,
        reason: 'not-found',
        message: 'Сохранённая сессия не найдена — войдите заново',
      };
      set({ error: result.message });
      return result;
    }
    const result = await verifyOfflinePin(userId, pin, now);
    if (!result.ok) {
      set({ error: result.message, pinConfigured: await hasOfflinePin(userId) });
      return result;
    }
    const record = result.record;
    await activateUserDatabase(userId);
    await markOfflineLocked(userId, false, now);
    set({
      user: record.user,
      session: record.session,
      loading: false,
      initialized: true,
      error: null,
      locked: false,
      offline: isOffline(),
      pinConfigured: Boolean(record.pin),
      signature: null,
      features: null,
    });
    // Refresh ЭП/feature hints in the background when the network is back.
    if (!isOffline()) {
      void loadProfileExtras().then((extras) => set(extras));
    }
    return result;
  },

  async setPin(pin) {
    const user = get().user;
    if (!user) {
      throw new Error('Нет активного пользователя');
    }
    await setOfflinePin(user.id, pin);
    set({ pinConfigured: true, error: null });
  },

  async removePin() {
    const user = get().user;
    if (!user) return;
    await clearOfflinePin(user.id);
    set({ pinConfigured: false });
  },

  clear() {
    set({
      user: null,
      session: null,
      error: null,
      loading: false,
      locked: false,
      offline: false,
      pinConfigured: false,
      signature: null,
      features: null,
    });
  },
}));

export function isPrivileged(role: string | undefined): boolean {
  return role === 'supervisor' || role === 'admin';
}
