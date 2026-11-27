import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Grounding } from '@logbook/shared';
import { db } from '../db/schema';
import { listLocalJournals } from '../db/repositories';
import { useAuthStore } from '../stores/auth';
import { useSyncStore } from '../stores/sync';
import { EmptyState, Loader, PageHeader } from '../components/Page';
import { OfflineStatusBar } from '../components/OfflineStatusBar';
import { journalFilterHref } from '../utils/events';
import { formatDateTime } from '../utils/format';

const TYPE_LABELS: Record<Grounding['grounding_type'], string> = {
  portable: 'Переносное З/З',
  fixed: 'Заземляющие ножи (ЗН)',
};

const STATE_LABELS: Record<Grounding['state'], string> = {
  applied: 'Установлено',
  removed: 'Снято',
};

/**
 * S-16 «Заземления»: registry of portable groundings and grounding knives.
 * Rows are derived from grounding journal events; the screen works from the
 * offline cache and can be printed.
 */
export function GroundingsScreen(): JSX.Element {
  const sync = useSyncStore((state) => state.sync);
  const signatureInfo = useAuthStore((state) => state.signature);
  const [journalId, setJournalId] = useState('');
  const [state, setState] = useState<'' | Grounding['state']>('applied');
  const [printMode, setPrintMode] = useState(false);

  const data = useLiveQuery(async () => {
    const [groundings, journals] = await Promise.all([
      db.groundings.toArray(),
      listLocalJournals(),
    ]);
    return { groundings, journals };
  }, []);

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.groundings
      .filter((row) => !journalId || row.journal_id === journalId)
      .filter((row) => !state || row.state === state)
      .sort((left, right) =>
        String(right.updated_at_server ?? '').localeCompare(
          String(left.updated_at_server ?? ''),
        ),
      );
  }, [data, journalId, state]);

  if (!data) {
    return <Loader label="Читаем реестр заземлений…" />;
  }

  const journalName = (id: string): string =>
    data.journals.find((journal) => journal.id === id)?.name ?? 'Журнал';

  const print = (): void => {
    setPrintMode(true);
    window.setTimeout(() => {
      window.print();
      setPrintMode(false);
    }, 50);
  };

  return (
    <div className={`screen${printMode ? ' print-screen' : ''}`}>
      <PageHeader
        title="Заземления"
        subtitle="Реестр переносных заземлений и ЗН, установка и снятие по журналу"
        action={
          <div className="actions actions--wrap print-hide">
            <Link
              to={journalFilterHref('grounding', journalId || undefined)}
              className="button button--ghost"
            >
              События заземлений
            </Link>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void sync()}
            >
              Обновить
            </button>
            <button type="button" className="button button--primary" onClick={print}>
              Печать реестра
            </button>
          </div>
        }
      />

      <div className="print-hide">
        <OfflineStatusBar />
      </div>

      <div className="toolbar print-hide">
        <label className="field field--inline">
          <span>Журнал</span>
          <select
            value={journalId}
            onChange={(event) => setJournalId(event.target.value)}
            aria-label="Журнал реестра заземлений"
          >
            <option value="">Все доступные</option>
            {data.journals.map((journal) => (
              <option key={journal.id} value={journal.id}>
                {journal.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field field--inline">
          <span>Состояние</span>
          <select
            value={state}
            onChange={(event) =>
              setState(event.target.value as '' | Grounding['state'])
            }
            aria-label="Фильтр заземлений по состоянию"
          >
            <option value="">Все</option>
            <option value="applied">Установленные</option>
            <option value="removed">Снятые</option>
          </select>
        </label>
      </div>

      <div className="alert alert--warning print-hide">
        Реестр формируется автоматически из событий типа «Заземление». Повторная
        установка или снятие не блокирует запись журнала, но фиксируется как
        конфликт для разбора руководителем.
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="Заземлений нет"
          description="Установите или снимите заземление в записи журнала — строка появится в реестре."
        />
      ) : (
        <div className="card">
          <h2>
            {journalId ? journalName(journalId) : 'Все журналы'} · записей:{' '}
            {filtered.length}
          </h2>
          <table className="print-table" aria-label="Реестр заземлений">
            <thead>
              <tr>
                <th>Объект / точка</th>
                <th>Тип / номер</th>
                <th>Кол-во</th>
                <th>Состояние</th>
                <th>Установил / снял</th>
                <th>Запись</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id}>
                  <td>
                    <strong>{row.point}</strong>
                    <br />
                    <small>
                      {row.site_name ?? (row.site_id ? 'Объект' : 'без объекта')} ·{' '}
                      {journalName(row.journal_id)}
                    </small>
                  </td>
                  <td>
                    {TYPE_LABELS[row.grounding_type]}
                    {row.tool_number ? ` · № ${row.tool_number}` : ''}
                  </td>
                  <td>{row.count}</td>
                  <td>
                    <span
                      className={`badge badge--${row.state === 'applied' ? 'success' : 'neutral'}`}
                    >
                      {STATE_LABELS[row.state]}
                    </span>
                    <br />
                    <small>
                      {row.state === 'applied'
                        ? formatDateTime(row.applied_at)
                        : formatDateTime(row.removed_at)}
                    </small>
                  </td>
                  <td>
                    {row.state === 'applied'
                      ? (row.applied_by_name ?? '—')
                      : (row.removed_by_name ?? '—')}
                  </td>
                  <td>
                    {(() => {
                      const entryId =
                        row.state === 'applied'
                          ? row.applied_entry_id
                          : row.removed_entry_id;
                      return entryId ? (
                        <Link to={`/entries/${entryId}`}>Открыть</Link>
                      ) : (
                        '—'
                      );
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <footer className="print-sheet__footer">
            <p>
              Печать: {new Date().toLocaleString('ru-RU')} · ЭОЖ Logbook.
              ЭП: {signatureInfo?.legal_note ?? 'сведения об ЭП недоступны (OQ-04).'}
            </p>
          </footer>
        </div>
      )}
    </div>
  );
}
