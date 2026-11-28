import { useEffect } from 'react';
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AdminLayout } from '../components/AdminLayout';
import { Layout } from '../components/Layout';
import { Loader } from '../components/Page';
import { isAdminOrigin } from '../config/admin';
import {
  AdminAuditScreen,
  AdminDevicesScreen,
  AdminExportsScreen,
  AdminImportsScreen,
  AdminJournalsScreen,
  AdminSitesScreen,
  AdminOverviewScreen,
  AdminRetentionScreen,
  AdminRolesScreen,
  AdminUsersScreen,
} from '../screens/admin';
import { ConflictsScreen } from '../screens/ConflictsScreen';
import { EntriesScreen } from '../screens/EntriesScreen';
import { EntryCardScreen } from '../screens/EntryCardScreen';
import { EntryEditorScreen } from '../screens/EntryEditorScreen';
import { GroundingsScreen } from '../screens/GroundingsScreen';
import { JournalPrintScreen } from '../screens/JournalPrintScreen';
import { JournalReviewsScreen } from '../screens/JournalReviewsScreen';
import { LoginScreen } from '../screens/LoginScreen';
import { PermitsScreen, PermitDetailScreen } from '../screens/PermitsScreen';
import { ShiftsScreen } from '../screens/ShiftsScreen';
import { SyncScreen } from '../screens/SyncScreen';
import { useAuthStore } from '../stores/auth';
import { syncEngine, useSyncStore } from '../stores/sync';
import { startSyncTriggers } from '../sync/triggers';

function RequireAuth(): JSX.Element {
  const user = useAuthStore((state) => state.user);
  const initialized = useAuthStore((state) => state.initialized);

  if (!initialized) {
    return (
      <div className="full-page-loader">
        <Loader label="Проверяем сессию…" />
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
}

/**
 * Admin contour guard (ADR-14): only `admin` may enter `/admin/*`. The admin
 * SPA is the same bundle served from the admin origin; the API enforces the
 * role as well, this is just the UX boundary.
 */
function RequireAdmin(): JSX.Element {
  const user = useAuthStore((state) => state.user);
  const initialized = useAuthStore((state) => state.initialized);

  if (!initialized) {
    return (
      <div className="full-page-loader">
        <Loader label="Проверяем сессию…" />
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  if (user.role !== 'admin') {
    return (
      <div className="screen">
        <div className="alert alert--warning" role="alert">
          Администрирование доступно только администратору. Текущая роль:{' '}
          {user.role}.
        </div>
        <Link to="/" className="button button--ghost">
          Вернуться в журнал
        </Link>
      </div>
    );
  }
  return <Outlet />;
}

function AppContent(): JSX.Element {
  const user = useAuthStore((state) => state.user);
  const initialized = useAuthStore((state) => state.initialized);
  const loadMe = useAuthStore((state) => state.loadMe);

  useEffect(() => {
    if (!initialized) {
      void loadMe();
    }
  }, [initialized, loadMe]);

  useEffect(() => {
    const onUnauthorized = (): void => {
      useAuthStore.getState().clear();
    };
    window.addEventListener('logbook:unauthorized', onUnauthorized);
    return () =>
      window.removeEventListener('logbook:unauthorized', onUnauthorized);
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    return startSyncTriggers(syncEngine, {
      onResult: (summary) => useSyncStore.getState().record(summary),
      onBackgroundSync: (status) =>
        useSyncStore.getState().recordBackgroundSync(status),
    });
  }, [user]);

  return (
    <Routes>
      <Route path="/login" element={<LoginScreen />} />
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route
            index
            element={
              isAdminOrigin() ? <Navigate to="/admin" replace /> : <EntriesScreen />
            }
          />
          <Route path="entries/new" element={<EntryEditorScreen />} />
          <Route path="entries/:id" element={<EntryCardScreen />} />
          <Route path="entries/:id/edit" element={<EntryEditorScreen />} />
          <Route path="permits" element={<PermitsScreen />} />
          <Route path="permits/:id" element={<PermitDetailScreen />} />
          <Route path="shifts" element={<ShiftsScreen />} />
          <Route path="groundings" element={<GroundingsScreen />} />
          <Route path="sync" element={<SyncScreen />} />
          <Route path="conflicts" element={<ConflictsScreen />} />
          <Route path="journal/reviews" element={<JournalReviewsScreen />} />
          <Route path="journal/print" element={<JournalPrintScreen />} />
        </Route>
      </Route>

      <Route path="/admin" element={<RequireAdmin />}>
        <Route element={<AdminLayout />}>
          <Route index element={<AdminOverviewScreen />} />
          <Route path="users" element={<AdminUsersScreen />} />
          <Route path="roles" element={<AdminRolesScreen />} />
          <Route path="journals" element={<AdminJournalsScreen />} />
          <Route path="sites" element={<AdminSitesScreen />} />
          <Route path="devices" element={<AdminDevicesScreen />} />
          <Route path="imports" element={<AdminImportsScreen />} />
          <Route path="retention" element={<AdminRetentionScreen />} />
          <Route path="exports" element={<AdminExportsScreen />} />
          <Route path="audit" element={<AdminAuditScreen />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App(): JSX.Element {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}
