import { Inject, Injectable } from '@nestjs/common';
import { DomainError, uuidv7 } from '@logbook/shared';
import { AuditService } from '../audit/audit.service';
import { loadEnv } from '../config/env';
import { sha256, stableStringify } from '../common/context';
import type { AuthUser, RequestMeta } from '../common/types';
import type { SqlClient } from '../db/sql-client';
import { DB } from '../db/tokens';
import { JournalsService } from '../journals/journals.service';
import { ExportService } from '../export/export.service';
import { RetentionAlertService } from './retention-alert.service';
import { parseScheduleUtc, nextScheduledRun } from './retention-schedule';

interface AuditVerifyResult {
  ok: boolean;
  streams_checked: number;
  events_checked: number;
  broken: Array<{ stream: string; stream_seq: number; reason: string }>;
}

const BACKUP_TABLES = [
  'users',
  'departments',
  'devices',
  'permits',
  'journal_entries',
  'entry_revisions',
  'shifts',
  'groundings',
  'journal_reviews',
  'audit_events',
  'change_log',
  'export_jobs',
  'archive_manifests',
  'retention_runs',
  'backup_checkpoints',
] as const;

/**
 * Retention (3 years), archive manifests and backup hooks (JRN-04).
 * Hard deletion of recent journal entries is blocked by a DB trigger; this
 * service reports the policy state, verifies the audit hash chain daily and
 * seals backup checkpoints.
 */
@Injectable()
export class RetentionService {
  constructor(
    @Inject(DB) private readonly db: SqlClient,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(JournalsService) private readonly journals: JournalsService,
    @Inject(ExportService) private readonly exports: ExportService,
    @Inject(RetentionAlertService) private readonly alerts: RetentionAlertService,
  ) {}

  async report(nowInput?: string): Promise<Record<string, unknown>> {
    const now = this.parseNow(nowInput);
    const years = loadEnv().RETENTION_YEARS;
    const cutoff = this.cutoffDate(now, years);

    const counts = await this.db.query<{
      total: string;
      active: string;
      deleted: string;
      before_cutoff: string;
      oldest: string | Date | null;
      newest: string | Date | null;
    }>(
      `select count(*)::text as total,
              count(*) filter (where status = 'active')::text as active,
              count(*) filter (where status = 'deleted')::text as deleted,
              count(*) filter (where performed_at < $1::date)::text as before_cutoff,
              min(performed_at) as oldest,
              max(performed_at) as newest
         from journal_entries`,
      [cutoff],
    );
    const exports = await this.db.query<{ type: string; count: string }>(
      `select type, count(*)::text as count
         from export_jobs
        where status = 'done'
        group by type`,
    );
    const archives = await this.db.query<{ count: string }>(
      'select count(*)::text as count from archive_manifests',
    );
    const auditHeads = await this.auditHeads();
    const latestRun = await this.db.query<Record<string, unknown>>(
      'select * from retention_runs order by run_at desc limit 1',
    );
    const runs = await this.db.query<Record<string, unknown>>(
      `select id, run_at, actor_id, policy_years, cutoff, audit_ok,
              streams_checked, created_at, trigger, status, run_date,
              duration_ms, error
         from retention_runs
        order by run_at desc
        limit 20`,
    );
    const schedulerRun = await this.db.query<Record<string, unknown>>(
      `select id, run_at, status, run_date, duration_ms, error
         from retention_runs
        where trigger = 'scheduler'
        order by run_at desc
        limit 1`,
    );
    const alerts = await this.db.query<Record<string, unknown>>(
      `select id, created_at, kind, severity, message, context,
              delivered_at, delivery_error
         from retention_alerts
        order by created_at desc
        limit 20`,
    );
    const checkpoints = await this.db.query<Record<string, unknown>>(
      `select id, created_at, label, manifest_hash
         from backup_checkpoints
        order by created_at desc
        limit 20`,
    );
    const row = counts.rows[0];
    const { hour, minute } = parseScheduleUtc(loadEnv().RETENTION_SCHEDULE_UTC);
    const schedulerEnabled = loadEnv().RETENTION_SCHEDULER_ENABLED;

    return {
      policy: {
        years,
        cutoff,
        protected_until_cutoff: `записи моложе ${cutoff} физически не удаляются`,
        worm_exports: true,
      },
      policy_years: years,
      cutoff,
      entries: {
        total: Number(row?.total ?? 0),
        active: Number(row?.active ?? 0),
        deleted: Number(row?.deleted ?? 0),
        before_cutoff: Number(row?.before_cutoff ?? 0),
        oldest: row?.oldest ? this.iso(row.oldest) : null,
        newest: row?.newest ? this.iso(row.newest) : null,
      },
      journal_entries: {
        total: Number(row?.total ?? 0),
        active: Number(row?.active ?? 0),
        deleted: Number(row?.deleted ?? 0),
        before_cutoff: Number(row?.before_cutoff ?? 0),
        oldest: row?.oldest ? this.iso(row.oldest) : null,
        newest: row?.newest ? this.iso(row.newest) : null,
      },
      ttl: {
        change_log_days: loadEnv().CHANGE_LOG_RETENTION_DAYS,
        export_job_days: loadEnv().EXPORT_JOB_RETENTION_DAYS,
      },
      scheduler: {
        enabled: schedulerEnabled,
        schedule_utc: loadEnv().RETENTION_SCHEDULE_UTC,
        next_run_at: schedulerEnabled
          ? nextScheduledRun(now, hour, minute).toISOString()
          : null,
        latest_run: schedulerRun.rows[0] ?? null,
      },
      alerts: alerts.rows,
      exports: Object.fromEntries(
        exports.rows.map((item) => [item.type, Number(item.count)]),
      ),
      archives: Number(archives.rows[0]?.count ?? 0),
      audit: {
        streams: auditHeads.length,
        heads: auditHeads,
      },
      runs: runs.rows,
      latest_run: latestRun.rows[0] ?? null,
      checkpoints: checkpoints.rows,
      generated_at: now.toISOString(),
    };
  }

