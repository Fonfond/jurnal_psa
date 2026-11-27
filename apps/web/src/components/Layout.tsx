import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/auth';
import { useSyncStore } from '../stores/sync';
import { OfflineBanner } from './OfflineBanner';
import { SyncIndicator } from './SyncIndicator';
import { roleLabel } from '../utils/format';

const NAV = [
  { to: '/', label: 'Журнал', icon: '▤', end: true },
  { to: '/permits', label: 'Наряды', icon: '▦' },
  { to: '/shifts', label: 'Смены', icon: '⇄' },
  { to: '/groundings', label: 'Заземления', icon: '⏚' },
  { to: '/journal/reviews', label: 'Визы', icon: '✓' },
  { to: '/sync', label: 'Синхронизация', icon: '↻' },
  { to: '/conflicts', label: 'Конфликты', icon: '⚠' },
];

export function Layout(): JSX.Element {
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const lock = useAuthStore((state) => state.lock);
  const conflicts = useSyncStore((state) => state.conflicts);
  const navigate = useNavigate();

  return (
    <div className="app-shell">
      <OfflineBanner />
      <header className="app-header">
        <div className="app-header__brand">
          <span className="app-header__mark" aria-hidden="true">
            ЭОЖ
          </span>
          <div>
            <div className="app-header__title">Logbook</div>
            <div className="app-header__subtitle">
              {user ? `${user.full_name} · ${roleLabel(user.role)}` : ''}
            </div>
          </div>
        </div>
        <div className="app-header__actions">
          <SyncIndicator />
          {user?.role === 'admin' ? (
            <NavLink to="/admin" className="button button--ghost button--small">
              Админка
            </NavLink>
          ) : null}
          <button
            type="button"
            className="button button--ghost button--small"
            title="Закрыть доступ без удаления локальных данных"
            onClick={() => {
              void lock().then(() => navigate('/login'));
            }}
          >
            Заблокировать
          </button>
          <button
            type="button"
            className="button button--ghost button--small"
            title="Выйти и удалить локальные данные этого пользователя"
            onClick={() => {
              void logout().then(() => navigate('/login'));
            }}
          >
            Выйти
          </button>
        </div>
      </header>

      <main className="app-main">
        <Outlet />
      </main>

      <nav className="bottom-nav" aria-label="Основная навигация">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `bottom-nav__item${isActive ? ' is-active' : ''}`
            }
          >
            <span className="bottom-nav__icon" aria-hidden="true">
              {item.icon}
            </span>
            <span>{item.label}</span>
            {item.to === '/conflicts' && conflicts > 0 ? (
              <span className="bottom-nav__badge">{conflicts}</span>
            ) : null}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
