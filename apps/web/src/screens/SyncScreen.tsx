import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../db/schema';
import { allOperations, retryDeadOperation } from '../db/repositories';
import { isSupervisorCacheRole } from '../db/supervisor-cache';
import { useSyncStore } from '../stores/sync';
import { useAuthStore } from '../stores/auth';
import { PageHeader } from '../components/Page';
import { Badge } from '../components/Badge';
import { formatDateTime } from '../utils/format';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export function SyncScreen(): JSX.Element {
  const status = useSyncStore((state) => state.status);
  const pending = useSyncStore((state) => state.pending);
  const dead = useSyncStore((state) => state.dead);
  const conflicts = useSyncStore((state) => state.conflicts);
  const lastSync = useSyncStore((state) => state.lastSync);
  const error = useSyncStore((state) => state.error);
  const sync = useSyncStore((state) => state.sync);
  const cache = useSyncStore((state) => state.cache);
  const backgroundSync = useSyncStore((state) => state.backgroundSync);
  const refresh = useSyncStore((state) => state.refresh);
  const refreshCache = useSyncStore((state) => state.refreshSupervisorCache);
  const session = useAuthStore((state) => state.session);
  const user = useAuthStore((state) => state.user);
  const pinConfigured = useAuthStore((state) => state.pinConfigured);
  const setPin = useAuthStore((state) => state.setPin);
  const removePin = useAuthStore((state) => state.removePin);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [pin, setPinInput] = useState('');
  const [pinBusy, setPinBusy] = useState(false);
  const [pinMessage, setPinMessage] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);

  const savePin = async (): Promise<void> => {
    setPinBusy(true);
    setPinError(null);
    setPinMessage(null);
    try {
      await setPin(pin.trim());
      setPinInput('');
      setPinMessage('PIN сохранён: после «Заблокировать» журнал открывается PIN-кодом офлайн.');
    } catch (caught) {
      setPinError(caught instanceof Error ? caught.message : 'Не удалось сохранить PIN');
    } finally {
      setPinBusy(false);
    }
  };

  const clearPin = async (): Promise<void> => {
    setPinBusy(true);
    setPinError(null);
    setPinMessage(null);
    try {
      await removePin();
      setPinMessage('PIN удалён: разблокировка будет только по паролю.');
    } catch (caught) {
      setPinError(caught instanceof Error ? caught.message : 'Не удалось удалить PIN');
    } finally {
      setPinBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const operations = useLiveQuery(() => allOperations(), []);
  const entries = useLiveQuery(() => db.entries.toArray(), []);
  const entryText = (id: string): string =>
    entries?.find((entry) => entry.id === id)?.text.slice(0, 80) ?? id.slice(0, 8);


  return (
    <div className="screen">
      <PageHeader
        title="Синхронизация"
        subtitle="Очередь операций и состояние отправки"
        action={
          <button
            type="button"
            className="button button--primary"
            disabled={status === 'syncing'}
            onClick={() => void sync()}
          >
            {status === 'syncing' ? 'Синхронизация…' : 'Синхронизировать'}
          </button>
        }
      />

      <div className="stats-grid">
        <div className="stat">
          <span className="stat__value">{pending}</span>
          <span className="stat__label">Ожидают</span>
        </div>
        <div className="stat">
          <span className="stat__value">{dead}</span>
          <span className="stat__label">Ошибки</span>
        </div>
        <div className="stat">
          <span className="stat__value">{conflicts}</span>
          <span className="stat__label">Конфликты</span>
        </div>
      </div>

      <div className="card">
        <dl className="detail-grid">
          <div>
            <dt>Последняя синхронизация</dt>
            <dd>{lastSync ? formatDateTime(lastSync) : 'ещё не было'}</dd>
          </div>
          <div>
            <dt>Статус</dt>
            <dd>{status === 'offline' ? 'офлайн' : status}</dd>
          </div>
          <div>
            <dt>Сессия офлайн до</dt>
            <dd>
              {session
                ? formatDateTime(session.offline_valid_until)
                : '—'}
            </dd>
          </div>
        </dl>
        {error ? (
          <div className="alert alert--danger" role="alert">
            {error}
          </div>
        ) : null}
        {conflicts > 0 ? (
          <p>
            Есть неразобранные конфликты.{' '}
            <Link to="/conflicts">Открыть разбор</Link>
          </p>
        ) : null}
      </div>

      <section className="card" aria-label="Фоновая синхронизация">
        <h2>Фоновая синхронизация</h2>
        {backgroundSync ? (
          <>
            <dl className="detail-grid">
              <div>
                <dt>Background Sync</dt>
                <dd>{backgroundSync.registered ? 'зарегистрирован' : 'недоступен'}</dd>
              </div>
              <div>
                <dt>Periodic Sync</dt>
                <dd>{backgroundSync.periodic ? 'зарегистрирован' : 'недоступен'}</dd>
              </div>
              <div>
                <dt>Проверено</dt>
                <dd>{formatDateTime(backgroundSync.at)}</dd>
              </div>
            </dl>
            <p className="hint">{backgroundSync.capabilities.message}</p>
          </>
        ) : (
          <p className="muted">Возможности браузера проверяются…</p>
        )}
      </section>

      <section className="card" aria-label="Безопасность устройства">
        <h2>Безопасность</h2>
        <p className="hint">
          PIN нужен для разблокировки после кнопки «Заблокировать» и для
          восстановления офлайн-сессии после перезагрузки без сети. Хранится
          только PBKDF2-хэш (соль + 150 000 итераций) в IndexedDB устройства;
          сам PIN не сохраняется. IndexedDB не шифруется (ADR-20).
        </p>
        <p>
          Статус:{' '}
          <Badge tone={pinConfigured ? 'success' : 'neutral'}>
            {pinConfigured ? 'PIN задан' : 'PIN не задан'}
          </Badge>
        </p>
        <form
          className="form-row"
          onSubmit={(event) => {
            event.preventDefault();
            void savePin();
          }}
        >
          <label className="field">
            <span>{pinConfigured ? 'Новый PIN (4–8 цифр)' : 'PIN (4–8 цифр)'}</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              pattern="\d{4,8}"
              maxLength={8}
              value={pin}
              onChange={(event) => setPinInput(event.target.value)}
              aria-label="PIN для разблокировки"
            />
          </label>
          <button
            type="submit"
            className="button button--primary button--small"
            disabled={pinBusy || pin.trim().length < 4}
          >
            {pinBusy ? 'Сохраняем…' : pinConfigured ? 'Сменить PIN' : 'Задать PIN'}
          </button>
          {pinConfigured ? (
            <button
              type="button"
              className="button button--ghost button--small"
              disabled={pinBusy}
              onClick={() => void clearPin()}
            >
              Удалить PIN
            </button>
          ) : null}
        </form>
        {pinError ? (
          <div className="alert alert--danger" role="alert">
            {pinError}
          </div>
        ) : null}
        {pinMessage ? (
          <div className="alert alert--success" role="status">
            {pinMessage}
          </div>
        ) : null}
      </section>

      {user && isSupervisorCacheRole(user.role) ? (
        <section className="card" aria-label="Кэш руководителя">
          <div className="card__header">
            <h2>Кэш руководителя</h2>
            <button
              type="button"
              className="button button--ghost button--small"
              disabled={cacheBusy}
              onClick={() => {
                setCacheBusy(true);
                void refreshCache().finally(() => setCacheBusy(false));
              }}
            >
              {cacheBusy ? 'Обновление…' : 'Обновить кэш'}
            </button>
          </div>
          {cache && cache.enabled ? (
            <>
              <dl className="detail-grid">
                <div>
                  <dt>Период</dt>
                  <dd>{cache.window_days} дней</dd>
                </div>
                <div>
                  <dt>Записей в кэше</dt>
                  <dd>{cache.entries}</dd>
                </div>
                <div>
                  <dt>Объём</dt>
                  <dd>
                    {formatBytes(cache.bytes)} из {formatBytes(cache.budget_bytes)}
                  </dd>
                </div>
                <div>
                  <dt>Обновлён</dt>
                  <dd>{cache.updated_at ? formatDateTime(cache.updated_at) : '—'}</dd>
                </div>
              </dl>
              <ul className="outbox-list">
                {cache.journals.map((journal) => (
                  <li key={journal.journal_id} className="outbox-item">
                    <div className="outbox-item__top">
                      <strong>{journal.journal_id.slice(0, 8)}</strong>
                      <Badge tone="info">{journal.entries} записей</Badge>
                    </div>
                    <div className="outbox-item__meta">
                      <span>визы: {journal.reviews}</span>
                      <span>{formatBytes(journal.bytes)}</span>
                      <span>
                        {formatDateTime(journal.window_from)} —{' '}
                        {formatDateTime(journal.window_to)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="muted">
              Кэш ещё не сформирован: он обновляется при синхронизации (последние{' '}
              {cache?.window_days ?? 7} дней журнала).
            </p>
          )}
        </section>
      ) : null}

      <section className="card">
        <h2>Очередь</h2>
        {!operations || operations.length === 0 ? (
          <p className="muted">Все операции отправлены.</p>
        ) : (
          <ul className="outbox-list">
            {operations.map((operation) => (
              <li key={operation.op_id} className="outbox-item">
                <div className="outbox-item__top">
                  <strong>{operation.op_type}</strong>
                  <Badge
                    tone={
                      operation.status === 'dead'
                        ? 'danger'
                        : operation.status === 'in_flight'
                          ? 'info'
                          : 'warning'
                    }
                  >
                    {operation.status}
                  </Badge>
                </div>
                <p className="outbox-item__text">{entryText(operation.entity_id)}</p>
                <div className="outbox-item__meta">
                  <span>попытки: {operation.attempts}</span>
                  {operation.next_attempt_at ? (
                    <span>следующая: {formatDateTime(operation.next_attempt_at)}</span>
                  ) : null}
                  {operation.last_error_message ? (
                    <span className="error-text">{operation.last_error_message}</span>
                  ) : null}
                </div>
                {operation.status === 'dead' ? (
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    onClick={() => {
                      void retryDeadOperation(operation.op_id).then(() =>
                        sync(),
                      );
                    }}
                  >
                    Повторить
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
