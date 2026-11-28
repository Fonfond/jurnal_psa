import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  DEFAULT_JOURNAL_ID,
  type EntryRevision,
  type SignatureRecord,
  type Shift,
} from '@logbook/shared';
import { api } from '../api/client';
import { db, type AttachmentRow } from '../db/schema';
import {
  applyServerEntry,
  deleteLocalAttachment,
  deleteLocalEntry,
  getLocalEntry,
  listLocalAttachments,
} from '../db/repositories';
import { useAuthStore } from '../stores/auth';
import { useSyncStore } from '../stores/sync';
import { Badge, SyncBadge } from '../components/Badge';
import { EventDetails } from '../components/EventDetails';
import { OfflineStatusBar } from '../components/OfflineStatusBar';
import { PageHeader, Loader } from '../components/Page';
import {
  SignatureBadge,
  SignatureHint,
  SignatureList,
} from '../components/SignatureHint';
import {
  eventTypeLabel,
  eventTypeTone,
  isOperationalEvent,
  journalFilterHref,
  shiftStatusLabel,
  shiftStatusTone,
} from '../utils/events';
import { formatDateTime, roleLabel } from '../utils/format';

/**
 * S-05 «Запись»: card with structured operational data (757 switching,
 * grounding), shift context (S-15), entry signatures (OQ-04) and honest
 * offline state. Verification and signing stay server-only and are disabled
 * while the local row still has pending outbox operations.
 */
