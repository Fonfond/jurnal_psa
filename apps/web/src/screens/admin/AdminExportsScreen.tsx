import { useCallback, useEffect, useState } from 'react';
import type { Journal } from '@logbook/shared';
import { api } from '../../api/client';
import type { ExportJobRow } from '../../api/types';
import { Badge } from '../../components/Badge';
import { Loader, PageHeader } from '../../components/Page';
import { formatDateTime } from '../../utils/format';

function formatSize(bytes: number | null): string {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

/** WORM exports of the journal: PDF + CSV with signed short-lived URLs (JRN-07). */
export function AdminExportsScreen(): JSX.Element {
  const [items, setItems] = useState<ExportJobRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [journals, setJournals] = useState<Journal[]>([]);
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [form, setForm] = useState({ journal_id: '', from: '', to: '' });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [exports, journalList] = await Promise.all([
        api.exports({
          type: type || undefined,
          status: status || undefined,
          limit: 50,
        }),
        api.journals().catch(() => ({ items: [] })),
      ]);
      setItems(exports.items);
      setTotal(exports.total);
      setJournals(journalList.items);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось загрузить экспорты');
    }
  }, [type, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.createExport({
        journal_id: form.journal_id || undefined,
        from: form.from || undefined,
        to: form.to || undefined,
      });
      setNotice('Экспорт сформирован и зафиксирован (WORM)');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось создать экспорт');
    } finally {
      setBusy(false);
    }
  };

  const download = async (job: ExportJobRow, format: 'pdf' | 'csv'): Promise<void> => {
    setError(null);
    try {
      const result = await api.exportUrl(job.id, format);
      window.open(result.url, '_blank', 'noopener');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось получить ссылку');
    }
  };

  return (
    <div className="screen admin-screen">
      <PageHeader
        title="Экспорт журнала"
        subtitle="PDF (3 графы) и CSV, WORM-фиксация, подписанные ссылки ≤15 мин"
      />

      {error ? (
        <div className="alert alert--danger" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="alert alert--success" role="status">
          {notice}
        </div>
      ) : null}

      <form
        className="form card"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <h2>Новый экспорт</h2>
        <div className="form-row">
          <label className="field">
            <span>Журнал</span>
            <select
              value={form.journal_id}
              onChange={(event) => setForm({ ...form, journal_id: event.target.value })}
              aria-label="Журнал экспорта"
            >
              <option value="">Все доступные</option>
              {journals.map((journal) => (
                <option key={journal.id} value={journal.id}>
                  {journal.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>С</span>
            <input
              type="date"
              value={form.from}
              onChange={(event) => setForm({ ...form, from: event.target.value })}
            />
          </label>
          <label className="field">
            <span>По</span>
            <input
              type="date"
              value={form.to}
              onChange={(event) => setForm({ ...form, to: event.target.value })}
            />
          </label>
        </div>
        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? 'Формируем…' : 'Сформировать экспорт'}
        </button>
      </form>

      <div className="toolbar">
        <label className="field field--inline">
          <span>Тип</span>
          <input
            value={type}
            onChange={(event) => setType(event.target.value)}
            placeholder="journal_pdf"
            aria-label="Фильтр экспортов по типу"
          />
        </label>
        <label className="field field--inline">
          <span>Статус</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            aria-label="Фильтр экспортов по статусу"
          >
            <option value="">Все</option>
            <option value="done">Готовые</option>
            <option value="queued">В очереди</option>
            <option value="failed">Ошибки</option>
          </select>
        </label>
      </div>

      {!items ? (
        <Loader label="Загружаем экспорты…" />
      ) : (
        <div className="card">
          <h2>Экспорты · {total}</h2>
          {items.length === 0 ? (
            <p className="muted">Экспортов пока нет.</p>
          ) : (
            <table className="admin-table" aria-label="Экспорты">
              <thead>
                <tr>
                  <th>Тип</th>
                  <th>Период / журнал</th>
                  <th>Размер</th>
                  <th>Статус</th>
                  <th>WORM</th>
                  <th>Сформирован</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((job) => (
                  <tr key={job.id}>
                    <td>{job.type}</td>
                    <td>{job.journal_id ? job.journal_id.slice(0, 8) : 'все журналы'}</td>
                    <td>{formatSize(job.file_size_bytes)}</td>
                    <td>
                      <Badge tone={job.status === 'done' ? 'success' : 'warning'}>
                        {job.status}
                      </Badge>
                    </td>
                    <td>{job.worm ? 'Да' : '—'}</td>
                    <td>{formatDateTime(job.generated_at)}</td>
                    <td>
                      <div className="actions actions--wrap">
                        <button
                          type="button"
                          className="button button--ghost button--small"
                          disabled={job.status !== 'done'}
                          onClick={() => void download(job, 'pdf')}
                        >
                          PDF
                        </button>
                        <button
                          type="button"
                          className="button button--ghost button--small"
                          disabled={job.status !== 'done'}
                          onClick={() => void download(job, 'csv')}
                        >
                          CSV
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
