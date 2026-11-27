import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema';
import { resolveLocalConflict } from '../db/repositories';
import { api } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useSyncStore } from '../stores/sync';
import { EmptyState, PageHeader } from '../components/Page';
import { Badge } from '../components/Badge';
import { formatDateTime } from '../utils/format';

export function ConflictsScreen(): JSX.Element {
  const user = useAuthStore((state) => state.user);
  const sync = useSyncStore((state) => state.sync);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const data = useLiveQuery(async () => {
    const [conflicts, entries] = await Promise.all([
      db.conflicts.toArray(),
      db.entries.toArray(),
    ]);
    return { conflicts, entries };
  }, []);

  if (!data) {
    return <PageHeader title="Конфликты" subtitle="Загрузка…" />;
  }

  const privileged = user?.role === 'supervisor' || user?.role === 'admin';
  const pending = data.conflicts.filter(
    (conflict) => conflict.resolution === 'pending',
  );

  const resolve = async (
    id: string,
    resolution: 'local' | 'remote' | 'manual',
    field: string,
    localValue: unknown,
  ): Promise<void> => {
    setBusyId(id);
    setError(null);
    try {
      await api.resolveConflict(id, {
        resolution,
        ...(resolution === 'local' ? { values: { [field]: localValue } } : {}),
      });
      await resolveLocalConflict(id, resolution);
      void sync();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось разрешить');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="screen">
      <PageHeader
        title="Конфликты"
        subtitle={
          pending.length > 0
            ? `${pending.length} ждут решения`
            : 'Неразобранных конфликтов нет'
        }
      />

      {error ? (
        <div className="alert alert--danger" role="alert">
          {error}
        </div>
      ) : null}

      {data.conflicts.length === 0 ? (
        <EmptyState
          title="Конфликтов нет"
          description="Сервер разрешает большинство расхождений автоматически; здесь появятся только спорные поля."
        />
      ) : (
        <ul className="conflict-list">
          {data.conflicts.map((conflict) => {
            const entry = data.entries.find(
              (item) => item.id === conflict.entry_id,
            );
            return (
              <li key={conflict.id} className="card conflict-card">
                <div className="conflict-card__top">
                  <strong>Поле: {conflict.field}</strong>
                  <Badge
                    tone={
                      conflict.resolution === 'pending' ? 'danger' : 'success'
                    }
                  >
                    {conflict.resolution}
                  </Badge>
                </div>
                <p className="muted">
                  {entry ? (
                    <Link to={`/entries/${entry.id}`}>
                      {entry.text.slice(0, 120)}…
                    </Link>
                  ) : (
                    `Запись ${conflict.entry_id.slice(0, 8)}`
                  )}
                </p>
                <div className="conflict-values">
                  <div>
                    <span className="conflict-values__label">Локально</span>
                    <pre>{JSON.stringify(conflict.local_value, null, 2)}</pre>
                    <code>{conflict.local_hlc}</code>
                  </div>
                  <div>
                    <span className="conflict-values__label">На сервере</span>
                    <pre>{JSON.stringify(conflict.remote_value, null, 2)}</pre>
                    <code>{conflict.remote_hlc}</code>
                  </div>
                </div>
                {conflict.resolved_at ? (
                  <p className="hint">
                    Решено {formatDateTime(conflict.resolved_at)}
                  </p>
                ) : null}
                {privileged && conflict.resolution === 'pending' ? (
                  <div className="actions actions--wrap">
                    <button
                      type="button"
                      className="button button--primary"
                      disabled={busyId === conflict.id}
                      onClick={() =>
                        void resolve(
                          conflict.id,
                          'local',
                          conflict.field,
                          conflict.local_value,
                        )
                      }
                    >
                      Оставить локальное
                    </button>
                    <button
                      type="button"
                      className="button button--ghost"
                      disabled={busyId === conflict.id}
                      onClick={() =>
                        void resolve(conflict.id, 'remote', conflict.field, null)
                      }
                    >
                      Принять серверное
                    </button>
                    <button
                      type="button"
                      className="button button--ghost"
                      disabled={busyId === conflict.id}
                      onClick={() =>
                        void resolve(conflict.id, 'manual', conflict.field, null)
                      }
                    >
                      Разобрать вручную
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