export function EntryCardScreen(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const user = useAuthStore((state) => state.user);
  const signatureInfo = useAuthStore((state) => state.signature);
  const sync = useSyncStore((state) => state.sync);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signatures, setSignatures] = useState<SignatureRecord[]>([]);
  const [attachmentUrl, setAttachmentUrl] = useState<string | null>(null);
  const [localAttachmentUrl, setLocalAttachmentUrl] = useState<string | null>(null);
  const [bindSiteId, setBindSiteId] = useState('');

  const data = useLiveQuery(async () => {
    if (!id) return null;
    const entryData = await getLocalEntry(id);
    const permit = entryData.entry?.permit_id
      ? await db.permits.get(entryData.entry.permit_id)
      : null;
    const site = entryData.entry?.site_id
      ? await db.dict_sites.get(entryData.entry.site_id)
      : null;
    const sites = await db.dict_sites.toArray();
    let shift: Shift | null = null;
    if (entryData.entry) {
      const entry = entryData.entry;
      const shifts = await db.shifts
        .where('journal_id')
        .equals(entry.journal_id ?? DEFAULT_JOURNAL_ID)
        .toArray();
      shift =
        shifts.find(
          (row) =>
            entry.performed_at >= row.period_start &&
            entry.performed_at <= row.period_end,
        ) ?? null;
    }
    const attachments = await listLocalAttachments(id);
    return { ...entryData, permit, site, sites, shift, attachments };
  }, [id]);

  useEffect(() => {
    if (!id || !data?.entry || data.entry.sync_status !== 'synced') return;
    let cancelled = false;
    void api
      .entry(id)
      .then(async (server) => {
        if (cancelled) return;
        await applyServerEntry(server);
        const revisions = (server.revisions ?? []) as unknown as EntryRevision[];
        if (revisions.length > 0) {
          await db.revisions.bulkPut(revisions);
        }
        setSignatures(server.signatures ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id, data?.entry?.sync_status]);

  useEffect(() => {
    if (!id) return undefined;
    if (data?.attachments && data.attachments.length > 0) return undefined;
    void api
      .attachments(id)
      .then(async (response) => {
        if (response.items.length > 0) {
          await db.attachments.bulkPut(response.items as AttachmentRow[]);
        }
      })
      .catch(() => undefined);
    return undefined;
  }, [id, data?.attachments?.length]);

  const attachment: AttachmentRow | undefined = data?.attachments?.[0];
  useEffect(() => {
    if (!id || !attachment) return undefined;
    setAttachmentUrl(null);
    if (attachment.blob) {
      const url = URL.createObjectURL(attachment.blob);
      setLocalAttachmentUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    setLocalAttachmentUrl(null);
    const serverId = attachment.server_id ?? attachment.id;
    if (serverId) {
      void api
        .attachmentUrl(id, serverId)
        .then((response) => setAttachmentUrl(response.url))
        .catch(() => undefined);
    }
    return undefined;
  }, [id, attachment?.blob, attachment?.server_id, attachment?.id]);

  const removeAttachment = async (): Promise<void> => {
    if (!id || !attachment) return;
    if (!window.confirm('Удалить скан наряда? Оригинал бумажного наряда остаётся на объекте.')) {
      return;
    }
    setError(null);
    try {
      const serverId = attachment.server_id ?? (attachment.blob ? null : attachment.id);
      if (serverId) await api.deleteAttachment(id, serverId);
      await deleteLocalAttachment(attachment.id);
      setAttachmentUrl(null);
      setLocalAttachmentUrl(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось удалить скан');
    }
  };

  const bindSite = async (): Promise<void> => {
    if (!id || !data?.entry?.site_name_raw || !bindSiteId) return;
    setError(null);
    try {
      await api.bindSiteFromRaw(data.entry.site_name_raw, bindSiteId);
      const updated = await api.entry(id);
      await applyServerEntry(updated);
      setBindSiteId('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось привязать объект');
    }
  };

  if (!data) {
    return <Loader label="Загружаем запись…" />;
  }
  if (!data.entry) {
    return (
      <div className="screen">
        <PageHeader title="Запись не найдена" />
        <Link to="/" className="button button--ghost">
          В журнал
        </Link>
      </div>
    );
  }

  const entry = data.entry;
  const privileged = user?.role === 'supervisor' || user?.role === 'admin';
  const pending = entry.sync_status !== 'synced';
  const canSign = Boolean(signatureInfo && signatureInfo.provider !== 'none');

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      void sync();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось выполнить');
    } finally {
      setBusy(false);
    }
  };

  const verifyEntry = async (): Promise<void> => {
    await run(async () => {
      const updated = await api.verify(entry.id);
      await applyServerEntry(updated);
      if (updated.signature) {
        setSignatures((current) => [updated.signature as SignatureRecord, ...current]);
      }
    });
  };

  const signVisa = async (): Promise<void> => {
    await run(async () => {
      const signature = await api.signEntry(entry.id);
      setSignatures((current) => [signature, ...current]);
    });
  };

  return (
    <div className="screen">
      <PageHeader
        title="Запись журнала"
        subtitle={formatDateTime(entry.performed_at)}
        action={
          <div className="actions">
            <Link to={`/entries/${entry.id}/edit`} className="button button--ghost">
              Изменить
            </Link>
            <Link to="/" className="button button--ghost">
              Назад
            </Link>
          </div>
        }
      />

      <OfflineStatusBar compact />

      <article className="card entry-detail">
        <div className="entry-detail__badges">
          <SyncBadge status={entry.sync_status} />
          <Badge tone={eventTypeTone(entry.event_type)}>
            {eventTypeLabel(entry.event_type)}
          </Badge>
          {entry.verified_at ? <Badge tone="success">Проверена</Badge> : null}
          {entry.permit_risk_flag ? <Badge tone="danger">Риск</Badge> : null}
          {entry.site_binding_status === 'unresolved' ||
          entry.site_binding_status === 'not_found' ? (
            <Badge tone="warning">Объект не в справочнике</Badge>
          ) : null}
          {entry.status === 'deleted' ? <Badge tone="warning">Удалена</Badge> : null}
          {entry.late_entry ? (
            <Badge tone="warning">Пропущенная запись</Badge>
          ) : null}
        </div>

        <div className="entry-detail__meta-line">
          № {entry.journal_seq ?? 'после синхронизации'} ·{' '}
          {eventTypeLabel(entry.event_type)}
        </div>

        <p className="entry-detail__text">{entry.text}</p>

        {entry.performed_at_comment ? (
          <p className="entry-detail__comment">
            Причина корректировки: {entry.performed_at_comment}
          </p>
        ) : null}

        {entry.comment ? (
          <p className="entry-detail__comment">Комментарий: {entry.comment}</p>
        ) : null}

        {entry.event_data ? (
          <>
            <EventDetails eventType={entry.event_type} data={entry.event_data} />
            <details className="abbr">
              <summary>Данные события (JSON)</summary>
              <pre>{JSON.stringify(entry.event_data, null, 2)}</pre>
            </details>
          </>
        ) : null}

        {isOperationalEvent(entry.event_type) ? (
          <div className="actions actions--wrap">
            {entry.event_type === 'grounding' ? (
              <Link to="/groundings" className="button button--ghost button--small">
                Реестр заземлений
              </Link>
            ) : null}
            <Link
              to={journalFilterHref(entry.event_type ?? 'switching', entry.journal_id)}
              className="button button--ghost button--small"
            >
              Все {entry.event_type === 'grounding' ? 'заземления' : 'переключения'}{' '}
              журнала
            </Link>
          </div>
        ) : null}

        <dl className="detail-grid">
          <div>
            <dt>Объект</dt>
            <dd>
              {data.site ? (
                data.site.name
              ) : (
                entry.site_name_raw ?? '—'
              )}
              {entry.site_name_raw ? (
                <div className="hint">Введено вручную: {entry.site_name_raw}</div>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Наряд</dt>
            <dd>
              {data.permit ? (
                <Link to={`/permits/${data.permit.id}`}>{data.permit.number}</Link>
              ) : (
                entry.permit_number_raw ?? '—'
              )}
            </dd>
          </div>
          <div>
            <dt>Смена</dt>
            <dd>
              {data.shift ? (
                <span className="shift-context__inline">
                  <Badge tone={shiftStatusTone(data.shift.status)}>
                    {shiftStatusLabel(data.shift.status)}
                  </Badge>{' '}
                  <Link to="/shifts">Смены</Link>
                </span>
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div>
            <dt>Версия</dt>
            <dd>{entry.version}</dd>
          </div>
          <div>
            <dt>Автор</dt>
            <dd>{entry.author_id === user?.id ? 'Вы' : entry.author_id.slice(0, 8)}</dd>
          </div>
          <div>
            <dt>Проверка</dt>
            <dd>{entry.verified_at ? formatDateTime(entry.verified_at) : '—'}</dd>
          </div>
        </dl>

        {privileged &&
        entry.site_name_raw &&
        (entry.site_binding_status === 'unresolved' ||
          entry.site_binding_status === 'not_found') ? (
          <div className="field-inline bind-site">
            <select
              value={bindSiteId}
              onChange={(event) => setBindSiteId(event.target.value)}
              aria-label="Привязать объект к справочнику"
            >
              <option value="">— выберите объект —</option>
              {data.sites
                .filter((site) => site.active)
                .map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
            </select>
            <button
              type="button"
              className="button button--ghost"
              disabled={!bindSiteId}
              onClick={() => void bindSite()}
            >
              Привязать к справочнику
            </button>
          </div>
        ) : null}

        {entry.permit_risk_flag && entry.permit_risk_reason ? (
          <div className="alert alert--warning">
            Риск: {entry.permit_risk_reason}
          </div>
        ) : null}

        {pending ? (
          <div className="alert alert--warning" role="status">
            Запись ещё не синхронизирована: проверка и подпись станут доступны
            после отправки на сервер.
          </div>
        ) : null}

        {error ? (
          <div className="alert alert--danger" role="alert">
            {error}
          </div>
        ) : null}

        {privileged ? (
          <div className="signature-block">
            <SignatureHint
              signature={signatureInfo}
              context="проверку записи"
              compact
            />
            {signatures.length === 0 && entry.verified_at ? (
              <p className="hint">
                Подпись визы появится после проверки на сервере настроенным
                ЭП-адаптером.
              </p>
            ) : null}
            <SignatureList signatures={signatures} title="Подписи записи" />
          </div>
        ) : null}

        <div className="actions actions--wrap">
          {privileged && !entry.verified_at && entry.status === 'active' ? (
            <button
              type="button"
              className="button button--primary"
              disabled={busy || pending}
              onClick={() => void verifyEntry()}
            >
              Проверить
            </button>
          ) : null}
          {privileged && entry.verified_at && canSign ? (
            <button
              type="button"
              className="button button--ghost"
              disabled={busy || pending}
              onClick={() => void signVisa()}
            >
              Подписать визу
            </button>
          ) : null}
          {privileged && entry.verified_at ? (
            <button
              type="button"
              className="button button--ghost"
              disabled={busy || pending}
              onClick={() =>
                void run(async () => {
                  const updated = await api.unverify(entry.id, 'Снято вручную');
                  await applyServerEntry(updated);
                  setSignatures([]);
                })
              }
            >
              Снять проверку
            </button>
          ) : null}
          {user?.role === 'admin' && entry.status === 'deleted' ? (
            <button
              type="button"
              className="button button--ghost"
              disabled={busy || pending}
              onClick={() =>
                void run(async () => {
                  const updated = await api.restore(entry.id);
                  await applyServerEntry(updated);
                })
              }
            >
              Восстановить
            </button>
          ) : null}
          {entry.status === 'active' ? (
            <button
              type="button"
              className="button button--danger"
              disabled={busy}
              onClick={() => {
                if (!window.confirm('Удалить запись? Она исчезнет после синхронизации.')) {
                  return;
                }
                void run(async () => {
                  await deleteLocalEntry(entry.id, user!);
                  navigate('/');
                });
              }}
            >
              Удалить
            </button>
          ) : null}
        </div>

        {signatures.length > 0 && !privileged ? (
          <SignatureBadge signature={signatures[0]!} />
        ) : null}
      </article>

      <section className="card" aria-labelledby="documents-heading">
        <h2 id="documents-heading">Документы</h2>
        {!attachment ? (
          <>
            <p className="muted">Скан бумажного наряда не прикреплён.</p>
            {user &&
            (user.role === 'admin' ||
              user.role === 'supervisor' ||
              entry.author_id === user.id) ? (
              <Link
                to={`/entries/${entry.id}/edit`}
                className="button button--ghost"
              >
                Прикрепить скан
              </Link>
            ) : null}
          </>
        ) : (
          <div className="attachment-card">
            <p>
              <strong>Скан наряда</strong> · {attachment.pages} стр. ·{' '}
              {(attachment.size_bytes / 1024 / 1024).toFixed(2)} МБ ·{' '}
              {attachment.status}
            </p>
            <p className="hint">
              Копия бумажного наряда. Оригинал хранится на объекте.
            </p>
            {attachmentUrl || localAttachmentUrl ? (
              <a
                className="button button--ghost"
                href={attachmentUrl ?? localAttachmentUrl ?? '#'}
                target="_blank"
                rel="noreferrer"
              >
                Открыть скан
              </a>
            ) : (
              <p className="hint">
                Скан хранится локально и откроется после загрузки/синхронизации.
              </p>
            )}
            {user &&
            (user.role === 'admin' ||
              user.role === 'supervisor' ||
              attachment.created_by === user.id) ? (
              <button
                type="button"
                className="button button--danger button--small"
                onClick={() => void removeAttachment()}
              >
                Удалить скан
              </button>
            ) : null}
          </div>
        )}
      </section>

      <section className="card">
        <h2>История изменений</h2>
        {data.revisions.length === 0 ? (
          <p className="muted">Изменений пока нет.</p>
        ) : (
          <ol className="timeline">
            {data.revisions
              .slice()
              .sort((left, right) => right.revision_no - left.revision_no)
              .map((revision) => (
                <li key={revision.id}>
                  <div className="timeline__top">
                    <strong>Ревизия {revision.revision_no}</strong>
                    <span>{formatDateTime(revision.changed_at)}</span>
                  </div>
                  <div className="timeline__meta">
                    {revision.changed_by === user?.id
                      ? 'Вы'
                      : revision.changed_by.slice(0, 8)}{' '}
                    · {roleLabel(user?.role)}
                  </div>
                  <ul className="timeline__diff">
                    {Object.entries(revision.diff ?? {}).map(([field, value]) => (
                      <li key={field}>
                        <code>{field}</code>: {String(value.before ?? '—')} →{' '}
                        {String(value.after ?? '—')}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
          </ol>
        )}
      </section>
    </div>
  );
}
