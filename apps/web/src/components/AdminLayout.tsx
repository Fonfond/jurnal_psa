import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/auth';
import { roleLabel } from '../utils/format';

const NAV = [
  { to: '/admin', label: 'Обзор', end: true },
  { to: '/admin/users', label: 'Пользователи' },
  { to: '/admin/roles', label: 'Роли' },
  { to: '/admin/journals', label: 'Журналы' },
  { to: '/admin/devices', label: 'Устройства' },
  { to: '/admin/imports', label: 'Импорт нарядов' },
  { to: '/admin/retention', label: 'Хранение' },
  { to: '/admin/exports', label: 'Экспорт' },
  { to: '/admin/audit', label: 'Аудит' },
];

/**
 * Admin shell for the separate admin origin (ADR-14). The operational SPA
 * keeps its own mobile shell; this one is a desktop directory/administration
 * workspace with tabs and no offline cache dependency.
 */
export function AdminLayout(): JSX.Element {
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const navigate = useNavigate();

  return (
    <div className="admin-shell">
      <header className="admin-header">
        <div className="admin-header__brand">
          <span className="admin-header__mark" aria-hidden="true">
            ЭОЖ
          </span>
          <div>
            <div className="admin-header__title">Администрирование</div>
            <div className="admin-header__subtitle">
              {user ? `${user.full_name} · ${roleLabel(user.role)}` : ''}
            </div>
          </div>
        </div>
        <div className="admin-header__actions">
          <NavLink to="/" className="button button--ghost button--small">
            К журналу
          </NavLink>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => {
              void logout().then(() => navigate('/login'));
            }}
          >
            Выйти
          </button>
        </div>
      </header>

      <nav className="admin-nav" aria-label="Разделы администрирования">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `admin-nav__item${isActive ? ' is-active' : ''}`
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <main className="admin-main">
        <Outlet />
      </main>
    </div>
  );
}
