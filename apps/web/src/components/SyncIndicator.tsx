import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useOnline } from '../hooks/useOnline';
import { useSyncStore } from '../stores/sync';

export function SyncIndicator(): JSX.Element {
  const online = useOnline();
  const status = useSyncStore((state) => state.status);
  const pending = useSyncStore((state) => state.pending);
  const conflicts = useSyncStore((state) => state.conflicts);
  const refresh = useSyncStore((state) => state.refresh);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  let label = 'Синхронизировано';
  let tone = 'ok';
  if (!online) {
    label = 'Офлайн';
    tone = 'offline';
  } else if (status === 'syncing') {
    label = 'Синхронизация…';
    tone = 'syncing';
  } else if (conflicts > 0) {
    label = `Конфликт: ${conflicts}`;
    tone = 'conflict';
  } else if (pending > 0) {
    label = `Ожидает: ${pending}`;
    tone = 'pending';
  } else if (status === 'error') {
    label = 'Ошибка синхронизации';
    tone = 'error';
  }

  return (
    <Link to="/sync" className={`sync-indicator sync-indicator--${tone}`}>
      <span className="sync-indicator__dot" aria-hidden="true" />
      {label}
    </Link>
  );
}
