import { useCallback, useEffect, useState } from 'react';
import type { Journal } from '@logbook/shared';
import { api } from '../../api/client';
import type { AdminUser, JournalMember } from '../../api/types';
import { Badge } from '../../components/Badge';
import { Loader, PageHeader } from '../../components/Page';
import { formatDateTime } from '../../utils/format';

const ACCESS_LEVELS = ['read', 'write', 'manage'] as const;
const ACCESS_LABELS: Record<string, string> = {
  read: 'Чтение',
  write: 'Запись',
  manage: 'Управление',
};

/** Admin journals: create/patch journals and manage membership grants (JRN-03). */
export function AdminJournalsScreen(): JSX.Element {
  const [journals, setJournals] = useState<Journal[] | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<JournalMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [sortOrder, setSortOrder] = useState('100');
  const [grantUserId, setGrantUserId] = useState('');
  const [grantLevel, setGrantLevel] = useState<'read' | 'write' | 'manage'>('read');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, directory] = await Promise.all([
        api.journals(),
        api.adminUsers({ limit: 200 }).catch(() => ({ items: [], total: 0 })),
      ]);
      setJournals(list.items);
      setUsers(directory.items);
      setSelectedId((current) => current ?? list.items[0]?.id ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось загрузить журналы');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setMembers(null);
      return;
    }
    let active = true;
    void api
      .journalMembers(selectedId)
      .then((response) => {
        if (active) setMembers(response.items);
      })
      .catch(() => {
        if (active) setMembers([]);
      });
    return () => {
      active = false;
    };
  }, [selectedId]);

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      if (selectedId) {
        const response = await api.journalMembers(selectedId).catch(() => ({ items: [] }));
        setMembers(response.items);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Операция не выполнена');
    } finally {
      setBusy(false);
    }
  };

  const create = async (): Promise<void> => {
    if (!key.trim() || name.trim().length < 2) {
      setError('Укажите ключ и название журнала');
      return;
    }
    await run(async () => {
      const created = await api.createJournal({
        journal_key: key.trim(),
        name: name.trim(),
        sort_order: Number(sortOrder) || 100,
      });
      setKey('');
      setName('');
      setSelectedId(created.id);
    });
  };

  return (
    <div className="screen admin-screen">
      <PageHeader
        title="Журналы"
        subtitle="Каталог журналов, активность и гранты пользователей"
      />

      {error ? (
        <div className="alert alert--danger" role="alert">
          {error}
        </div>
      ) : null}

      <form
        className="form card"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <h2>Новый журнал</h2>
        <div className="form-row">
          <label className="field">
            <span>Ключ *</span>
            <input
              value={key}
              onChange={(event) => setKey(event.target.value)}
              maxLength={64}
              placeholder="например, shop-2"
              required
            />
          </label>
          <label className="field">
            <span>Название *</span>
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label className="field">
            <span>Порядок</span>
            <input
              type="number"
              min={0}
              max={10000}
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value)}
            />
          </label>
        </div>
        <button type="submit" className="button button--primary" disabled={busy}>
          Создать журнал
        </button>
      </form>

      {!journals ? (
        <Loader label="Загружаем журналы…" />
      ) : (
        <div className="admin-grid">
          <section className="card">
            <h2>Каталог</h2>
            <ul className="outbox-list">
              {journals.map((journal) => (
                <li key={journal.id} className="outbox-item">
                  <button
                    type="button"
                    className="admin-link"
                    onClick={() => setSelectedId(journal.id)}
                  >
                    <strong>{journal.name}</strong>
                    <small>
                      {journal.journal_key} · порядок {journal.sort_order ?? 100}
                    </small>
                  </button>
                  <div className="actions actions--wrap">
                    <Badge tone={journal.active === false ? 'warning' : 'success'}>
                      {journal.active === false ? 'Выключен' : 'Активен'}
                    </Badge>
                    <button
                      type="button"
                      className="button button--ghost button--small"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          api.patchJournal(journal.id, {
                            active: journal.active === false,
                          }),
                        )
                      }
                    >
                      {journal.active === false ? 'Включить' : 'Выключить'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2>Доступ</h2>
            {!selectedId ? (
              <p className="muted">Выберите журнал.</p>
            ) : (
              <>
                <div className="form-row">
                  <label className="field">
                    <span>Пользователь</span>
                    <select
                      value={grantUserId}
                      onChange={(event) => setGrantUserId(event.target.value)}
                      aria-label="Пользователь для гранта"
                    >
                      <option value="">Выберите</option>
                      {users.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.full_name} ({user.email ?? user.role})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Уровень</span>
                    <select
                      value={grantLevel}
                      onChange={(event) =>
                        setGrantLevel(event.target.value as 'read' | 'write' | 'manage')
                      }
                      aria-label="Уровень доступа"
                    >
                      {ACCESS_LEVELS.map((level) => (
                        <option key={level} value={level}>
                          {ACCESS_LABELS[level]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="button button--primary button--small"
                    disabled={busy || !grantUserId}
                    onClick={() =>
                      void run(async () => {
                        await api.grantJournal(selectedId, grantUserId, grantLevel);
                        setGrantUserId('');
                      })
                    }
                  >
                    Выдать грант
                  </button>
                </div>

                {!members ? (
                  <Loader label="Загружаем гранты…" />
                ) : members.length === 0 ? (
                  <p className="muted">Явных грантов нет: журнал доступен по правилам роли.</p>
                ) : (
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Пользователь</th>
                        <th>Уровень</th>
                        <th>Выдан</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {members.map((member) => (
                        <tr key={member.user_id}>
                          <td>
                            <strong>{member.full_name}</strong>
                            <br />
                            <small>{member.email ?? '—'}</small>
                          </td>
                          <td>{ACCESS_LABELS[member.access_level]}</td>
                          <td>{formatDateTime(member.granted_at)}</td>
                          <td>
                            <button
                              type="button"
                              className="button button--ghost button--small"
                              disabled={busy}
                              onClick={() =>
                                void run(() =>
                                  api.revokeJournalGrant(selectedId, member.user_id),
                                )
                              }
                            >
                              Отозвать
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
