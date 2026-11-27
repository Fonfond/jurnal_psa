import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import type { JournalEventType, Shift } from '@logbook/shared';
import { api } from '../api/client';
import { db } from '../db/schema';
import {
  journalName,
  listLocalEntries,
  listLocalJournals,
} from '../db/repositories';
import { useSyncStore } from '../stores/sync';
import { Badge, SyncBadge } from '../components/Badge';
import { EmptyState, Loader, PageHeader } from '../components/Page';
import { formatDate, formatDateTime } from '../utils/format';
import {
  EVENT_TYPE_LABELS,
  eventTypeLabel,
  eventTypeTone,
  shiftStatusLabel,
  shiftStatusTone,
} from '../utils/events';

type Filter = 'all' | 'pending' | 'verified';
type EventFilter = '' | JournalEventType;

const EVENT_OPTIONS = Object.entries(EVENT_TYPE_LABELS) as Array<
  [JournalEventType, string]
>;

/**
 * S-02 «Журнал»: offline journal with search, journal/event filters and the
 * shift context (S-15 integration). Operational events (switching, grounding)
 * are badged and can be filtered; the grounding registry is one click away.
 */
export function EntriesScreen(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const shiftId = searchParams.get('shift_id');
  const [search, setSearch] = useState(searchParams.get('q') ?? '');
  const [filter, setFilter] = useState<Filter>('all');
  const [journalId, setJournalId] = useState(
    searchParams.get('journal_id') ?? '',
  );
  const [eventType, setEventType] = useState<EventFilter>(
    (searchParams.get('event_type') as EventFilter | null) ?? '',
  );
  const [shift, setShift] = useState<Shift | null>(null);
  const [shiftMissing, setShiftMissing] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const sync = useSyncStore((state) => state.sync);
  const syncing = useSyncStore((state) => state.status === 'syncing');

  useEffect(() => {
    if (!shiftId) {
      setShift(null);
      setShiftMissing(false);
      return undefined;
    }
    let active = true;
    void db.shifts.get(shiftId).then((row) => {
      if (!active) return;
      setShift(row ?? null);
      setShiftMissing(!row);
    });
    return () => {
      active = false;
    };
  }, [shiftId]);

  const data = useLiveQuery(async () => {
    const [entries, workTypes, journals] = await Promise.all([
      listLocalEntries({ search }),
      db.dict_work_types.toArray(),
      listLocalJournals(),
    ]);
    return { entries, workTypes, journals };
  }, [search]);

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.entries.filter((entry) => {
      if (journalId && entry.journal_id !== journalId) {
        return false;
      }
      if (eventType && (entry.event_type ?? 'work') !== eventType) {
        return false;
      }
      if (shift) {
        if (entry.journal_id !== shift.journal_id) {
          return false;
        }
        if (
          entry.performed_at < shift.period_start ||
          entry.performed_at > shift.period_end
        ) {
          return false;
        }
      }
      if (filter === 'pending') {
        return entry.sync_status !== 'synced' || entry.status === 'deleted';
      }
      if (filter === 'verified') {
        return Boolean(entry.verified_at);
      }
      return true;
    });
  }, [data, filter, journalId, eventType, shift]);

  const workTypeName = (id: string): string =>
    data?.workTypes.find((type) => type.id === id)?.name ?? 'Тип работы';

  const visibleCount = useMemo(
    () =>
      data
        ? data.entries.filter(
            (entry) => !journalId || entry.journal_id === journalId,
          ).length
        : 0,
    [data, journalId],
  );

  const filtersActive = Boolean(
    journalId || eventType || shiftId || search.trim(),
  );

  const clearFilters = (): void => {
    setSearch('');
    setJournalId('');
    setEventType('');
    setSearchParams({});
  };

  const exportCsv = async (): Promise<void> => {
    setExportError(null);
    try {
      const blob = await api.exportJournalCsv(undefined, undefined, journalId || undefined);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `logbook-journal-${new Date().toISOString().slice(0, 10)}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : 'Не удалось выгрузить CSV',
      );
    }
  };

  if (!data) {
    return <Loader label="Читаем локальный журнал…" />;
  }

  return (
    <div className="screen">
      <PageHeader
        title={journalId ? journalName(journalId, data.journals) : 'Журнал'}
        subtitle={`${visibleCount} записей на устройстве`}
        action={
          <div className="actions actions--wrap">
            <Link to="/groundings" className="button button--ghost">
              Заземления
            </Link>
            <Link to="/journal/print" className="button button--ghost">
              Печать
            </Link>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void exportCsv()}
            >
              CSV
            </button>
            <Link
              to={
                journalId
                  ? `/entries/new?journal_id=${journalId}`
                  : '/entries/new'
              }
              className="button button--primary"
            >
              + Запись
            </Link>
          </div>
        }
      />

      {exportError ? (
        <div className="alert alert--danger" role="alert">
          {exportError}
        </div>
      ) : null}

      {shift ? (
        <div className="alert alert--info shift-context" role="status">
          <div>
            <strong>Записи смены</strong> · {formatDate(shift.shift_date)} ·{' '}
            {formatDateTime(shift.period_start)} —{' '}
            {formatDateTime(shift.period_end)}{' '}
            <Badge tone={shiftStatusTone(shift.status)}>
              {shiftStatusLabel(shift.status)}
            </Badge>
          </div>
          <div className="actions actions--wrap">
            <Link to="/shifts" className="button button--ghost button--small">
              К сменам
            </Link>
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={clearFilters}
            >
              Сбросить
            </button>
          </div>
        </div>
      ) : null}

      {shiftMissing ? (
        <div className="alert alert--warning" role="status">
          Смена не найдена в локальном кэше. Обновите данные или откройте журнал
          без фильтра.{' '}
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={clearFilters}
          >
            Сбросить фильтр
          </button>
        </div>
      ) : null}

      <div className="toolbar">
        <input
          type="search"
          className="input"
          placeholder="Поиск по тексту или наряду"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Поиск записей"
        />
        <label className="field field--inline">
          <span>Журнал</span>
          <select
            value={journalId}
            onChange={(event) => setJournalId(event.target.value)}
            aria-label="Фильтр по журналу"
          >
            <option value="">Все журналы</option>
            {data.journals.map((journal) => (
              <option key={journal.id} value={journal.id}>
                {journal.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field field--inline">
          <span>Событие</span>
          <select
            value={eventType}
            onChange={(event) =>
              setEventType(event.target.value as EventFilter)
            }
            aria-label="Фильтр по типу события"
          >
            <option value="">Все события</option>
            {EVENT_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {filtersActive ? (
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={clearFilters}
          >
            Сбросить
          </button>
        ) : null}
        <button
          type="button"
          className="button button--ghost"
          disabled={syncing}
          onClick={() => void sync()}
        >
          {syncing ? 'Синхронизация…' : 'Обновить'}
        </button>
      </div>

      <div className="segmented" role="tablist" aria-label="Фильтр записей">
        {(
          [
            ['all', 'Все'],
            ['pending', 'Ожидают'],
            ['verified', 'Проверенные'],
          ] as Array<[Filter, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={filter === value}
            className={filter === value ? 'is-active' : ''}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={search ? 'Ничего не найдено' : 'Журнал пока пуст'}
          description={
            search
              ? 'Измените запрос или сбросьте фильтр.'
              : 'Создайте первую запись — она сохранится локально даже без сети.'
          }
          action={
            <Link to="/entries/new" className="button button--primary">
              Создать запись
            </Link>
          }
        />
      ) : (
        <ul className="entry-list">
          {filtered.map((entry) => (
            <li key={entry.id}>
              <Link to={`/entries/${entry.id}`} className="entry-card">
                <div className="entry-card__top">
                  <span className="entry-card__time">
                    {formatDateTime(entry.performed_at)}
                  </span>
                  <SyncBadge status={entry.sync_status} />
                </div>
                <div className="entry-card__meta entry-card__meta--top">
                  <span>
                    № {entry.journal_seq ?? 'после синхронизации'}
                  </span>
                  <Badge tone={eventTypeTone(entry.event_type)}>
                    {eventTypeLabel(entry.event_type)}
                  </Badge>
                  {entry.late_entry ? (
                    <span className="entry-card__risk">Пропущенная запись</span>
                  ) : null}
                </div>
                <p className="entry-card__text">{entry.text}</p>
                <div className="entry-card__meta">
                  <span>{workTypeName(entry.work_type_id)}</span>
                  <span>{journalName(entry.journal_id, data.journals)}</span>
                  {entry.permit_number_raw ? (
                    <span className="entry-card__permit">
                      Наряд {entry.permit_number_raw}
                    </span>
                  ) : null}
                  {entry.permit_risk_flag ? (
                    <span className="entry-card__risk">Риск</span>
                  ) : null}
                  {entry.verified_at ? (
                    <span className="entry-card__verified">Проверена</span>
                  ) : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
