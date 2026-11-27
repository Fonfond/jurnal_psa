import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { SignatureRecord } from '@logbook/shared';
import { api } from '../api/client';
import {
  applyJournalReviews,
  journalName,
  listLocalJournals,
  listLocalReviews,
} from '../db/repositories';
import { useOnline } from '../hooks/useOnline';
import { useAuthStore } from '../stores/auth';
import { PageHeader } from '../components/Page';
import {
  SignatureBadge,
  SignatureHint,
  SignatureList,
} from '../components/SignatureHint';
import { formatDate, formatDateTime } from '../utils/format';

function firstDayOfMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

function lastDayOfMonth(): string {
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return last.toISOString().slice(0, 10);
}

/**
 * S-14 «Визы журнала»: review creation and the ЭП state (OQ-04).
 *
 * Reviews are created online only (a review is a server-side hash over the
 * period, JRN-08 is still open); the screen says so instead of pretending to
 * work offline, and shows the configured signature adapter plus every real
 * signature returned by the server.
 */
export function JournalReviewsScreen(): JSX.Element {
  const user = useAuthStore((state) => state.user);
  const signatureInfo = useAuthStore((state) => state.signature);
  const online = useOnline();
  const privileged = user?.role === 'supervisor' || user?.role === 'admin';
  const [periodStart, setPeriodStart] = useState(firstDayOfMonth());
  const [periodEnd, setPeriodEnd] = useState(lastDayOfMonth());
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedJournalId, setSelectedJournalId] = useState<string | null>(null);
  const [lastSignature, setLastSignature] = useState<SignatureRecord | null>(null);
  const [signatures, setSignatures] = useState<Record<string, SignatureRecord[]>>(
    {},
  );
  const [signingId, setSigningId] = useState<string | null>(null);
  const reviews = useLiveQuery(async () => listLocalReviews(), []);
  const journals = useLiveQuery(async () => listLocalJournals(), []);
  const activeJournalId = selectedJournalId ?? journals?.[0]?.id ?? null;
  const canSign = Boolean(signatureInfo && signatureInfo.provider !== 'none');

  useEffect(() => {
    if (!privileged || !activeJournalId) return;
    void api
      .reviews({ journal_id: activeJournalId })
      .then((response) => applyJournalReviews(response.items))
      .catch(() => undefined);
  }, [privileged, activeJournalId]);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setLastSignature(null);
    try {
      const review = await api.createReview({
        journal_id: activeJournalId ?? undefined,
        period_start: periodStart,
        period_end: periodEnd,
        remarks: remarks || undefined,
      });
      await applyJournalReviews([review]);
      setRemarks('');
      if (review.signature) {
        setLastSignature(review.signature);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось сохранить визу');
    } finally {
      setBusy(false);
    }
  };

  const signReview = async (reviewId: string): Promise<void> => {
    setSigningId(reviewId);
    setError(null);
    try {
      const signature = await api.signReview(reviewId);
      setSignatures((current) => ({
        ...current,
        [reviewId]: [signature, ...(current[reviewId] ?? [])],
      }));
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Не удалось подписать визу',
      );
    } finally {
      setSigningId(null);
    }
  };

  const loadSignatures = async (reviewId: string): Promise<void> => {
    setSigningId(reviewId);
    setError(null);
    try {
      const response = await api.reviewSignatures(reviewId);
      setSignatures((current) => ({ ...current, [reviewId]: response.items }));
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Не удалось получить подписи',
      );
    } finally {
      setSigningId(null);
    }
  };

  const signatureStatus = useMemo(() => {
    if (!signatureInfo) return 'Сведения об ЭП загружаются.';
    if (signatureInfo.provider === 'none') {
      return 'ЭП не настроена: визы фиксируются в аудите без подписи.';
    }
    return `Визы подписываются: ${signatureInfo.algorithm ?? signatureInfo.provider}.`;
  }, [signatureInfo]);

  if (!privileged) {
    return (
      <div className="screen">
        <PageHeader
          title="Визы журнала"
          subtitle="Доступно руководителю и администратору"
        />
        <div className="alert alert--warning">
          Просмотр виз доступен руководителю и администратору.
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <PageHeader
        title="Визы журнала"
        subtitle="Проверки правильности ведения — ориентир: не реже 2 раз в месяц"
      />

      {!online ? (
        <div className="alert alert--warning" role="status">
          Нет сети: визу можно зафиксировать только на сервере (офлайн-очередь
          виз — JRN-08). Уже созданные визы доступны из локального кэша.
        </div>
      ) : null}

      <form
        className="form card"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span>Журнал *</span>
          <select
            value={activeJournalId ?? ''}
            onChange={(event) => setSelectedJournalId(event.target.value)}
            aria-label="Журнал проверки"
          >
            {(journals ?? []).map((journal) => (
              <option key={journal.id} value={journal.id}>
                {journal.name}
              </option>
            ))}
          </select>
        </label>
        <div className="form-row">
          <label className="field">
            <span>Период с</span>
            <input
              type="date"
              value={periodStart}
              onChange={(event) => setPeriodStart(event.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>Период по</span>
            <input
              type="date"
              value={periodEnd}
              onChange={(event) => setPeriodEnd(event.target.value)}
              required
            />
          </label>
        </div>
        <label className="field">
          <span>Замечания</span>
          <textarea
            rows={3}
            maxLength={2000}
            value={remarks}
            onChange={(event) => setRemarks(event.target.value)}
          />
        </label>
        {error ? (
          <div className="alert alert--danger" role="alert">
            {error}
          </div>
        ) : null}
        <button
          type="submit"
          className="button button--primary"
          disabled={busy || !online}
        >
          {busy ? 'Сохраняем…' : 'Зафиксировать визу'}
        </button>
        <SignatureHint signature={signatureInfo} context="визу журнала" />
        <p className="hint" role="status">
          {signatureStatus}
        </p>
        {lastSignature ? (
          <div className="alert alert--success" role="status">
            Виза подписана:{' '}
            <SignatureBadge signature={lastSignature} showHash />
          </div>
        ) : null}
      </form>

      <section className="card">
        <h2>История проверок</h2>
        {!reviews || reviews.length === 0 ? (
          <p className="muted">Проверок пока нет.</p>
        ) : (
          <ul className="outbox-list">
            {reviews.map((review) => {
              const reviewSignatures = signatures[review.id] ?? [];
              return (
                <li key={review.id} className="outbox-item">
                  <div className="outbox-item__top">
                    <strong>
                      {formatDate(review.period_start)} — {formatDate(review.period_end)}
                    </strong>
                    <span className="muted">
                      {formatDateTime(review.reviewed_at)}
                    </span>
                  </div>
                  <p className="outbox-item__text">
                    {journalName(review.journal_id, journals ?? [])} · Записей:{' '}
                    {review.entries_count}
                    {review.remarks ? ` · ${review.remarks}` : ''}
                  </p>
                  <code>hash: {review.content_hash.slice(0, 16)}…</code>

                  <div className="actions actions--wrap">
                    {canSign ? (
                      <button
                        type="button"
                        className="button button--ghost button--small"
                        disabled={signingId === review.id || !online}
                        onClick={() => void signReview(review.id)}
                      >
                        {signingId === review.id ? 'Подписываем…' : 'Подписать визу'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="button button--ghost button--small"
                      disabled={signingId === review.id || !online}
                      onClick={() => void loadSignatures(review.id)}
                    >
                      Подписи
                    </button>
                  </div>

                  {reviewSignatures.length > 0 ? (
                    <SignatureList
                      signatures={reviewSignatures}
                      title="Подписи визы"
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
