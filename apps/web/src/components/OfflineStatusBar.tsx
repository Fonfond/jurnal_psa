import { Link } from 'react-router-dom';
import { useOnline } from '../hooks/useOnline';
import { useSyncStore } from '../stores/sync';
import { formatDateTime } from '../utils/format';

/**
 * Offline queue status shared by the operational screens (S-15 shifts,
 * S-16 groundings, S-05 entry card): how many local changes wait for the
 * network, how many failed, and when the last successful sync happened.
 */
export function OfflineStatusBar({
  compact = false,
}: {
  compact?: boolean;
}): JSX.Element {
  const online = useOnline();
  const status = useSyncStore((state) => state.status);
  const pending = useSyncStore((state) => state.pending);
  const dead = useSyncStore((state) => state.dead);
  const conflicts = useSyncStore((state) => state.conflicts);
  const lastSync = useSyncStore((state) => state.lastSync);
  const sync = useSyncStore((state) => state.sync);
  const syncing = status === 'syncing';

  const parts: string[] = [];
  if (!online) {
    parts.push(
      pending > 0
        ? `Офлайн: ${pending} изменений сохранено на устройстве`
        : 'Офлайн: новые изменения сохранятся на устройстве',
    );
  } else if (pending > 0) {
    parts.push(`${pending} изменений ожидают отправки`);
  } else {
    parts.push('Все изменения синхронизированы');
  }
  if (dead > 0) {
    parts.push(`${dead} операций с ошибкой`);
  }
  if (conflicts > 0) {
    parts.push(`${conflicts} конфликтов`);
  }

  return (
    <div
      className={`offline-bar${online ? '' : ' offline-bar--offline'}${compact ? ' offline-bar--compact' : ''}`}
      role="status"
      aria-label="Состояние офлайн-очереди"
      data-testid="offline-status-bar"
    >
      <span className={`offline-bar__dot${online ? '' : ' is-offline'}`} aria-hidden="true" />
      <span className="offline-bar__text">{parts.join(' · ')}</span>
      {!compact ? (
        <>
          {lastSync ? (
            <span className="muted">обновлено {formatDateTime(lastSync)}</span>
          ) : null}
          {dead > 0 || conflicts > 0 ? (
            <Link to={dead > 0 ? '/sync' : '/conflicts'} className="offline-bar__link">
              {dead > 0 ? 'Разобрать очередь' : 'Открыть конфликты'}
            </Link>
          ) : null}
          <button
            type="button"
            className="button button--ghost button--small"
            disabled={syncing || !online}
            onClick={() => void sync()}
          >
            {syncing ? 'Синхронизация…' : 'Синхронизировать'}
          </button>
        </>
      ) : null}
    </div>
  );
}
