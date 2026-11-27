import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import type { ShiftStatus } from '@logbook/shared';
import { useAuthStore } from '../stores/auth';
import { useSyncStore } from '../stores/sync';
import { listLocalJournals } from '../db/repositories';
import {
  acceptShiftLocal,
  createShiftLocal,
  listLocalShifts,
  rejectShiftLocal,
  resolveShiftConflict,
} from '../db/shift-repositories';
import { EmptyState, Loader, PageHeader } from '../components/Page';
import { Badge, SyncBadge } from '../components/Badge';
import { OfflineStatusBar } from '../components/OfflineStatusBar';
import { SignatureHint, SignatureList } from '../components/SignatureHint';
import { shiftStatusLabel, shiftStatusTone } from '../utils/events';
import {
  formatDate,
  formatDateTime,
  fromDateTimeInput,
  toDateTimeInput,
} from '../utils/format';

const STATUS_FILTERS: Array<[ShiftStatus, string]> = [
  ['handed_over', 'Ожидают приёмки'],
  ['accepted', 'Принятые'],
  ['rejected', 'Отклонённые'],
];

function defaultDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultWindow(date: string): { start: string; end: string } {
  return {
    start: `${date}T08:00`,
    end: `${date}T20:00`,
  };
}

/**
 * S-15 «Смены»: offline-first handover and two-sided acceptance (JRN-02).
 * The screen never blocks on the network: handover/accept/reject are written
 * locally and replayed by the sync engine.
 */
