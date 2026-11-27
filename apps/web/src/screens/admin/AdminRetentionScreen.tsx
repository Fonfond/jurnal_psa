import { useCallback, useEffect, useState } from 'react';
import type { Journal } from '@logbook/shared';
import { api } from '../../api/client';
import type {
  ArchiveRow,
  AuditVerifyResult,
  BackupManifest,
  RetentionStatus,
} from '../../api/types';
import { Badge } from '../../components/Badge';
import { Loader, PageHeader } from '../../components/Page';
import { formatDateTime } from '../../utils/format';

/**
 * Retention, audit verification and backups (JRN-04/ADM-04, t7 contract).
 * The policy is read-only by design: the retention period is an open customer
 * question (OQ-05/OQ-18), so the admin can only inspect and run the checks.
 */
export function AdminRetentionScreen(): JSX.Element {
  const [status, setStatus] = useState<RetentionStatus | null>(null);
  const [archives, setArchives] = useState<ArchiveRow[]>([]);
  const [journals, setJournals] = useState<Journal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verify, setVerify] = useState<AuditVerifyResult | null>(null);
  const [manifest, setManifest] = useState<BackupManifest | null>(null);
  const [checkpoint, setCheckpoint] = useState<{ id: string; manifest_hash: string } | null>(
    null,
  );
  const [archiveForm, setArchiveForm] = useState({
    journal_id: '',
    from: '',
    to: '',
  });

  const load = useCallback(async () => {
    setError(null);
    try {
      const [retention, archiveList, journalList] = await Promise.all([
        api.retention(),
        api.retentionArchives().catch(() => ({ items: [] })),
        api.journals().catch(() => ({ items: [] })),
      ]);
      setStatus(retention);
      setArchives(archiveList.items);
      setJournals(journalList.items);
    } catch (caught) {
      setError(
        `Модуль хранения недоступен: ${
          caught instanceof Error ? caught.message : 't7 ещё не подключён'
        }`,
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (
    label: string,
    action: () => Promise<unknown>,
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(label);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Операция не выполнена');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen admin-screen">
      <PageHeader
        title="Хранение и архив"
        subtitle="Политика 3 года, проверка цепочки аудита, WORM-архивы и backup checkpoints"
      />

      {error ? (
        <div className="alert alert--danger" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="alert alert--success" role="status">
          {notice}
        </div>
      ) : null}

      {!status ? (
        <Loader label="Загружаем состояние хранения…" />
      ) : (
        <>
          <div className="stats-grid">
            <div className="stat">
              <span className="stat__value">{status.policy_years}</span>
              <span className="stat__label">Лет хранения</span>
            </div>
            <div className="stat">
              <span className="stat__value">{status.journal_entries.total}</span>
              <span className="stat__label">Записей</span>
            </div>
            <div className="stat">
              <span className="stat__value">{status.journal_entries.before_cutoff}</span>
              <span className="stat__label">До cutoff</span>
            </div>
            <div className="stat">
              <span className="stat__value">{status.archives ?? archives.length}</span>
              <span className="stat__label">Архивов</span>
            </div>
          </div>

          <div className="admin-grid">
            <section className="card">
              <h2>Политика</h2>
              <dl className="detail-grid">
                <div>
                  <dt>Срок</dt>
                  <dd>{status.policy_years} лет</dd>
                </div>
                <div>
                  <dt>Cutoff</dt>
                  <dd>{status.cutoff}</dd>
                </div>
                <div>
                  <dt>Защищено до</dt>
                  <dd>{status.policy?.protected_until_cutoff ?? status.cutoff}</dd>
                </div>
                <div>
                  <dt>WORM-экспорты</dt>
                  <dd>{status.policy?.worm_exports === false ? 'выключены' : 'включены'}</dd>
                </div>
                <div>
                  <dt>Давность</dt>
                  <dd>
                    {status.journal_entries.oldest
                      ? `${formatDateTime(status.journal_entries.oldest)} — ${formatDateTime(status.journal_entries.newest)}`
                      : '—'}
                  </dd>
                </div>
              </dl>
              <p className="hint">
                Сроки хранения требуют утверждения заказчиком (OQ-05/OQ-18);
                политика доступна только для чтения и задаётся `RETENTION_YEARS`.
              </p>
              <div className="actions actions--wrap">
                <button
                  type="button"
                  className="button button--primary button--small"
                  disabled={busy}
                  onClick={() =>
                    void run('Проверка хранения выполнена', async () => {
                      const result = await api.retentionRun();
                      setVerify(result.audit_verification);
                    })
                  }
                >
                  Выполнить проверку
                </button>
                <button
                  type="button"
                  className="button button--ghost button--small"
                  disabled={busy}
                  onClick={() =>
                    void run('Цепочка аудита проверена', async () => {
                      setVerify(await api.auditVerify());
                    })
                  }
                >
                  Проверить аудит
                </button>
                <button
                  type="button"
                  className="button button--ghost button--small"
                  disabled={busy}
                  onClick={() =>
                    void run('Backup manifest сформирован', async () => {
                      setManifest(await api.backupManifest());
                    })
                  }
                >
                  Backup manifest
                </button>
                <button
                  type="button"
                  className="button button--ghost button--small"
                  disabled={busy}
                  onClick={() =>
                    void run('Checkpoint создан', async () => {
                      const result = await api.backupCheckpoint(
                        `admin-${new Date().toISOString().slice(0, 10)}`,
                      );
                      setCheckpoint({
                        id: result.id,
                        manifest_hash: result.manifest_hash,
                      });
                    })
                  }
                >
                  Создать checkpoint
                </button>
              </div>
            </section>

            <section className="card">
              <h2>Проверки</h2>
              {verify ? (
                <dl className="detail-grid">
                  <div>
                    <dt>Аудит</dt>
                    <dd>
                      <Badge tone={verify.ok ? 'success' : 'danger'}>
                        {verify.ok ? 'ок' : 'нарушен'}
                      </Badge>
                    </dd>
                  </div>
                  <div>
                    <dt>Потоков</dt>
                    <dd>{verify.streams_checked}</dd>
                  </div>
                  <div>
                    <dt>Событий</dt>
                    <dd>{verify.events_checked}</dd>
                  </div>
                  <div>
                    <dt>Разрывов</dt>
                    <dd>{verify.broken.length}</dd>
                  </div>
                </dl>
              ) : (
                <p className="muted">Проверка ещё не запускалась.</p>
              )}
              {verify && verify.broken.length > 0 ? (
                <ul className="outbox-list">
                  {verify.broken.map((row) => (
                    <li key={`${row.stream}-${row.stream_seq}`} className="outbox-item">
                      <strong>
                        {row.stream} · #{row.stream_seq}
                      </strong>
                      <p className="outbox-item__text">{row.reason}</p>
                    </li>
                  ))}
                </ul>
              ) : null}
              {manifest ? (
                <p className="hint">
                  Manifest {manifest.manifest_hash.slice(0, 16)}… · таблиц:{' '}
                  {Object.keys(manifest.tables).length} · экспортов:{' '}
                  {manifest.exports.length}
                </p>
              ) : null}
              {checkpoint ? (
                <p className="hint">
                  Checkpoint {checkpoint.id.slice(0, 8)}… · hash{' '}
                  {checkpoint.manifest_hash.slice(0, 16)}…
                </p>
              ) : null}
              <h3>Последние запуски</h3>
              {status.runs.length === 0 ? (
                <p className="muted">Запусков не было.</p>
              ) : (
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Время</th>
                      <th>Аудит</th>
                      <th>Потоков</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.runs.slice(0, 5).map((runRow) => (
                      <tr key={runRow.id}>
                        <td>{formatDateTime(runRow.run_at)}</td>
                        <td>
                          <Badge tone={runRow.audit_ok ? 'success' : 'danger'}>
                            {runRow.audit_ok ? 'ок' : 'ошибка'}
                          </Badge>
                        </td>
                        <td>{runRow.streams_checked}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>

          <section className="card">
            <h2>Архив журнала (WORM)</h2>
            <div className="form-row">
              <label className="field">
                <span>Журнал</span>
                <select
                  value={archiveForm.journal_id}
                  onChange={(event) =>
                    setArchiveForm({ ...archiveForm, journal_id: event.target.value })
                  }
                  aria-label="Журнал для архива"
                >
                  <option value="">Все доступные</option>
                  {journals.map((journal) => (
                    <option key={journal.id} value={journal.id}>
                      {journal.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>С</span>
                <input
                  type="date"
                  value={archiveForm.from}
                  onChange={(event) =>
                    setArchiveForm({ ...archiveForm, from: event.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>По</span>
                <input
                  type="date"
                  value={archiveForm.to}
                  onChange={(event) =>
                    setArchiveForm({ ...archiveForm, to: event.target.value })
                  }
                />
              </label>
              <button
                type="button"
                className="button button--primary button--small"
                disabled={busy}
                onClick={() =>
                  void run('Архив создан', async () => {
                    await api.retentionArchive({
                      journal_id: archiveForm.journal_id || undefined,
                      from: archiveForm.from || undefined,
                      to: archiveForm.to || undefined,
                    });
                  })
                }
              >
                Создать архив
              </button>
            </div>
            {archives.length === 0 ? (
              <p className="muted">Архивов пока нет.</p>
            ) : (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Журнал</th>
                    <th>Период</th>
                    <th>Записей</th>
                    <th>PDF SHA-256</th>
                    <th>Создан</th>
                  </tr>
                </thead>
                <tbody>
                  {archives.map((archive) => (
                    <tr key={archive.id}>
                      <td>{archive.journal_name ?? archive.journal_id.slice(0, 8)}</td>
                      <td>
                        {formatDateTime(archive.period_from)} —{' '}
                        {formatDateTime(archive.period_to)}
                      </td>
                      <td>{archive.entries_count}</td>
                      <td>
                        <code>{archive.pdf_sha256.slice(0, 12)}…</code>
                      </td>
                      <td>{formatDateTime(archive.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