  async run(
    actor: AuthUser,
    meta: RequestMeta,
    nowInput?: string,
  ): Promise<Record<string, unknown>> {
    this.assertAdmin(actor);
    const now = this.parseNow(nowInput);
    return this.executeRun(actor, meta, now, 'manual');
  }

  /**
   * Scheduler entry point (REP-05): idempotent per UTC day, attributed to the
   * first active admin because audit_events.actor_id is non-null.
   */
  async runScheduled(nowInput?: string): Promise<Record<string, unknown>> {
    const now = this.parseNow(nowInput);
    const admin = await this.db.query<{ id: string; role: 'admin' }>(
      `select id, role from users
        where role = 'admin' and status = 'active'
        order by created_at asc
        limit 1`,
    );
    const actor = admin.rows[0];
    if (!actor) {
      const alert = await this.alerts.raise(
        'run_failed',
        'critical',
        'Retention scheduler не может запуститься: нет активного администратора для аудита',
        { run_at: now.toISOString(), trigger: 'scheduler' },
      );
      return { skipped: true, reason: 'no_admin_actor', alert_id: alert.id };
    }
    return this.executeRun(
      { id: actor.id, role: 'admin' } as AuthUser,
      {},
      now,
      'scheduler',
    );
  }

  private async executeRun(
    actor: AuthUser,
    meta: RequestMeta,
    now: Date,
    trigger: 'manual' | 'scheduler',
  ): Promise<Record<string, unknown>> {
    const env = loadEnv();
    const years = env.RETENTION_YEARS;
    const cutoff = this.cutoffDate(now, years);
    const runDate = trigger === 'scheduler' ? now.toISOString().slice(0, 10) : null;
    const id = uuidv7();
    const startedAt = Date.now();

    const claim = await this.db.query<{ id: string }>(
      `insert into retention_runs
         (id, actor_id, policy_years, cutoff, audit_ok, streams_checked, report,
          trigger, status, run_date)
       values ($1, $2, $3, $4::date, true, 0, '{}'::jsonb, $5, 'running', $6::date)
       on conflict (run_date) where trigger = 'scheduler'
         and status in ('running', 'success') do nothing
       returning id`,
      [id, actor.id, years, cutoff, trigger, runDate],
    );
    if (!claim.rows[0]) {
      return {
        skipped: true,
        reason: 'already_ran_today',
        run_date: runDate,
        trigger,
      };
    }

    try {
      const policy = await this.report(now.toISOString());
      const verification = await this.verifyAudit();
      const ttl = await this.cleanupTtl(now);
      const report = {
        ...policy,
        audit_verification: verification,
        ttl,
        run_now: now.toISOString(),
        trigger,
      };
      const durationMs = Date.now() - startedAt;
      await this.db.transaction(async (tx) => {
        await tx.query(
          `update retention_runs
              set audit_ok = $2, streams_checked = $3, report = $4::jsonb,
                  status = 'success', duration_ms = $5, error = null
            where id = $1`,
          [
            id,
            verification.ok,
            verification.streams_checked,
            JSON.stringify(report),
            durationMs,
          ],
        );
        await this.audit.record(tx, {
          actorId: actor.id,
          actorRole: actor.role,
          action: 'retention.check',
          entityType: 'retention',
          entityId: id,
          after: {
            policy_years: years,
            cutoff,
            trigger,
            entries_total: (policy.entries as { total: number }).total,
            entries_before_cutoff: (policy.entries as { before_cutoff: number })
              .before_cutoff,
            audit_ok: verification.ok,
            streams_checked: verification.streams_checked,
            broken: verification.broken.length,
            ttl,
          },
          source: 'server',
          ...meta,
        });
      });

      if (!verification.ok) {
        await this.alerts.raise(
          'audit_broken',
          'critical',
          `Retention-run обнаружил повреждение hash-цепочки аудита (${verification.broken.length} событий)`,
          { run_id: id, broken: verification.broken.slice(0, 10) },
        );
      }
      return { id, report, audit_verification: verification, trigger };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db.query(
        `update retention_runs
            set status = 'failed', error = $2, duration_ms = $3
          where id = $1`,
        [id, message.slice(0, 500), Date.now() - startedAt],
      );
      await this.alerts.raise(
        'run_failed',
        'critical',
        `Retention-run (${trigger}) завершился ошибкой: ${message}`,
        { run_id: id, run_date: runDate, trigger },
      );
      throw error;
    }
  }

