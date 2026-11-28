import { useCallback, useEffect, useState } from 'react';
import type { Site } from '@logbook/shared';
import { api } from '../../api/client';
import type { UnresolvedSiteRaw } from '../../api/types';
import { Loader, PageHeader } from '../../components/Page';

/**
 * Admin → Справочники → Объекты. Raw site names are never turned into Sites
 * automatically; an admin/supervisor explicitly creates, binds or ignores them.
 */
export function AdminSitesScreen(): JSX.Element {
  const [rows, setRows] = useState<UnresolvedSiteRaw[] | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [unresolved, snapshot] = await Promise.all([
        api.unresolvedSites(),
        api.snapshot(),
      ]);
      setRows(unresolved.items);
      setSites(snapshot.sites.items.filter((site) => site.active));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось загрузить объекты');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось выполнить действие');
    } finally {
      setBusy(false);
    }
  };

  if (!rows) return <Loader label="Загружаем объекты…" />;

  return (
    <div className="screen admin-screen">
      <PageHeader
        title="Объекты"
        subtitle="Справочник объектов и ручные названия из записей"
      />

      {error ? (
        <div className="alert alert--danger" role="alert">
          {error}
        </div>
      ) : null}

      <section className="card">
        <h2>Не привязанные объекты</h2>
        {rows.length === 0 ? (
          <p className="muted">Все ручные названия объектов разобраны.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Название из записи</th>
                  <th>Записей</th>
                  <th>Действие</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.normalized_name}>
                    <td>{row.site_name_raw}</td>
                    <td>{row.count}</td>
                    <td>
                      <div className="actions actions--wrap">
                        <button
                          type="button"
                          className="button button--ghost button--small"
                          disabled={busy}
                          onClick={() => {
                            const name = window.prompt(
                              'Название нового объекта',
                              row.site_name_raw,
                            );
                            if (name?.trim()) {
                              void run(() => api.createSiteFromRaw(name.trim()));
                            }
                          }}
                        >
                          Создать объект
                        </button>
                        <select
                          value={selected[row.normalized_name] ?? ''}
                          onChange={(event) =>
                            setSelected((current) => ({
                              ...current,
                              [row.normalized_name]: event.target.value,
                            }))
                          }
                          aria-label={`Привязать ${row.site_name_raw}`}
                        >
                          <option value="">— существующий —</option>
                          {sites.map((site) => (
                            <option key={site.id} value={site.id}>
                              {site.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="button button--ghost button--small"
                          disabled={busy || !selected[row.normalized_name]}
                          onClick={() =>
                            void run(() =>
                              api.bindSiteFromRaw(
                                row.site_name_raw,
                                selected[row.normalized_name]!,
                              ),
                            )
                          }
                        >
                          Привязать
                        </button>
                        <button
                          type="button"
                          className="button button--danger button--small"
                          disabled={busy}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Игнорировать «${row.site_name_raw}» в очереди?`,
                              )
                            ) {
                              void run(() => api.ignoreSiteRaw(row.site_name_raw));
                            }
                          }}
                        >
                          Игнорировать
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Справочник объектов</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Код</th>
                <th>Название</th>
                <th>Активен</th>
              </tr>
            </thead>
            <tbody>
              {sites.map((site) => (
                <tr key={site.id}>
                  <td>{site.code}</td>
                  <td>{site.name}</td>
                  <td>{site.active ? 'Да' : 'Нет'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

