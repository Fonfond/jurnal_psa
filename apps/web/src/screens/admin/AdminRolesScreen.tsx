import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import type { AdminUser } from '../../api/types';
import { Loader, PageHeader } from '../../components/Page';
import { roleLabel } from '../../utils/format';

const ROLE_ORDER = ['worker', 'supervisor', 'admin', 'auditor'] as const;

const CAPABILITIES: Array<{ label: string; roles: string[] }> = [
  { label: 'Создание и правка своих записей', roles: ['worker', 'supervisor', 'admin'] },
  { label: 'Просмотр журнала подразделения', roles: ['supervisor', 'admin'] },
  { label: 'Проверка/снятие проверки записи', roles: ['supervisor', 'admin'] },
  { label: 'Сдача и приёмка смены', roles: ['supervisor', 'admin'] },
  { label: 'Визы журнала', roles: ['supervisor', 'admin'] },
  { label: 'Разбор конфликтов', roles: ['supervisor', 'admin'] },
  { label: 'Все журналы и гранты', roles: ['admin'] },
  { label: 'Пользователи, устройства, импорт, хранение', roles: ['admin'] },
  { label: 'Аудит и выгрузки (read-only)', roles: ['admin', 'auditor'] },
];

/**
 * Roles reference for the admin contour. Roles come from the identity
 * provider/directory; this screen explains the capability matrix and shows
 * how many accounts hold each role.
 */
export function AdminRolesScreen(): JSX.Element {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .adminUsers({ limit: 200 })
      .then((response) => setUsers(response.items))
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : 'Не удалось загрузить роли'),
      );
  }, []);

  const counts = useMemo(() => {
    const result: Record<string, number> = {};
    for (const user of users ?? []) {
      result[user.role] = (result[user.role] ?? 0) + 1;
    }
    return result;
  }, [users]);

  return (
    <div className="screen admin-screen">
      <PageHeader
        title="Роли"
        subtitle="Матрица прав; роли назначаются в каталоге пользователей (ADM-01)"
      />

      {error ? (
        <div className="alert alert--danger" role="alert">
          {error}
        </div>
      ) : null}

      <div className="stats-grid">
        {ROLE_ORDER.map((role) => (
          <div key={role} className="stat">
            <span className="stat__value">{counts[role] ?? 0}</span>
            <span className="stat__label">{roleLabel(role)}</span>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Матрица прав</h2>
        {!users ? (
          <Loader label="Считаем пользователей…" />
        ) : (
          <table className="admin-table" aria-label="Матрица ролей">
            <thead>
              <tr>
                <th>Возможность</th>
                {ROLE_ORDER.map((role) => (
                  <th key={role}>{roleLabel(role)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CAPABILITIES.map((capability) => (
                <tr key={capability.label}>
                  <td>{capability.label}</td>
                  {ROLE_ORDER.map((role) => (
                    <td key={role} aria-label={`${capability.label}: ${role}`}>
                      {capability.roles.includes(role) ? '✓' : '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">
          Роль `auditor` доступна только на чтение (ADR-15); изменение ролей
          выполняется в разделе «Пользователи» и аудируется (`user.update`).
        </p>
      </div>
    </div>
  );
}
