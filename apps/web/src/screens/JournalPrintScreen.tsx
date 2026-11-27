import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ABBREVIATIONS, type JournalEventType } from '@logbook/shared';
import {
  listLocalEntries,
  listLocalJournals,
} from '../db/repositories';
import { PageHeader } from '../components/Page';
import { EventDetails } from '../components/EventDetails';
import { formatDateTime } from '../utils/format';

const EVENT_LABELS: Record<JournalEventType, string> = {
  work: 'Работа',
  command: 'Команда',
  switching: 'Переключение',
  grounding: 'Заземление',
  incident: 'Инцидент',
  other: 'Другое',
};

export function JournalPrintScreen(): JSX.Element {
  const [selectedJournalId, setSelectedJournalId] = useState<string | null>(null);
  const journals = useLiveQuery(() => listLocalJournals(), []);
  const activeJournalId = selectedJournalId ?? journals?.[0]?.id ?? null;

  const entries = useLiveQuery(
    () =>
      listLocalEntries(
        activeJournalId ? { journal_id: activeJournalId } : {},
      ),
    [activeJournalId],
  );

  if (!journals || !entries) {
    return <PageHeader title="Печать журнала" subtitle="Загрузка…" />;
  }

  const activeJournal =
    journals.find((journal) => journal.id === activeJournalId) ?? journals[0];

  return (
    <div className="screen print-screen">
      <PageHeader
        title="Печать журнала"
        subtitle={activeJournal?.name ?? 'Оперативный журнал'}
        action={
          <button
            type="button"
            className="button button--primary print-hide"
            onClick={() => window.print()}
          >
            Печать
          </button>
        }
      />

      <div className="toolbar print-hide">
        <label className="field field--inline">
          <span>Журнал</span>
          <select
            value={activeJournalId ?? ''}
            onChange={(event) => setSelectedJournalId(event.target.value)}
            aria-label="Журнал для печати"
          >
            {journals.map((journal) => (
              <option key={journal.id} value={journal.id}>
                {journal.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="alert alert--warning print-hide">
        Экспорт/печать не подписаны ЭП. Для юридически значимого электронного
        журнала требуется решение OQ-04; до него используйте гибридный режим.
      </div>

      <article className="print-sheet">
        <header className="print-sheet__header">
          <h1>{activeJournal?.name ?? 'Оперативный журнал'}</h1>
          <p>
            ЭОЖ Logbook · журнал «{activeJournal?.journal_key ?? 'main'}» ·
            записей: {entries.length} · печать:{' '}
            {new Date().toLocaleString('ru-RU')}
          </p>
        </header>

        <table className="print-table">
          <thead>
            <tr>
              <th>Дата, время</th>
              <th>Содержание сообщений в течение смены</th>
              <th>Визы, замечания</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>
                  {formatDateTime(entry.performed_at)}
                  <br />
                  <small>№ {entry.journal_seq ?? '—'}</small>
                </td>
                <td>
                  <strong>{EVENT_LABELS[entry.event_type ?? 'work']}</strong>
                  {entry.late_entry ? ' · пропущенная запись' : ''}
                  <br />
                  {entry.text}
                  {entry.comment ? <div>Комментарий: {entry.comment}</div> : null}
                  <EventDetails eventType={entry.event_type} data={entry.event_data} />
                </td>
                <td>{entry.verified_at ? formatDateTime(entry.verified_at) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <footer className="print-sheet__footer">
          <p>
            Подпись ответственного за электрохозяйство: ____________________
          </p>
          <p>
            Хранение: не менее 3 лет со дня последней записи. TODO(OQ-18).
          </p>
        </footer>
      </article>

      <details className="abbr print-hide">
        <summary>Допускаемые сокращения</summary>
        <ul className="abbr__list">
          {ABBREVIATIONS.map((item) => (
            <li key={`${item.short}-${item.full}`}>
              <strong>{item.short}</strong> — {item.full}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
