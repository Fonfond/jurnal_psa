import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import type { AdminDepartment, AdminUser } from '../../api/types';
import { Badge } from '../../components/Badge';
import { Loader, PageHeader } from '../../components/Page';
import { formatDateTime, roleLabel } from '../../utils/format';

const ROLES = ['worker', 'supervisor', 'admin', 'auditor'] as const;
const STATUSES = ['active', 'blocked', 'deactivated'] as const;

const STATUS_LABELS: Record<string, string> = {
  active: 'Активен',
  blocked: 'Заблокирован',
  deactivated: 'Деактивирован',
};

const STATUS_TONES: Record<string, 'success' | 'warning' | 'danger'> = {
  active: 'success',
  blocked: 'warning',
  deactivated: 'danger',
};

const EMPTY_FORM = {
  email: '',
  full_name: '',
  role: 'worker',
  department_id: '',
  position: '',
  password: '',
};

/** Admin users directory: filters, creation, role/status changes, sessions. */
export function AdminUsersScreen(): JSX.Element {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [total, setTotal] = useState(0);
  const [departments, setDepartments] = useState<AdminDepartment[]>([]);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const page = await api.adminUsers({
        search: search || undefined,
        role: role || undefined,
        status: status || undefined,
        limit: 100,
      });
      setUsers(page.items);
      setTotal(page.total);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось загрузить пользователей');
    }
  }, [search, role, status]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    void api
      .adminDepartments()
      .then((response) => setDepartments(response.items))
      .catch(() => undefined);
  }, []);

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Операция не выполнена');
    } finally {
      setBusy(false);
    }
  };

  const create = async (): Promise<void> => {
    if (!form.email || !form.full_name || !form.department_id) {
      setError('Заполните email, ФИО и подразделение');
      return;
    }
    if (form.password.length < 8) {
      setError('Пароль должен быть не короче 8 символов');
      return;
    }
    await run(async () => {
      await api.adminCreateUser({
        email: form.email,
        full_name: form.full_name,
        role: form.role,
        department_id: form.department_id,
        position: form.position || undefined,
        password: form.password,
      });
      setForm({ ...EMPTY_FORM });
      setShowCreate(false);
    });
  };

  const patch = async (
    user: AdminUser,
    body: Parameters<typeof api.adminPatchUser>[1],
  ): Promise<void> => {
    await run(async () => {
      await api.adminPatchUser(user.id, body);
      setEditingId(null);
    });
  };

  const departmentName = useMemo(
    () => (id: string | null) =>
      departments.find((department) => department.id === id)?.name ?? '—',
    [departments],
  );

  return (
    <div className="screen admin-screen">
      <PageHeader
        title="Пользователи"
        subtitle={`${total} учётных записей · роли и статусы (ADM-01/ADM-02)`}
        action={
          <button
            type="button"
            className="button button--primary"
            onClick={() => setShowCreate((value) => !value)}
          >
            {showCreate ? 'Скрыть форму' : '+ Пользователь'}
          </button>
        }
      />

      {error ? (
        <div className="alert alert--danger" role="alert">
          {error}
        </div>
      ) : null}

      {showCreate ? (
        <form
          className="form card"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <h2>Новый пользователь</h2>
          <div className="form-row">
            <label className="field">
              <span>Email *</span>
              <input
                type="email"
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
                required
              />
            </label>
            <label className="field">
              <span>ФИО *</span>
              <input
                value={form.full_name}
                onChange={(event) => setForm({ ...form, full_name: event.target.value })}
                required
              />
            </label>
          </div>
          <div className="form-row">
            <label className="field">
              <span>Роль *</span>
              <select
                value={form.role}
                onChange={(event) => setForm({ ...form, role: event.target.value })}
              >
                {ROLES.map((value) => (
                  <option key={value} value={value}>
                    {roleLabel(value)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Подразделение *</span>
              <select
                value={form.department_id}
                onChange={(event) =>
                  setForm({ ...form, department_id: event.target.value })
                }
                required
              >
                <option value="">Выберите</option>
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Должность</span>
              <input
                value={form.position}
                onChange={(event) => setForm({ ...form, position: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Пароль для входа *</span>
              <input
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
                required
              />
              <span className="field__hint">
                Локальная демо-учётка; в production — OIDC.
              </span>
            </label>
          </div>
          <button type="submit" className="button button--primary" disabled={busy}>
            {busy ? 'Сохраняем…' : 'Создать'}
          </button>
        </form>
      ) : null}

      <div className="toolbar">
        <input
          type="search"
          className="input"
          placeholder="Поиск по ФИО, email, внешнему id"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Поиск пользователей"
        />
        <label className="field field--inline">
          <span>Роль</span>
          <select
            value={role}
            onChange={(event) => setRole(event.target.value)}
            aria-label="Фильтр по роли"
          >
            <option value="">Все</option>
            {ROLES.map((value) => (
              <option key={value} value={value}>
                {roleLabel(value)}
              </option>
            ))}
          </select>
        </label>
        <label className="field field--inline">
          <span>Статус</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            aria-label="Фильтр по статусу"
          >
            <option value="">Все</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!users ? (
        <Loader label="Загружаем пользователей…" />
      ) : (
        <div className="card">
          <table className="admin-table" aria-label="Пользователи">
            <thead>
              <tr>
                <th>ФИО / email</th>
                <th>Роль</th>
                <th>Подразделение</th>
                <th>Статус</th>
                <th>Обновлён</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <strong>{user.full_name}</strong>
                    <br />
                    <small>{user.email ?? '—'}</small>
                    {user.position ? <small> · {user.position}</small> : null}
                  </td>
                  <td>
                    {roleLabel(user.role)}
                    {editingId === user.id ? (
                      <select
                        aria-label={`Роль ${user.full_name}`}
                        defaultValue={user.role}
                        onChange={(event) =>
                          void patch(user, { role: event.target.value })
                        }
                      >
                        {ROLES.map((value) => (
                          <option key={value} value={value}>
                            {roleLabel(value)}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </td>
                  <td>{user.department_name ?? departmentName(user.department_id)}</td>
                  <td>
                    <Badge tone={STATUS_TONES[user.status] ?? 'neutral'}>
                      {STATUS_LABELS[user.status] ?? user.status}
                    </Badge>
                    {editingId === user.id ? (
                      <select
                        aria-label={`Статус ${user.full_name}`}
                        defaultValue={user.status}
                        onChange={(event) =>
                          void patch(user, { status: event.target.value })
                        }
                      >
                        {STATUSES.map((value) => (
                          <option key={value} value={value}>
                            {STATUS_LABELS[value]}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </td>
                  <td>{formatDateTime(user.updated_at)}</td>
                  <td>
                    <div className="actions actions--wrap">
                      <button
                        type="button"
                        className="button button--ghost button--small"
                        onClick={() =>
                          setEditingId(editingId === user.id ? null : user.id)
                        }
                      >
                        {editingId === user.id ? 'Готово' : 'Изменить'}
                      </button>
                      <button
                        type="button"
                        className="button button--ghost button--small"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await api.adminRevokeSessions(user.id);
                          })
                        }
                      >
                        Завершить сессии
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {users.length === 0 ? <p className="muted">Ничего не найдено.</p> : null}
        </div>
      )}
      {users && users.length > 0 && total > users.length ? (
        <p className="hint">
          Показаны первые {users.length} из {total}. Уточните фильтр.
        </p>
      ) : null}
    </div>
  );
}
