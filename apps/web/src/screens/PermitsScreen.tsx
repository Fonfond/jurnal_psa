import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { api } from '../api/client';
import type { PermitPdfLink } from '../api/types';
import { db } from '../db/schema';
import { useSyncStore } from '../stores/sync';
import { EmptyState, Loader, PageHeader } from '../components/Page';
import { Badge } from '../components/Badge';
import { formatDate, formatDateTime } from '../utils/format';

export function PermitsScreen(): JSX.Element {
  const [search, setSearch] = useState('');
  const sync = useSyncStore((state) => state.sync);
  const syncing = useSyncStore((state) => state.status === 'syncing');

  const permits = useLiveQuery(async () => {
    const rows = await db.permits.toArray();
    const query = search.trim().toLowerCase();
    return rows
      .filter((permit) => !permit.is_deleted)
      .filter(
        (permit) =>
          !query ||
          permit.number.toLowerCase().includes(query) ||
          permit.work_description.toLowerCase().includes(query),
      )
      .sort((left, right) => left.number.localeCompare(right.number));
  }, [search]);

  if (!permits) {
    return <Loader label="Читаем наряды…" />;
  }

  return (
    <div className="screen">
      <PageHeader
        title="Наряды"
        subtitle="Справочник для привязки записей"
        action={
          <button
            type="button"
            className="button button--ghost"
            disabled={syncing}
            onClick={() => void sync()}
          >
            {syncing ? 'Обновление…' : 'Обновить'}
          </button>
        }
      />

      <input
        type="search"
        className="input"
        placeholder="Номер или описание работ"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        aria-label="Поиск нарядов"
      />

      {permits.length === 0 ? (
        <EmptyState
          title="Нарядов нет"
          description="Импорт CSV выполняется администратором; после синхронизации наряды появятся здесь."
        />
      ) : (
        <ul className="permit-list">
          {permits.map((permit) => (
            <li key={permit.id}>
              <Link to={`/permits/${permit.id}`} className="permit-card">
                <div className="permit-card__top">
                  <strong>{permit.number}</strong>
                  <Badge
                    tone={
                      permit.status === 'active'
                        ? 'success'
                        : permit.status === 'annulled'
                          ? 'danger'
                          : 'neutral'
                    }
                  >
                    {permit.status}
                  </Badge>
                </div>
                <p>{permit.work_description}</p>
                <div className="permit-card__meta">
                  <span>
                    {formatDate(permit.valid_from)} — {formatDate(permit.valid_to)}
                  </span>
                  <span>v{permit.version}</span>
                  {permit.pdf_url || permit.pdf_hash ? <span>PDF</span> : null}
                  {permit.external_url ? <span>deep link</span> : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">
        PDF наряда формируется сервером, ссылка подписывается и действует не более
        15 минут; при наличии внешнего PDF открывается deep link источника.
      </p>
    </div>
  );
}

export function PermitDetailScreen(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [message, setMessage] = useState<string | null>(null);
  const [pdfInfo, setPdfInfo] = useState<PermitPdfLink | null>(null);
  const [busy, setBusy] = useState(false);

  const permit = useLiveQuery(
    async () => (id ? ((await db.permits.get(id)) ?? null) : null),
    [id],
  );

  if (permit === undefined) {
    return <Loader label="Загружаем наряд…" />;
  }
  if (!permit) {
    return (
      <div className="screen">
        <PageHeader title="Наряд не найден" />
        <Link to="/permits" className="button button--ghost">
          К нарядам
        </Link>
      </div>
    );
  }

  return (
    <div className="screen">
      <PageHeader
        title={`Наряд ${permit.number}`}
        subtitle={permit.work_description}
        action={
          <Link to="/permits" className="button button--ghost">
            Назад
          </Link>
        }
      />
      <article className="card">
        <dl className="detail-grid">
          <div>
            <dt>Статус</dt>
            <dd>{permit.status}</dd>
          </div>
          <div>
            <dt>Год</dt>
            <dd>{permit.year}</dd>
          </div>
          <div>
            <dt>Действует с</dt>
            <dd>{formatDate(permit.valid_from)}</dd>
          </div>
          <div>
            <dt>Действует до</dt>
            <dd>{formatDate(permit.valid_to)}</dd>
          </div>
          <div>
            <dt>Версия</dt>
            <dd>{permit.version}</dd>
          </div>
          <div>
            <dt>Источник</dt>
            <dd>{permit.source_id}</dd>
          </div>
        </dl>

        {permit.external_url ? (
          <p>
            <a href={permit.external_url} target="_blank" rel="noreferrer">
              Открыть во внешней системе (deep link)
            </a>
          </p>
        ) : null}

        <div className="actions actions--wrap">
          <button
            type="button"
            className="button button--ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setMessage(null);
              void api
                .permitPdfUrl(permit.id)
                .then((result) => {
                  setPdfInfo(result);
                  const target =
                    result.source === 'external'
                      ? (result.pdf_url ?? result.url)
                      : result.url;
                  window.open(target, '_blank', 'noreferrer');
                })
                .catch((error: unknown) => {
                  setMessage(
                    error instanceof Error
                      ? error.message
                      : 'PDF недоступен. OQ-03',
                  );
                })
                .finally(() => setBusy(false));
            }}
          >
            PDF наряда
          </button>
          {permit.pdf_url ? (
            <a
              href={permit.pdf_url}
              target="_blank"
              rel="noreferrer"
              className="button button--ghost"
            >
              PDF источника
            </a>
          ) : null}
        </div>

        {pdfInfo ? (
          <p className="hint">
            {pdfInfo.source === 'external'
              ? 'PDF внешнего источника'
              : 'PDF сформирован сервером'}{' '}
            · hash {pdfInfo.hash?.slice(0, 16) ?? '—'}… ·{' '}
            {pdfInfo.size_bytes ? `${Math.round(pdfInfo.size_bytes / 1024)} КБ` : 'размер неизвестен'}{' '}
            · ссылка до {formatDateTime(pdfInfo.expires_at)}
          </p>
        ) : null}
        {message ? <div className="alert alert--warning">{message}</div> : null}
      </article>
    </div>
  );
}
