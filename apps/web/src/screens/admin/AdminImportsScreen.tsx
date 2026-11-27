import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import type {
  PermitImportHistoryRow,
  PermitImportResult,
} from '../../api/types';
import { Loader, PageHeader } from '../../components/Page';
import { formatDateTime } from '../../utils/format';

const SAMPLE_CSV = `number,status,valid_from,valid_to,site_code,work_type_code
А-101,active,2026-11-01T00:00:00Z,2026-12-01T00:00:00Z,SITE-01,SIMPLE`;

/** Admin permit import: CSV/JSON source adapter, result and audit history (OQ-03). */
export function AdminImportsScreen(): JSX.Element {
  const [sourceId, setSourceId] = useState('csv');
  const [mode, setMode] = useState<'csv' | 'json'>('csv');
  const [csv, setCsv] = useState(SAMPLE_CSV);
  const [json, setJson] = useState('[\n  {\n    "external_id": "ap-100",\n    "number": "А-100",\n    "status": "active"\n  }\n]');
  const [result, setResult] = useState<PermitImportResult | null>(null);
  const [history, setHistory] = useState<PermitImportHistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadHistory = useCallback(async () => {
    try {
      const response = await api.adminImports();
      setHistory(response.items);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось загрузить историю импорта');
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      let body: Parameters<typeof api.adminImportPermits>[0];
      if (mode === 'csv') {
        if (!csv.trim()) {
          throw new Error('Вставьте CSV');
        }
        body = { source_id: sourceId || 'csv', csv };
      } else {
        const records = JSON.parse(json) as Array<Record<string, unknown>>;
        if (!Array.isArray(records) || records.length === 0) {
          throw new Error('JSON должен содержать непустой массив записей');
        }
        body = { source_id: sourceId || 'json', records };
      }
      const response = await api.adminImportPermits(body);
      setResult(response);
      await loadHistory();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Импорт не выполнен');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen admin-screen">
      <PageHeader
        title="Импорт нарядов"
        subtitle="Источник CSV/JSON, идемпотентный импорт и аудит (PRM-01/OQ-03)"
      />

      {error ? (
        <div className="alert alert--danger" role="alert">
          {error}
        </div>
      ) : null}

      <div className="segmented" role="tablist" aria-label="Формат импорта">
        {(['csv', 'json'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            className={mode === value ? 'is-active' : ''}
            onClick={() => setMode(value)}
          >
            {value.toUpperCase()}
          </button>
        ))}
      </div>

      <form
        className="form card"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="form-row">
          <label className="field">
            <span>Идентификатор источника</span>
            <input
              value={sourceId}
              onChange={(event) => setSourceId(event.target.value)}
              maxLength={32}
            />
          </label>
        </div>
        {mode === 'csv' ? (
          <label className="field">
            <span>CSV нарядов</span>
            <textarea
              rows={10}
              value={csv}
              onChange={(event) => setCsv(event.target.value)}
              aria-label="CSV нарядов"
            />
          </label>
        ) : (
          <label className="field">
            <span>JSON-записи источника</span>
            <textarea
              rows={10}
              value={json}
              onChange={(event) => setJson(event.target.value)}
              aria-label="JSON нарядов"
            />
          </label>
        )}
        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? 'Импортируем…' : 'Импортировать'}
        </button>
      </form>

      {result ? (
        <section className="card" aria-label="Результат импорта">
          <h2>Результат</h2>
          <dl className="detail-grid">
            <div>
              <dt>Создано</dt>
              <dd>{result.imported ?? 0}</dd>
            </div>
            <div>
              <dt>Обновлено</dt>
              <dd>{result.updated ?? 0}</dd>
            </div>
            <div>
              <dt>Ошибок</dt>
              <dd>{result.errors?.length ?? 0}</dd>
            </div>
          </dl>
          {result.errors && result.errors.length > 0 ? (
            <ul className="outbox-list" aria-label="Ошибки импорта">
              {result.errors.map((row) => (
                <li key={`${row.row}-${row.message}`} className="outbox-item">
                  <strong>Строка {row.row}</strong>
                  <p className="outbox-item__text">{row.message}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Ошибок нет.</p>
          )}
        </section>
      ) : null}

      <section className="card">
        <h2>История импорта</h2>
        {!history ? (
          <Loader label="Загружаем историю…" />
        ) : history.length === 0 ? (
          <p className="muted">Импортов ещё не было.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Время</th>
                <th>Источник</th>
                <th>Итог</th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.id}>
                  <td>{formatDateTime(row.occurred_at)}</td>
                  <td>{String(row.after?.source_id ?? row.after?.adapter ?? '—')}</td>
                  <td>
                    создано {String(row.after?.imported ?? 0)} · обновлено{' '}
                    {String(row.after?.updated ?? 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
