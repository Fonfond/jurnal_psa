import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { AuditEventRow } from '../../api/types';
import { Loader, PageHeader } from '../../components/Page';
import { formatDateTime, roleLabel } from '../../utils/format';
import { Badge } from '../../components/Badge';

/** Audit log with filters (ADM-05): actions, entities, period and hash chain. */
export function AdminAuditScreen(): JSX.Element {
  const [items, setItems] = useState<AuditEventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState({
    action: '',
    entity_type: '',
    from: '',
    to: '',
    limit: '100',
  });

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await api.audit({
        action: filters.action || undefined,
        entity_type: filters.entity_type || undefined,
        from: filters.from ? new Date(filters.from).toISOString() : undefined,
        to: filters.to ? new Date(`${filters.to}T23:59:59`).toISOString() : undefined,
        limit: Number(filters.limit) || 100,
      });
      setItems(response.items);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось загрузить аудит');
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="screen admin-screen">
      <PageHeader
        title="Аудит"
        subtitle="Hash-цепочка по потокам: действия пользователей и администраторов"
        action={
          <button
            type="button"
            className="button button--ghost"
            onClick={() => void load()}
          >
            Обновить
          </button>
        }
      />

      {error ? (
        <div className="alert alert--danger" role="alert">
          {error}
        </div>
      ) : null}

      <div className="toolbar">
        <label className="field field--inline">
          <span>Действие</span>
          <input
            value={filters.action}
            onChange={(event) => setFilters({ ...filters, action: event.target.value })}
            placeholder="user.update"
            aria-label="Фильтр аудита по действию"
          />
        </label>
        <label className="field field--inline">
          <span>Объект</span>
          <input
            value={filters.entity_type}
            onChange={(event) =>
              setFilters({ ...filters, entity_type: event.target.value })
            }
            placeholder="entry / user / device"
            aria-label="Фильтр аудита по типу объекта"
          />
        </label>
        <label className="field field--inline">
          <span>С</span>
          <input
            type="date"
            value={filters.from}
            onChange={(event) => setFilters({ ...filters, from: event.target.value })}
            aria-label="Аудит с даты"
          />
        </label>
        <label className="field field--inline">
          <span>По</span>
          <input
            type="date"
            value={filters.to}
            onChange={(event) => setFilters({ ...filters, to: event.target.value })}
            aria-label="Аудит по дату"
          />
        </label>
        <label className="field field--inline">
          <span>Записей</span>
          <select
            value={filters.limit}
            onChange={(event) => setFilters({ ...filters, limit: event.target.value })}
            aria-label="Лимит аудита"
          >
            {['50', '100', '200'].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!items ? (
        <Loader label="Загружаем аудит…" />
      ) : items.length === 0 ? (
        <p className="muted">Событий не найдено.</p>
      ) : (
        <div className="card">
          <table className="admin-table" aria-label="Журнал аудита">
            <thead>
              <tr>
                <th>Время</th>
                <th>Действие</th>
                <th>Объект</th>
                <th>Роль</th>
                <th>Источник</th>
                <th>Детали</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id}>
                  <td>{formatDateTime(row.occurred_at)}</td>
                  <td>
                    <strong>{row.action}</strong>
                  </td>
                  <td>
                    {row.entity_type}
                    {row.entity_id ? ` · ${String(row.entity_id).slice(0, 8)}` : ''}
                  </td>
                  <td>{roleLabel(row.actor_role)}</td>
                  <td>
                    <Badge tone={row.source === 'server' ? 'info' : 'neutral'}>
                      {row.source}
                    </Badge>
                  </td>
                  <td>
                    <details className="abbr">
                      <summary>JSON</summary>
                      <pre>
                        {JSON.stringify(
                          { before: row.before, after: row.after, reason: row.reason, hash: row.hash },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
