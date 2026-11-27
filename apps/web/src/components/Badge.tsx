import type { ReactNode } from 'react';

export function SyncBadge({
  status,
}: {
  status: string | undefined;
}): JSX.Element {
  const normalized = status ?? 'synced';
  const labels: Record<string, string> = {
    pending: 'Ожидает',
    syncing: 'Отправка',
    synced: 'Синхронизировано',
    conflict: 'Конфликт',
    error: 'Ошибка',
  };
  return (
    <span className={`badge badge--${normalized}`}>
      {labels[normalized] ?? normalized}
    </span>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
}): JSX.Element {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}
