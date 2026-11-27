import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type {
  AdminUser,
  AuditEventRow,
  ExportJobRow,
  RetentionStatus,
} from '../../api/types';
import { Badge } from '../../components/Badge';
import { Loader, PageHeader } from '../../components/Page';
import { formatDateTime } from '../../utils/format';

interface Overview {
  users: number;
  activeUsers: number;
  devices: number;
  journals: number;
  exports: ExportJobRow[];
  retention: RetentionStatus | null;
  audit: AuditEventRow[];
}

/** Admin overview: directory sizes, retention state and recent actions. */
export function AdminOverviewScreen(): JSX.Element {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([
      api.adminUsers({ limit: 1 }).catch(() => ({ items: [], total: 0 })),
      api.adminUsers({ limit: 1, status: 'active' }).catch(() => ({ items: [], total: 0 })),
      api.adminDevices({ limit: 1 }).catch(() => ({ items: [], total: 0 })),
      api.journals().catch(() => ({ items: [] })),
      api.exports({ limit: 3 }).catch(() => ({ items: [], total: 0 })),
      api.retention().catch(() => null),
      api.audit({ limit: 8 }).catch(() => ({ items: [] })),
    ])
      .then(([users, activeUsers, devices, journals, exports, retention, audit]) => {
        if (!active) return;
        setData({
          users: users.total,
          activeUsers: activeUsers.total,
          devices: devices.total,
          journals: journals.items.length,
          exports: exports.items as ExportJobRow[],
          retention: retention as RetentionStatus | null,
          audit: audit.items as AuditEventRow[],
        });
      })
      .catch((caught) => {
        if (active) {
          setError(caught instanceof Error ? caught.message : 'Не удалось загрузить обзор');
        }
      });
    return () => {
      active = false;
    };
  }, []);

  if (!data) {
    return error ? (
      <div className="alert alert--danger" role="alert">
        {error}
      </div>
    ) : (
      <Loader label="Загружаем администрирование…" />
    );
  }

  return (
    <div className="screen admin-screen">
      <PageHeader
        title="Обзор"
        subtitle="Пользователи, устройства, журналы, хранение и последние действия"
      />

      <div className="stats-grid">
        <div className="stat">
          <span className="stat__value">{data.users}</span>
          <span className="stat__label">Пользователей</span>
        </div>
        <div className="stat">
          <span className="stat__value">{data.activeUsers}</span>
          <span className="stat__label">Активных</span>
        </div>
        <div className="stat">
          <span className="stat__value">{data.devices}</span>
          <span className="stat__label">Устройств</span>
        </div>
        <div className="stat">
          <span className="stat__value">{data.journals}</span>
          <span className="stat__label">Журналов</span>
        </div>
      </div>

      <div className="admin-grid">
        <section className="card">
          <h2>Хранение</h2>
          {data.retention ? (
            <dl className="detail-grid">
              <div>
                <dt>Политика</dt>
                <dd>{data.retention.policy_years} лет</dd>
              </div>
              <div>
                <dt>Cutoff</dt>
                <dd>{data.retention.cutoff}</dd>
              </div>
              <div>
                <dt>Последняя проверка</dt>
                <dd>
                  {data.retention.latest_run
                    ? `${formatDateTime(data.retention.latest_run.run_at)} · ${
                        data.retention.latest_run.audit_ok ? 'ок' : 'ошибка'
                      }`
                    : 'ещё не выполнялась'}
                </dd>
              </div>
              <div>
                <dt>Записей всего</dt>
                <dd>{data.retention.journal_entries.total}</dd>
              </div>
            </dl>
          ) : (
            <p className="muted">
              Модуль хранения (t7) ещё не подключён к API — экран покажет данные
              после его появления.
            </p>
          )}
          <Link to="/admin/retention" className="button button--ghost button--small">
            Подробнее
          </Link>
        </section>

        <section className="card">
          <h2>Последние экспорты</h2>
          {data.exports.length === 0 ? (
            <p className="muted">Экспортов пока нет.</p>
          ) : (
            <ul className="outbox-list">
              {data.exports.map((job) => (
                <li key={job.id} className="outbox-item">
                  <div className="outbox-item__top">
                    <strong>{job.type}</strong>
                    <Badge tone={job.worm ? 'success' : 'neutral'}>
                      {job.status}
                    </Badge>
                  </div>
                  <div className="outbox-item__meta">
                    <span>{job.generated_at ? formatDateTime(job.generated_at) : '—'}</span>
                    {job.worm ? <span>WORM</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <Link to="/admin/exports" className="button button--ghost button--small">
            Все экспорты
          </Link>
        </section>
      </div>

      <section className="card">
        <h2>Последние действия</h2>
        {data.audit.length === 0 ? (
          <p className="muted">Журнал аудита пуст.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Время</th>
                <th>Действие</th>
                <th>Объект</th>
                <th>Источник</th>
              </tr>
            </thead>
            <tbody>
              {data.audit.map((row) => (
                <tr key={row.id}>
                  <td>{formatDateTime(row.occurred_at)}</td>
                  <td>{row.action}</td>
                  <td>
                    {row.entity_type}
                    {row.entity_id ? ` · ${String(row.entity_id).slice(0, 8)}` : ''}
                  </td>
                  <td>{row.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Link to="/admin/audit" className="button button--ghost button--small">
          Открыть аудит
        </Link>
      </section>
    </div>
  );
}

export type { AdminUser };