export function ShiftsScreen(): JSX.Element {
  const user = useAuthStore((state) => state.user);
  const signatureInfo = useAuthStore((state) => state.signature);
  const sync = useSyncStore((state) => state.sync);
  const canManage = user?.role === 'supervisor' || user?.role === 'admin';

  const [journalId, setJournalId] = useState('');
  const [shiftDate, setShiftDate] = useState(defaultDate());
  const initialWindow = defaultWindow(defaultDate());
  const [periodStart, setPeriodStart] = useState(initialWindow.start);
  const [periodEnd, setPeriodEnd] = useState(initialWindow.end);
  const [comment, setComment] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | ShiftStatus>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [printId, setPrintId] = useState<string | null>(null);

  const data = useLiveQuery(async () => {
    const [shifts, journals] = await Promise.all([
      listLocalShifts(),
      listLocalJournals(),
    ]);
    return { shifts, journals };
  }, []);

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.shifts.filter(
      (shift) => !statusFilter || shift.status === statusFilter,
    );
  }, [data, statusFilter]);

  const activeJournalId = journalId || data?.journals[0]?.id || '';

  if (!data) {
    return <Loader label="Читаем смены…" />;
  }

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      void sync();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Не удалось сохранить смену',
      );
    } finally {
      setBusy(false);
    }
  };

  const submitHandover = async (): Promise<void> => {
    if (!canManage) return;
    if (comment.trim().length < 5) {
      setError('Комментарий к сдаче смены должен быть не короче 5 символов');
      return;
    }
    if (Date.parse(fromDateTimeInput(periodEnd)) <= Date.parse(fromDateTimeInput(periodStart))) {
      setError('Конец смены должен быть позже начала');
      return;
    }
    await run(async () => {
      await createShiftLocal(
        {
          journal_id: activeJournalId,
          shift_date: shiftDate,
          period_start: fromDateTimeInput(periodStart),
          period_end: fromDateTimeInput(periodEnd),
          handover_comment: comment.trim(),
        },
        user!,
      );
      setComment('');
      setRejectingId(null);
    });
  };

  const accept = async (id: string): Promise<void> => {
    await run(async () => {
      await acceptShiftLocal(id, 'Смена принята, замечаний нет', user!);
    });
  };

  const reject = async (id: string): Promise<void> => {
    if (rejectReason.trim().length < 3) {
      setError('Укажите причину отклонения смены');
      return;
    }
    await run(async () => {
      await rejectShiftLocal(id, rejectReason.trim(), user!);
      setRejectingId(null);
      setRejectReason('');
    });
  };

  const printShift = (id: string): void => {
    setPrintId(id);
    window.setTimeout(() => window.print(), 50);
  };

  const printShiftData = data.shifts.find((shift) => shift.id === printId);

  return (
    <div className="screen">
      <PageHeader
        title="Смены"
        subtitle="Сдача и приёмка смены: двусторонние подписи, работа без сети"
        action={
          <button
            type="button"
            className="button button--ghost"
            disabled={busy}
            onClick={() => void sync()}
          >
            Синхронизировать
          </button>
        }
      />

      {error ? (
        <div className="alert alert--danger" role="alert">
          {error}
        </div>
      ) : null}

      <OfflineStatusBar />

      {canManage ? (
        <form
          className="form card"
          onSubmit={(event) => {
            event.preventDefault();
            void submitHandover();
          }}
        >
          <h2>Сдать смену</h2>
          <div className="form-row">
            <label className="field">
              <span>Журнал *</span>
              <select
                value={activeJournalId}
                onChange={(event) => setJournalId(event.target.value)}
                aria-label="Журнал смены"
              >
                {data.journals.map((journal) => (
                  <option key={journal.id} value={journal.id}>
                    {journal.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Дата смены *</span>
              <input
                type="date"
                value={shiftDate}
                onChange={(event) => {
                  const next = event.target.value;
                  setShiftDate(next);
                  const window = defaultWindow(next || defaultDate());
                  setPeriodStart(window.start);
                  setPeriodEnd(window.end);
                }}
                aria-label="Дата смены"
                required
              />
            </label>
          </div>
          <div className="form-row">
            <label className="field">
              <span>Начало смены *</span>
              <input
                type="datetime-local"
                value={periodStart}
                onChange={(event) => setPeriodStart(event.target.value)}
                aria-label="Начало смены"
                required
              />
            </label>
            <label className="field">
              <span>Конец смены *</span>
              <input
                type="datetime-local"
                value={periodEnd}
                onChange={(event) => setPeriodEnd(event.target.value)}
                aria-label="Конец смены"
                required
              />
            </label>
          </div>
          <label className="field">
            <span>Комментарий к сдаче *</span>
            <textarea
              rows={3}
              maxLength={1000}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              aria-label="Комментарий к сдаче"
              required
            />
          </label>
          <button type="submit" className="button button--primary" disabled={busy}>
            {busy ? 'Сохраняем…' : 'Сдать смену'}
          </button>
          <SignatureHint signature={signatureInfo} context="сдачу смены" />
          <p className="hint">
            Смена уйдёт на сервер при подключении. Входящий руководитель принимает
            её в этом же экране; подписи формируются настроенным ЭП-адаптером.
          </p>
        </form>
      ) : (
        <div className="alert alert--warning">
          Сдачу и приёмку смены выполняет руководитель или администратор.
        </div>
      )}

      <div className="toolbar">
        <label className="field field--inline">
          <span>Статус</span>
          <select
            value={statusFilter}
            onChange={(event) =>
              setStatusFilter(event.target.value as '' | ShiftStatus)
            }
            aria-label="Фильтр смен по статусу"
          >
            <option value="">Все</option>
            {STATUS_FILTERS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="Смен пока нет"
          description="Сдайте смену — запись сохранится локально и уйдёт на сервер при подключении."
        />
      ) : (
        <ul className="entry-list">
          {filtered.map((shift) => {
            const incoming = user && shift.handed_over_by !== user.id;
            return (
              <li key={shift.id}>
                <article className="entry-card">
                  <div className="entry-card__top">
                    <span className="entry-card__time">
                      {formatDate(shift.shift_date)} · {formatDateTime(shift.period_start)} —{' '}
                      {formatDateTime(shift.period_end)}
                    </span>
                    <SyncBadge status={shift.sync_status} />
                  </div>
                  <div className="entry-card__meta entry-card__meta--top">
                    <Badge tone={shiftStatusTone(shift.status)}>
                      {shiftStatusLabel(shift.status)}
                    </Badge>
                    <span>
                      Записей в смене: {shift.entries_count}
                    </span>
                  </div>
                  <p className="entry-card__text">{shift.handover_comment}</p>
                  <div className="entry-card__meta">
                    <span>Сдал: {shift.handed_over_by_name ?? shift.handed_over_by}</span>
                    {shift.accepted_by ? (
                      <span>
                        Принял: {shift.accepted_by_name ?? shift.accepted_by}
                      </span>
                    ) : null}
                    {shift.rejection_reason ? (
                      <span className="entry-card__risk">
                        Причина: {shift.rejection_reason}
                      </span>
                    ) : null}
                    {shift.content_hash ? (
                      <span>hash: {shift.content_hash.slice(0, 12)}…</span>
                    ) : null}
                  </div>

                  {shift.signatures && shift.signatures.length > 0 ? (
                    <SignatureList
                      signatures={shift.signatures}
                      title="Подписи смены"
                    />
                  ) : shift.sync_status !== 'synced' ? (
                    <p className="hint">
                      Подписи появятся после синхронизации смены с сервером.
                    </p>
                  ) : null}

                  {canManage && shift.status === 'handed_over' && incoming ? (
                    <SignatureHint
                      signature={signatureInfo}
                      context="приёмку смены"
                      compact
                    />
                  ) : null}

                  {shift.sync_status === 'conflict' ? (
                    <div className="alert alert--warning">
                      {shift.sync_error ?? 'Смена изменена на сервере'}
                      <button
                        type="button"
                        className="button button--ghost button--small"
                        onClick={() =>
                          void run(async () => {
                            await sync();
                            await resolveShiftConflict(shift.id);
                          })
                        }
                      >
                        Сверить с сервером
                      </button>
                    </div>
                  ) : null}

                  <div className="actions actions--wrap">
                    {canManage && shift.status === 'handed_over' && incoming ? (
                      <>
                        <button
                          type="button"
                          className="button button--primary button--small"
                          disabled={busy}
                          onClick={() => void accept(shift.id)}
                        >
                          Принять смену
                        </button>
                        <button
                          type="button"
                          className="button button--ghost button--small"
                          disabled={busy}
                          onClick={() =>
                            setRejectingId(rejectingId === shift.id ? null : shift.id)
                          }
                        >
                          Отклонить
                        </button>
                      </>
                    ) : null}
                    <button
                      type="button"
                      className="button button--ghost button--small"
                      onClick={() => printShift(shift.id)}
                    >
                      Печать
                    </button>
                    <Link
                      to={`/?shift_id=${shift.id}`}
                      className="button button--ghost button--small"
                    >
                      Записи смены
                    </Link>
                  </div>

                  {rejectingId === shift.id ? (
                    <div className="form-row">
                      <label className="field">
                        <span>Причина отклонения *</span>
                        <input
                          value={rejectReason}
                          onChange={(event) => setRejectReason(event.target.value)}
                          aria-label="Причина отклонения смены"
                          maxLength={500}
                        />
                      </label>
                      <button
                        type="button"
                        className="button button--danger button--small"
                        disabled={busy}
                        onClick={() => void reject(shift.id)}
                      >
                        Подтвердить отклонение
                      </button>
                    </div>
                  ) : null}
                </article>
              </li>
            );
          })}
        </ul>
      )}

      {printShiftData ? (
        <article className="print-sheet" aria-label="Печатная форма смены">
          <header className="print-sheet__header">
            <h1>Акт сдачи-приёмки смены</h1>
            <p>
              {formatDate(printShiftData.shift_date)} ·{' '}
              {formatDateTime(printShiftData.period_start)} —{' '}
              {formatDateTime(printShiftData.period_end)}
            </p>
          </header>
          <table className="print-table">
            <tbody>
              <tr>
                <th>Статус</th>
                <td>{shiftStatusLabel(printShiftData.status)}</td>
              </tr>
              <tr>
                <th>Сдал</th>
                <td>
                  {printShiftData.handed_over_by_name ?? printShiftData.handed_over_by}
                  <br />
                  {formatDateTime(printShiftData.handed_over_at)}
                </td>
              </tr>
              <tr>
                <th>Принял</th>
                <td>
                  {printShiftData.accepted_by
                    ? `${printShiftData.accepted_by_name ?? printShiftData.accepted_by} · ${formatDateTime(printShiftData.accepted_at)}`
                    : '—'}
                </td>
              </tr>
              <tr>
                <th>Записей в смене</th>
                <td>{printShiftData.entries_count}</td>
              </tr>
              <tr>
                <th>Комментарий</th>
                <td>{printShiftData.handover_comment}</td>
              </tr>
              <tr>
                <th>Замечания при приёмке</th>
                <td>{printShiftData.acceptance_comment ?? printShiftData.rejection_reason ?? '—'}</td>
              </tr>
              <tr>
                <th>Подписи сторон</th>
                <td>
                  Сдающий: ______________ / Принимающий: ______________
                </td>
              </tr>
            </tbody>
          </table>
          <footer className="print-sheet__footer">
            <p>
              ЭП: {signatureInfo?.legal_note ?? 'подпись формируется настроенным адаптером; до OQ-04 простая ЭП не является КЭП.'}
            </p>
          </footer>
        </article>
      ) : null}
    </div>
  );
}