  /**
   * TTL (REP-05): old change_log (ADR-07, 90 days) and expired non-WORM export
   * jobs. Journal entries are never physically deleted here: the 3-year DB
   * guard and archive flow protect records younger than RETENTION_YEARS.
   */
  private async cleanupTtl(now: Date): Promise<{
    change_log_days: number;
    change_log_deleted: number;
    export_job_days: number;
    export_jobs_deleted: number;
    cutoff_change_log: string;
    cutoff_export_jobs: string;
  }> {
    const env = loadEnv();
    const changeCutoff = new Date(
      now.getTime() - env.CHANGE_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const exportCutoff = new Date(
      now.getTime() - env.EXPORT_JOB_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const changeLog = await this.db.query(
      `delete from change_log where changed_at < $1::timestamptz`,
      [changeCutoff],
    );
    const exportJobs = await this.db.query(
      `delete from export_jobs
        where worm = false
          and expires_at < $1::timestamptz`,
      [exportCutoff],
    );
    return {
      change_log_days: env.CHANGE_LOG_RETENTION_DAYS,
      change_log_deleted: changeLog.rowCount,
      export_job_days: env.EXPORT_JOB_RETENTION_DAYS,
      export_jobs_deleted: exportJobs.rowCount,
      cutoff_change_log: changeCutoff,
      cutoff_export_jobs: exportCutoff,
    };
  }

  async latestSuccessfulRun(): Promise<{ id: string; run_at: string } | null> {
    const result = await this.db.query<{ id: string; run_at: string }>(
      `select id, run_at from retention_runs
        where status = 'success'
        order by run_at desc
        limit 1`,
    );
    return result.rows[0] ?? null;
  }

  async listAlerts(limit = 50): Promise<Record<string, unknown>[]> {
    const alerts = await this.alerts.list(limit);
    return alerts as unknown as Record<string, unknown>[];
  }

  async verifyAudit(): Promise<AuditVerifyResult> {
    await this.audit.flushPending();
    const rows = await this.db.query<{
      occurred_at: string | Date;
      actor_id: string;
      actor_role: string;
      action: string;
      entity_type: string;
      entity_id: string | null;
      before: unknown;
      after: unknown;
      reason: string | null;
      source: string;
      stream: string;
      stream_seq: string;
      prev_hash: string;
      hash: string;
    }>(
      `select occurred_at, actor_id, actor_role::text as actor_role, action,
              entity_type, entity_id, before, after, reason, source, stream,
              stream_seq::text as stream_seq, prev_hash, hash
         from audit_events
        order by audit_events.stream asc, audit_events.stream_seq asc`,
    );
    const broken: AuditVerifyResult['broken'] = [];
    const lastByStream = new Map<string, { hash: string; seq: number }>();
    let streams = 0;

    for (const row of rows.rows) {
      const seq = Number(row.stream_seq);
      const previous = lastByStream.get(row.stream);
      if (!previous) {
        streams += 1;
        if (row.prev_hash !== '0'.repeat(64)) {
          broken.push({
            stream: row.stream,
            stream_seq: seq,
            reason: 'prev_hash of the first event is not zero',
          });
        }
      } else if (
        row.prev_hash !== previous.hash ||
        seq !== previous.seq + 1
      ) {
        broken.push({
          stream: row.stream,
          stream_seq: seq,
          reason:
            row.prev_hash !== previous.hash
              ? 'prev_hash mismatch'
              : 'stream_seq gap',
        });
      }

      const payload = {
        occurred_at: this.iso(row.occurred_at),
        actor_id: row.actor_id,
        actor_role: row.actor_role,
        action: row.action,
        entity_type: row.entity_type,
        entity_id: row.entity_id ?? null,
        before: row.before ?? null,
        after: row.after ?? null,
        reason: row.reason ?? null,
        source: row.source,
        stream: row.stream,
        stream_seq: seq,
      };
      const expected = sha256(row.prev_hash + stableStringify(payload));
      if (expected !== row.hash) {
        broken.push({
          stream: row.stream,
          stream_seq: seq,
          reason: 'hash mismatch',
        });
      }
      lastByStream.set(row.stream, { hash: row.hash, seq });
    }

    return {
      ok: broken.length === 0,
      streams_checked: streams,
      events_checked: rows.rows.length,
      broken,
    };
  }

  async archive(
    actor: AuthUser,
    body: { journal_id?: string; from?: string; to?: string },
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    this.assertAdmin(actor);
    const years = loadEnv().RETENTION_YEARS;
    const cutoff = this.cutoffDate(new Date(), years);
    const to = body.to ?? cutoff;
    const from = body.from ?? `${Number(to.slice(0, 4)) - 1}${to.slice(4)}`;
    if (from > to) {
      throw new DomainError('E-VAL-01', 'Начало периода архива позже конца');
    }
    if (to > cutoff) {
      throw new DomainError(
        'E-VAL-01',
        `Архивировать можно только записи старше ${cutoff}`,
      );
    }

    const journal = body.journal_id
      ? await this.journals.assertAccess(actor, body.journal_id, 'read')
      : null;
    const generated = await this.exports.generateJournalExport(
      actor,
      {
        journal_id: body.journal_id,
        from,
        to,
        archive: true,
      },
      meta,
    );

    const journalId = journal?.id ?? String(generated.journal_id);
    const manifest = generated.manifest as Record<string, unknown>;
    const files = manifest.files as {
      pdf: { sha256: string };
      csv: { sha256: string };
    };
    const archiveId = uuidv7();
    const entriesCount = Number(generated.entries_count ?? 0);

    await this.db.transaction(async (tx) => {
      await tx.query(
        `insert into archive_manifests
           (id, export_job_id, journal_id, period_from, period_to,
            entries_count, pdf_sha256, csv_sha256, manifest)
         values ($1, $2::uuid, $3::uuid, $4::timestamptz, $5::timestamptz,
                 $6, $7, $8, $9::jsonb)`,
        [
          archiveId,
          String(generated.id),
          journalId,
          `${from}T00:00:00.000Z`,
          `${to}T23:59:59.999Z`,
          entriesCount,
          files.pdf.sha256,
          files.csv.sha256,
          JSON.stringify(manifest),
        ],
      );
      await this.audit.record(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'retention.archive',
        entityType: 'archive',
        entityId: archiveId,
        after: {
          export_job_id: generated.id,
          journal_id: journalId,
          from,
          to,
          entries_count: entriesCount,
          pdf_sha256: files.pdf.sha256,
        },
        source: 'server',
        ...meta,
      });
    });

    return {
      archive_id: archiveId,
      export: generated,
      manifest,
      immutable: true,
    };
  }

  async listArchives(actor: AuthUser): Promise<{ items: Array<Record<string, unknown>> }> {
    if (actor.role !== 'admin' && actor.role !== 'auditor') {
      throw new DomainError('E-AUTH-02', 'Недостаточно прав');
    }
    const result = await this.db.query<Record<string, unknown>>(
      `select a.id, a.export_job_id, a.journal_id, a.period_from, a.period_to,
              a.entries_count, a.pdf_sha256, a.csv_sha256, a.created_at,
              j.journal_key, j.name as journal_name
         from archive_manifests a
         join journals j on j.id = a.journal_id
        order by a.period_to desc
        limit 100`,
    );
    return { items: result.rows };
  }

  async backupManifest(actor: AuthUser): Promise<Record<string, unknown>> {
    this.assertAdmin(actor);
    const tableCounts: Record<string, number> = {};
    for (const table of BACKUP_TABLES) {
      const result = await this.db.query<{ count: string }>(
        `select count(*)::text as count from ${table}`,
      );
      tableCounts[table] = Number(result.rows[0]?.count ?? 0);
    }
    const auditHeads = await this.auditHeads();
    const exports = await this.db.query<Record<string, unknown>>(
      `select id, type, file_sha256, generated_at
         from export_jobs where status = 'done'
        order by generated_at desc limit 50`,
    );
    const manifest = {
      schema: 'logbook.backup-manifest.v1',
      generated_at: new Date().toISOString(),
      retention: {
        years: loadEnv().RETENTION_YEARS,
        cutoff: this.cutoffDate(new Date(), loadEnv().RETENTION_YEARS),
      },
      tables: tableCounts,
      audit: { heads: auditHeads },
      exports: exports.rows,
    };
    return {
      ...manifest,
      manifest_hash: sha256(stableStringify(manifest)),
    };
  }

  async checkpoint(
    actor: AuthUser,
    label: string | undefined,
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    this.assertAdmin(actor);
    const manifest = await this.backupManifest(actor);
    const manifestHash = String(manifest.manifest_hash);
    const id = uuidv7();
    await this.db.transaction(async (tx) => {
      await tx.query(
        `insert into backup_checkpoints
           (id, actor_id, label, manifest, manifest_hash)
         values ($1, $2, $3, $4::jsonb, $5)`,
        [id, actor.id, label ?? null, JSON.stringify(manifest), manifestHash],
      );
      await this.audit.record(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'backup.checkpoint',
        entityType: 'backup',
        entityId: id,
        after: {
          label: label ?? null,
          manifest_hash: manifestHash,
          tables: manifest.tables,
        },
        source: 'server',
        ...meta,
      });
    });
    return {
      id,
      label: label ?? null,
      manifest_hash: manifestHash,
      created_at: new Date().toISOString(),
      manifest,
    };
  }

  private async auditHeads(): Promise<Array<Record<string, unknown>>> {
    const result = await this.db.query<Record<string, unknown>>(
      `select distinct on (stream) stream, stream_seq, hash, occurred_at
         from audit_events
        order by audit_events.stream, audit_events.stream_seq desc`,
    );
    return result.rows.map((row) => ({
      stream: row.stream,
      stream_seq: Number(row.stream_seq),
      hash: row.hash,
      occurred_at: this.iso(row.occurred_at as string | Date),
    }));
  }

  private parseNow(value?: string): Date {
    if (!value) {
      return new Date();
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new DomainError('E-VAL-01', 'Некорректное время проверки');
    }
    return parsed;
  }

  private cutoffDate(now: Date, years: number): string {
    const cutoff = new Date(now);
    cutoff.setFullYear(cutoff.getFullYear() - years);
    return cutoff.toISOString().slice(0, 10);
  }

  private iso(value: string | Date): string {
    return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
  }

  private assertAdmin(actor: AuthUser): void {
    if (actor.role !== 'admin') {
      throw new DomainError('E-AUTH-02', 'Операция доступна администратору');
    }
  }
}
