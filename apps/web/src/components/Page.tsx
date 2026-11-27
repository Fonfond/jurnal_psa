import type { ReactNode } from 'react';

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p className="page-header__subtitle">{subtitle}</p> : null}
      </div>
      {action ? <div className="page-header__action">{action}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="empty-state">
      <div className="empty-state__icon" aria-hidden="true">
        ▤
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Loader({ label = 'Загрузка…' }: { label?: string }): JSX.Element {
  return (
    <div className="loader" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}
