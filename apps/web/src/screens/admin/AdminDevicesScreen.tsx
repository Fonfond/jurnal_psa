import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { AdminDevice } from '../../api/types';
import { Badge } from '../../components/Badge';
import { Loader, PageHeader } from '../../components/Page';
import { formatDateTime } from '../../utils/format';

/** Admin device inventory: every device, its owner, revoke action (AUTH-02). */
export function AdminDevicesScreen(): JSX.Element {
  const [devices, setDevices] = useState<AdminDevice[] | null>(null);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await api.adminDevices({
        search: search || undefined,
        status: status || undefined,
        limit: 100,
      });
      setDevices(response.items);
      setTotal(response.total);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось загрузить устройства');
    }
  }, [search, status]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timer);
  }, [load]);

  const revoke = async (device: AdminDevice): Promise<void> => {
    if (!window.confirm(`Отозвать устройство «${device.name ?? device.id}»? Сессии будут завершены.`)) {
      return;
    }
    setBusyId(device.id);
    setError(null);
    try {
      await api.adminRevokeDevice(device.id);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось отозвать устройство');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="screen admin-screen">
      <PageHeader
        title="Устройства"
        subtitle={`${total} устройств · привязка сессий и отзыв (ADR-23)`}
      />

      {error ? (
        <div className="alert alert--danger" role="alert">
          {error}
        </div>
      ) : null}

      <div className="toolbar">
        <input
          type="search"
          className="input"
          placeholder="Поиск по пользователю, install_id, названию"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Поиск устройств"
        />
        <label className="field field--inline">
          <span>Статус</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            aria-label="Фильтр устройств по статусу"
          >
            <option value="">Все</option>
            <option value="active">Активные</option>
            <option value="revoked">Отозванные</option>
          </select>
        </label>
      </div>

      {!devices ? (
        <Loader label="Загружаем устройства…" />
      ) : (
        <div className="card">
          <table className="admin-table" aria-label="Устройства">
            <thead>
              <tr>
                <th>Устройство</th>
                <th>Пользователь</th>
                <th>Платформа</th>
                <th>Последняя активность</th>
                <th>Статус</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {devices.map((device) => (
                <tr key={device.id}>
                  <td>
                    <strong>{device.name ?? 'Без названия'}</strong>
                    <br />
                    <small>{device.install_id ?? device.id.slice(0, 8)}</small>
                  </td>
                  <td>
                    {device.user_name ?? '—'}
                    <br />
                    <small>{device.user_email ?? ''}</small>
                  </td>
                  <td>
                    {device.platform ?? '—'}
                    {device.app_version ? ` · ${device.app_version}` : ''}
                  </td>
                  <td>{formatDateTime(device.last_seen_at)}</td>
                  <td>
                    <Badge tone={device.status === 'active' ? 'success' : 'danger'}>
                      {device.status === 'active' ? 'Активно' : 'Отозвано'}
                    </Badge>
                  </td>
                  <td>
                    {device.status === 'active' ? (
                      <button
                        type="button"
                        className="button button--danger button--small"
                        disabled={busyId === device.id}
                        onClick={() => void revoke(device)}
                      >
                        {busyId === device.id ? 'Отзываем…' : 'Отозвать'}
                      </button>
                    ) : (
                      <span className="muted">
                        {device.revoked_at ? formatDateTime(device.revoked_at) : '—'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {devices.length === 0 ? <p className="muted">Устройств не найдено.</p> : null}
        </div>
      )}
    </div>
  );
}
