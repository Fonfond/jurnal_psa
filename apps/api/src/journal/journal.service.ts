import { Inject, Injectable } from '@nestjs/common';
import {
  DEFAULT_JOURNAL_ID,
  DomainError,
  formatHlc,
  type SignatureRecord,
  uuidv7,
} from '@logbook/shared';
import { AuditService } from '../audit/audit.service';
import { sha256, stableStringify } from '../common/context';
import { encodeEntryCursor, decodeEntryCursor } from '../common/cursor';
import type { AuthUser, RequestMeta } from '../common/types';
import { appendChange } from '../db/change-log';
import type { SqlClient } from '../db/sql-client';
import { DB } from '../db/tokens';
import { JournalsService } from '../journals/journals.service';
import { entryVisaContentHash } from '../signature/content-hash';
import { SignatureService } from '../signature/signature.service';

export interface EntryListQuery {
  from?: string;
  to?: string;
  permit_id?: string;
  author_id?: string;
  status: 'active' | 'deleted';
  work_type_id?: string;
  site_id?: string;
  /** Optional journal filter; omitted = every journal visible to the actor. */
  journal_id?: string;
  cursor?: string;
  limit: number;
}

interface EntryRow extends Record<string, unknown> {
  id: string;
  author_id: string;
  version: number;
  revision_no: number;
  status: string;
  verified_at: string | null;
  author_department_id?: string;
}

@Injectable()
export class JournalService {
  constructor(
    @Inject(DB) private readonly db: SqlClient,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SignatureService) private readonly signatures: SignatureService,
    @Inject(JournalsService) private readonly journals: JournalsService,
  ) {}

  async list(
    actor: AuthUser,
    query: EntryListQuery,
  ): Promise<{
    items: Array<Record<string, unknown>>;
    next_cursor: string | null;
    has_more: boolean;
  }> {
    const params: unknown[] = [];
    const conditions: string[] = [];

    conditions.push(`e.status = $${params.push(query.status)}::entry_status_enum`);

    if (query.from) {
      conditions.push(`e.performed_at >= $${params.push(query.from)}::timestamptz`);
    }
    if (query.to) {
      conditions.push(`e.performed_at <= $${params.push(query.to)}::timestamptz`);
    }
    if (query.permit_id) {
      conditions.push(`e.permit_id = $${params.push(query.permit_id)}::uuid`);
    }
    if (query.work_type_id) {
      conditions.push(`e.work_type_id = $${params.push(query.work_type_id)}::uuid`);
    }
    if (query.site_id) {
      conditions.push(`e.site_id = $${params.push(query.site_id)}::uuid`);
    }

    if (query.journal_id) {
      await this.journals.assertAccess(actor, query.journal_id, 'read');
      conditions.push(`e.journal_id = $${params.push(query.journal_id)}::uuid`);
    } else if (actor.role === 'worker' || actor.role === 'supervisor') {
      // Journal-level visibility: the default journal stays open, other
      // journals require an explicit membership (JRN-03).
      const mainParam = params.push(DEFAULT_JOURNAL_ID);
      const memberParam = params.push(actor.id);
      conditions.push(`(e.journal_id = $${mainParam}::uuid or exists (
        select 1 from journal_members jm
         where jm.journal_id = e.journal_id and jm.user_id = $${memberParam}::uuid
      ))`);
    }

    if (actor.role === 'worker') {
      conditions.push(`e.author_id = $${params.push(actor.id)}::uuid`);
    } else if (actor.role === 'supervisor') {
      const departmentParam = params.push(actor.departmentId);
      conditions.push(`e.author_id in (
        with recursive dept as (
          select id from departments where id = $${departmentParam}::uuid
          union all
          select d.id from departments d join dept on d.parent_id = dept.id
        )
        select u.id from users u where u.department_id in (select id from dept)
      )`);
      if (query.author_id) {
        conditions.push(`e.author_id = $${params.push(query.author_id)}::uuid`);
      }
    } else if (actor.role === 'admin' || actor.role === 'auditor') {
      if (query.author_id) {
        conditions.push(`e.author_id = $${params.push(query.author_id)}::uuid`);
      }
    }

    const cursor = decodeEntryCursor(query.cursor);
    if (query.cursor && !cursor) {
      throw new DomainError('E-VAL-01', 'Некорректный курсор');
    }
    if (cursor) {
      conditions.push(
        `(e.performed_at, e.id) < ($${params.push(cursor.performedAt)}::timestamptz, $${params.push(cursor.id)}::uuid)`,
      );
    }

    const limitParam = params.push(query.limit + 1);
    const result = await this.db.query<EntryRow>(
      `select e.*
         from journal_entries e
        where ${conditions.join(' and ')}
        order by e.performed_at desc, e.id desc
        limit $${limitParam}`,
      params,
    );

    const hasMore = result.rows.length > query.limit;
    const rows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
    const last = rows[rows.length - 1];

    return {
      items: rows.map((row) => this.mapEntry(row)),
      next_cursor: hasMore && last ? encodeEntryCursor(String(last.performed_at), last.id) : null,
      has_more: hasMore,
    };
  }

  async get(actor: AuthUser, id: string): Promise<Record<string, unknown>> {
    const entry = await this.loadEntry(this.db, id);
    if (!entry || !(await this.canRead(actor, entry))) {
      throw new DomainError('E-NOT-01', 'Запись не найдена');
    }

    const revisions = await this.db.query(
      `select id, revision_no, changed_by, changed_at, source, hlc,
              base_version, result_version, diff, reason_id, reason_comment
         from entry_revisions
        where entry_id = $1
        order by revision_no asc`,
      [id],
    );

    return {
      ...this.mapEntry(entry),
      revisions: revisions.rows,
      signatures: await this.signatures.listFor('entry', id),
    };
  }

  async verify(
    actor: AuthUser,
    id: string,
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    return this.db.transaction(async (tx) => {
      const entry = await this.loadEntry(tx, id, true);
      if (!entry) {
        throw new DomainError('E-NOT-01', 'Запись не найдена');
      }
      await this.assertManage(actor, entry);
      await this.journals.assertAccess(actor, String(entry.journal_id), 'write');
      if (entry.status === 'deleted') {
        throw new DomainError('E-VAL-01', 'Удалённую запись нельзя проверить');
      }

      const now = new Date().toISOString();
      const nextVersion = Number(entry.version) + 1;
      const updated = await tx.query<EntryRow>(
        `update journal_entries
            set verified_at = $1, verified_by = $2,
                unverified_at = null, unverified_by = null,
                version = $3, updated_at_server = $1
          where id = $4
          returning *`,
        [now, actor.id, nextVersion, id],
      );

      await appendChange(tx, {
        entityType: 'entry',
        entityId: id,
        op: 'upsert',
        version: nextVersion,
        actorId: actor.id,
      });
      await this.audit.record(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'entry.verify',
        entityType: 'entry',
        entityId: id,
        before: { verified_at: entry.verified_at },
        after: { verified_at: now },
        source: 'server',
        ...meta,
      });

      const updatedEntry = updated.rows[0]!;
      const signature = this.signatures.canAutoSign
        ? await this.signatures.signInTx(
            tx,
            actor,
            {
              entityType: 'entry',
              entityId: id,
              entityVersion: Number(updatedEntry.version),
              contentHash: entryVisaContentHash(updatedEntry),
              signerId: actor.id,
            },
            meta,
          )
        : null;

      return {
        ...this.mapEntry(updatedEntry),
        ...(signature ? { signature } : {}),
      };
    });
  }

  async unverify(
    actor: AuthUser,
    id: string,
    meta: RequestMeta,
    comment?: string,
  ): Promise<Record<string, unknown>> {
    return this.db.transaction(async (tx) => {
      const entry = await this.loadEntry(tx, id, true);
      if (!entry) {
        throw new DomainError('E-NOT-01', 'Запись не найдена');
      }
      await this.assertManage(actor, entry);
      await this.journals.assertAccess(actor, String(entry.journal_id), 'write');

      const now = new Date().toISOString();
      const nextVersion = Number(entry.version) + 1;
      const updated = await tx.query<EntryRow>(
        `update journal_entries
            set verified_at = null, verified_by = null,
                unverified_at = $1, unverified_by = $2,
                version = $3, updated_at_server = $1
          where id = $4
          returning *`,
        [now, actor.id, nextVersion, id],
      );

      await appendChange(tx, {
        entityType: 'entry',
        entityId: id,
        op: 'upsert',
        version: nextVersion,
        actorId: actor.id,
      });
      await this.audit.record(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'entry.unverify',
        entityType: 'entry',
        entityId: id,
        before: { verified_at: entry.verified_at },
        after: { verified_at: null },
        reason: comment ?? null,
        source: 'server',
        ...meta,
      });

      // A visa signature is bound to verified_at/version: revoke it explicitly.
      await tx.query(
        `update document_signatures
            set status = 'revoked'
          where entity_type = 'entry' and entity_id = $1 and status = 'valid'`,
        [id],
      );

      return this.mapEntry(updated.rows[0]!);
    });
  }

  async restore(
    actor: AuthUser,
    id: string,
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    return this.db.transaction(async (tx) => {
      const entry = await this.loadEntry(tx, id, true);
      if (!entry) {
        throw new DomainError('E-NOT-01', 'Запись не найдена');
      }
      if (actor.role !== 'admin') {
        throw new DomainError('E-AUTH-02', 'Восстановление доступно администратору');
      }
      await this.journals.assertAccess(actor, String(entry.journal_id), 'write');
      if (entry.status !== 'deleted') {
        throw new DomainError('E-VAL-01', 'Запись не удалена');
      }

      const now = new Date().toISOString();
      const nextVersion = Number(entry.version) + 1;
      const updated = await tx.query<EntryRow>(
        `update journal_entries
            set status = 'active'::entry_status_enum, deleted_at = null,
                deleted_by = null, delete_reason_id = null,
                version = $1, updated_at_server = $2
          where id = $3
          returning *`,
        [nextVersion, now, id],
      );

      await appendChange(tx, {
        entityType: 'entry',
        entityId: id,
        op: 'upsert',
        version: nextVersion,
        actorId: actor.id,
      });
      await this.audit.record(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'entry.restore',
        entityType: 'entry',
        entityId: id,
        before: { status: 'deleted' },
        after: { status: 'active' },
        source: 'server',
        ...meta,
      });

      return this.mapEntry(updated.rows[0]!);
    });
  }

  async listReviews(
    actor: AuthUser,
    query: { from?: string; to?: string; journal_id?: string; limit: number },
  ): Promise<{ items: Array<Record<string, unknown>> }> {
    const params: unknown[] = [];
    const conditions: string[] = ['true'];
    if (query.from) {
      conditions.push(`r.period_end >= $${params.push(query.from)}::date`);
    }
    if (query.to) {
      conditions.push(`r.period_start <= $${params.push(query.to)}::date`);
    }
    if (query.journal_id) {
      await this.journals.assertAccess(actor, query.journal_id, 'read');
      conditions.push(`r.journal_id = $${params.push(query.journal_id)}::uuid`);
    } else if (actor.role === 'supervisor') {
      const mainParam = params.push(DEFAULT_JOURNAL_ID);
      const memberParam = params.push(actor.id);
      conditions.push(`(r.journal_id = $${mainParam}::uuid or exists (
        select 1 from journal_members jm
         where jm.journal_id = r.journal_id and jm.user_id = $${memberParam}::uuid
      ))`);
    }
    if (actor.role === 'supervisor') {
      const departmentParam = params.push(actor.departmentId);
      conditions.push(`r.reviewer_id in (
        with recursive dept as (
          select id from departments where id = $${departmentParam}::uuid
          union all
          select d.id from departments d join dept on d.parent_id = dept.id
        )
        select u.id from users u where u.department_id in (select id from dept)
      )`);
    } else if (actor.role !== 'admin') {
      throw new DomainError('E-AUTH-02', 'Недостаточно прав');
    }

    const result = await this.db.query(
      `select r.*
         from journal_reviews r
        where ${conditions.join(' and ')}
        order by r.reviewed_at desc
        limit $${params.push(query.limit)}`,
      params,
    );
    return {
      items: result.rows.map((row) => {
        const record = row as Record<string, unknown>;
        return { ...record, entries_count: Number(record.entries_count ?? 0) };
      }),
    };
  }

  async createReview(
    actor: AuthUser,
    body: {
      journal_id?: string;
      period_start: string;
      period_end: string;
      remarks?: string;
    },
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    if (actor.role !== 'supervisor' && actor.role !== 'admin') {
      throw new DomainError('E-AUTH-02', 'Недостаточно прав');
    }

    return this.db.transaction(async (tx) => {
      // Reviews are scoped to one journal: count and hash only its entries.
      const journal = await this.journals.resolveForEntry(
        actor,
        body.journal_id ?? null,
        tx,
      );
      const scopeParams: unknown[] = [
        journal.id,
        body.period_start,
        body.period_end,
      ];
      let scope = 'true';
      if (actor.role === 'supervisor') {
        const departmentParam = scopeParams.push(actor.departmentId);
        scope = `e.author_id in (
          with recursive dept as (
            select id from departments where id = $${departmentParam}::uuid
            union all
            select d.id from departments d join dept on d.parent_id = dept.id
          )
          select u.id from users u where u.department_id in (select id from dept)
        )`;
      }

      const entries = await tx.query<{ id: string; version: number; hlc: string }>(
        `select e.id, e.version, e.hlc
           from journal_entries e
          where e.status = 'active'::entry_status_enum
            and e.journal_id = $1::uuid
            and e.performed_at >= $2::date
            and e.performed_at < ($3::date + interval '1 day')
            and ${scope}
          order by e.journal_seq asc`,
        scopeParams,
      );

      const reviewedAt = new Date().toISOString();
      const contentHash = sha256(
        stableStringify({
          journal_key: journal.journal_key,
          journal_id: journal.id,
          period_start: body.period_start,
          period_end: body.period_end,
          reviewer_id: actor.id,
          entries: entries.rows.map((entry) => ({
            id: entry.id,
            version: Number(entry.version),
            hlc: entry.hlc,
          })),
        }),
      );

      const inserted = await tx.query(
        `insert into journal_reviews
           (id, journal_id, journal_key, period_start, period_end, reviewer_id,
            reviewed_at, entries_count, remarks, content_hash)
         values ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9, $10)
         returning *`,
        [
          uuidv7(),
          journal.id,
          journal.journal_key,
          body.period_start,
          body.period_end,
          actor.id,
          reviewedAt,
          entries.rows.length,
          body.remarks ?? null,
          contentHash,
        ],
      );

      await this.audit.record(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'journal.review.create',
        entityType: 'journal_review',
        entityId: String((inserted.rows[0] as { id: string }).id),
        after: {
          journal_id: journal.id,
          journal_key: journal.journal_key,
          period_start: body.period_start,
          period_end: body.period_end,
          entries_count: entries.rows.length,
          content_hash: contentHash,
        },
        source: 'server',
        ...meta,
      });

      const record = inserted.rows[0] as Record<string, unknown>;
      const signature = this.signatures.canAutoSign
        ? await this.signatures.signInTx(
            tx,
            actor,
            {
              entityType: 'journal_review',
              entityId: String(record.id),
              entityVersion: 0,
              contentHash,
              signerId: actor.id,
            },
            meta,
          )
        : null;

      return {
        ...record,
        entries_count: Number(record.entries_count ?? 0),
        ...(signature ? { signature } : {}),
      };
    });
  }

  /** Manual review signature (supervisor-owner or admin). */
  async signReview(
    actor: AuthUser,
    id: string,
    meta: RequestMeta,
  ): Promise<SignatureRecord> {
    return this.db.transaction(async (tx) => {
      const review = await tx.query<{
        id: string;
        reviewer_id: string;
        content_hash: string;
      }>(
        `select id, reviewer_id, content_hash from journal_reviews where id = $1 for update`,
        [id],
      );
      const record = review.rows[0];
      if (!record) {
        throw new DomainError('E-NOT-01', 'Проверка журнала не найдена');
      }
      if (actor.role !== 'admin' && record.reviewer_id !== actor.id) {
        throw new DomainError(
          'E-AUTH-02',
          'Подписать проверку может её автор или администратор',
        );
      }
      return this.signatures.signInTx(
        tx,
        actor,
        {
          entityType: 'journal_review',
          entityId: id,
          entityVersion: 0,
          contentHash: record.content_hash,
          signerId: actor.id,
        },
        meta,
      );
    });
  }

  /** Manual visa signature: only for an already verified entry version. */
  async signEntryVisa(
    actor: AuthUser,
    id: string,
    meta: RequestMeta,
  ): Promise<SignatureRecord> {
    return this.db.transaction(async (tx) => {
      const entry = await this.loadEntry(tx, id, true);
      if (!entry) {
        throw new DomainError('E-NOT-01', 'Запись не найдена');
      }
      await this.assertManage(actor, entry);
      await this.journals.assertAccess(actor, String(entry.journal_id), 'write');
      if (!entry.verified_at) {
        throw new DomainError(
          'E-VAL-01',
          'Сначала подтвердите запись (verify), затем подпишите визу',
        );
      }
      return this.signatures.signInTx(
        tx,
        actor,
        {
          entityType: 'entry',
          entityId: id,
          entityVersion: Number(entry.version),
          contentHash: entryVisaContentHash(entry),
          signerId: actor.id,
        },
        meta,
      );
    });
  }

  async listReviewSignatures(
    actor: AuthUser,
    id: string,
  ): Promise<{ items: SignatureRecord[] }> {
    const review = await this.db.query<{
      reviewer_id: string;
      reviewer_department_id: string;
    }>(
      `select r.reviewer_id, u.department_id as reviewer_department_id
         from journal_reviews r
         join users u on u.id = r.reviewer_id
        where r.id = $1`,
      [id],
    );
    const record = review.rows[0];
    if (!record) {
      throw new DomainError('E-NOT-01', 'Проверка журнала не найдена');
    }
    if (actor.role === 'admin' || actor.role === 'auditor') {
      return { items: await this.signatures.listFor('journal_review', id) };
    }
    if (actor.role !== 'supervisor') {
      throw new DomainError('E-AUTH-02', 'Недостаточно прав');
    }
    const allowed =
      actor.id === record.reviewer_id ||
      (await this.isDepartmentInSubtree(
        actor.departmentId,
        record.reviewer_department_id,
      ));
    if (!allowed) {
      throw new DomainError('E-AUTH-02', 'Недостаточно прав');
    }
    return { items: await this.signatures.listFor('journal_review', id) };
  }

  async exportCsv(
    actor: AuthUser,
    query: { from?: string; to?: string; journal_id?: string },
  ): Promise<string> {
    const params: unknown[] = [];
    const conditions: string[] = [`e.status = 'active'::entry_status_enum`];
    let journalHeader: string | null = null;
    if (query.from) {
      conditions.push(`e.performed_at >= $${params.push(query.from)}::date`);
    }
    if (query.to) {
      conditions.push(
        `e.performed_at < ($${params.push(query.to)}::date + interval '1 day')`,
      );
    }
    if (query.journal_id) {
      const journal = await this.journals.assertAccess(actor, query.journal_id, 'read');
      journalHeader = `# Журнал: ${journal.name} (${journal.journal_key})`;
      conditions.push(`e.journal_id = $${params.push(journal.id)}::uuid`);
    } else if (actor.role === 'worker' || actor.role === 'supervisor') {
      const mainParam = params.push(DEFAULT_JOURNAL_ID);
      const memberParam = params.push(actor.id);
      conditions.push(`(e.journal_id = $${mainParam}::uuid or exists (
        select 1 from journal_members jm
         where jm.journal_id = e.journal_id and jm.user_id = $${memberParam}::uuid
      ))`);
    }

    if (actor.role === 'worker') {
      conditions.push(`e.author_id = $${params.push(actor.id)}::uuid`);
    } else if (actor.role === 'supervisor') {
      const departmentParam = params.push(actor.departmentId);
      conditions.push(`e.author_id in (
        with recursive dept as (
          select id from departments where id = $${departmentParam}::uuid
          union all
          select d.id from departments d join dept on d.parent_id = dept.id
        )
        select u.id from users u where u.department_id in (select id from dept)
      )`);
    } else if (actor.role !== 'admin' && actor.role !== 'auditor') {
      throw new DomainError('E-AUTH-02', 'Недостаточно прав');
    }

    const rows = await this.db.query<{
      journal_seq: string | null;
      journal_key: string;
      performed_at: Date | string;
      event_type: string;
      text: string;
      comment: string | null;
      late_entry: boolean;
      verified_at: Date | string | null;
      author_name: string | null;
      permit_number: string | null;
    }>(
      `select e.journal_seq::text, j.journal_key, e.performed_at, e.event_type,
              e."text", e.comment, e.late_entry, e.verified_at,
              u.full_name as author_name, p.number as permit_number
         from journal_entries e
         join journals j on j.id = e.journal_id
         join users u on u.id = e.author_id
         left join permits p on p.id = e.permit_id
        where ${conditions.join(' and ')}
        order by j.sort_order, j.journal_key, e.journal_seq asc`,
      params,
    );

    const escape = (value: unknown): string =>
      `"${String(value ?? '').replace(/"/g, '""')}"`;
    const signatureInfo = this.signatures.info;
    const signatureHeader =
      signatureInfo.provider === 'qualified'
        ? '# ЭОЖ Logbook. Экспорт подписан КЭП через внешний сервис; TODO(OQ-04).'
        : signatureInfo.provider === 'simple'
          ? '# ЭОЖ Logbook. Экспорт с простой ЭП сервера (HMAC-SHA256), не КЭП; TODO(OQ-04).'
          : '# ЭОЖ Logbook. Экспорт не подписан электронной подписью; TODO(OQ-04).';
    const lines = [
      signatureHeader,
      `# ЭП: ${signatureInfo.legal_note}`,
      ...(journalHeader ? [journalHeader] : []),
      '# Хранение: не менее 3 лет со дня последней записи (TODO(OQ-18)).',
      'journal_seq,date_time,content,visas_remarks,event_type,author,permit,late_entry,journal_key',
      ...rows.rows.map((row) => {
        const content = [row.text, row.comment].filter(Boolean).join(' | ');
        return [
          escape(row.journal_seq),
          escape(row.performed_at),
          escape(content),
          escape(row.verified_at),
          escape(row.event_type),
          escape(row.author_name),
          escape(row.permit_number),
          escape(row.late_entry),
          escape(row.journal_key),
        ].join(',');
      }),
    ];
    return `\uFEFF${lines.join('\n')}\n`;
  }

  async listConflicts(
    actor: AuthUser,
    resolution: string | undefined,
    limit: number,
  ): Promise<{ items: Array<Record<string, unknown>> }> {    const params: unknown[] = [];
    const conditions: string[] = ['true'];

    if (resolution) {
      conditions.push(`c.resolution = $${params.push(resolution)}::conflict_resolution_enum`);
    }

    if (actor.role === 'worker') {
      conditions.push(`e.author_id = $${params.push(actor.id)}::uuid`);
    } else if (actor.role === 'supervisor') {
      const departmentParam = params.push(actor.departmentId);
      conditions.push(`e.author_id in (
        with recursive dept as (
          select id from departments where id = $${departmentParam}::uuid
          union all
          select d.id from departments d join dept on d.parent_id = dept.id
        )
        select u.id from users u where u.department_id in (select id from dept)
      )`);
    } else if (actor.role !== 'admin' && actor.role !== 'auditor') {
      throw new DomainError('E-AUTH-02', 'Недостаточно прав');
    }

    const result = await this.db.query(
      `select c.id, c.entry_id, c.field, c.local_value, c.remote_value,
              c.local_hlc, c.remote_hlc, c.resolution, c.resolved_by, c.resolved_at
         from conflict_records c
         join journal_entries e on e.id = c.entry_id
        where ${conditions.join(' and ')}
        order by c.id desc
        limit $${params.push(limit)}`,
      params,
    );
    return { items: result.rows };
  }

  async resolveConflict(
    actor: AuthUser,
    conflictId: string,
    body: { resolution: 'local' | 'remote' | 'manual'; values?: Record<string, unknown>; comment?: string },
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    if (actor.role !== 'supervisor' && actor.role !== 'admin') {
      throw new DomainError('E-AUTH-02', 'Недостаточно прав');
    }

    return this.db.transaction(async (tx) => {
      const result = await tx.query<{
        id: string;
        entry_id: string;
        field: string;
        local_value: unknown;
        remote_value: unknown;
        resolution: string;
        author_id: string;
        version: number;
        revision_no: number;
        text: string;
        author_department_id: string;
        status: string;
        journal_id: string;
      }>(
        `select c.id, c.entry_id, c.field, c.local_value, c.remote_value, c.resolution,
                e.author_id, e.version, e.revision_no, e."text", e.status, e.journal_id,
                u.department_id as author_department_id
           from conflict_records c
           join journal_entries e on e.id = c.entry_id
           join users u on u.id = e.author_id
          where c.id = $1
          for update`,
        [conflictId],
      );
      const conflict = result.rows[0];
      if (!conflict) {
        throw new DomainError('E-NOT-01', 'Конфликт не найден');
      }
      await this.assertManage(actor, conflict as unknown as EntryRow);
      await this.journals.assertAccess(actor, conflict.journal_id, 'write');

      const now = new Date().toISOString();
      await tx.query(
        `update conflict_records
            set resolution = $1::conflict_resolution_enum, resolved_by = $2, resolved_at = $3
          where id = $4`,
        [body.resolution, actor.id, now, conflictId],
      );

      let entryVersion = Number(conflict.version);
      if (body.resolution === 'local' && body.values && typeof body.values.text === 'string') {
        entryVersion += 1;
        const nextRevision = Number(conflict.revision_no) + 1;
        await tx.query(
          `update journal_entries
              set "text" = $1, version = $2, revision_no = $3, updated_at_server = $4
            where id = $5`,
          [body.values.text, entryVersion, nextRevision, now, conflict.entry_id],
        );
        await tx.query(
          `insert into entry_revisions
             (id, entry_id, revision_no, changed_by, changed_at, source, hlc,
              base_version, result_version, diff, reason_comment)
           values ($1, $2, $3, $4, $5, 'conflict_resolution'::revision_source_enum,
                   $6, $7, $8, $9::jsonb, $10)`,
          [
            uuidv7(),
            conflict.entry_id,
            nextRevision,
            actor.id,
            now,
            formatHlc(Date.parse(now), 0, 'conflict'),
            conflict.version,
            entryVersion,
            JSON.stringify({ text: { before: conflict.text, after: body.values.text } }),
            body.comment ?? null,
          ],
        );
        await appendChange(tx, {
          entityType: 'entry',
          entityId: conflict.entry_id,
          op: 'upsert',
          version: entryVersion,
          actorId: actor.id,
        });
      }

      await this.audit.record(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'conflict.resolve',
        entityType: 'entry',
        entityId: conflict.entry_id,
        before: { resolution: conflict.resolution },
        after: { resolution: body.resolution },
        reason: body.comment ?? null,
        source: 'server',
        ...meta,
      });

      return {
        id: conflictId,
        resolution: body.resolution,
        entry_version: entryVersion,
      };
    });
  }

  private async loadEntry(
    tx: SqlClient,
    id: string,
    forUpdate = false,
  ): Promise<EntryRow | null> {
    const result = await tx.query<EntryRow>(
      `select e.*, u.department_id as author_department_id
         from journal_entries e
         join users u on u.id = e.author_id
        where e.id = $1
        ${forUpdate ? 'for update' : ''}`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  private async canRead(actor: AuthUser, entry: EntryRow | null): Promise<boolean> {
    if (!entry) {
      return false;
    }
    if (actor.role === 'admin' || actor.role === 'auditor') {
      return true;
    }
    const journal = await this.journals.load(String(entry.journal_id));
    const level = journal ? await this.journals.accessLevel(actor, journal) : null;
    if (!level) {
      return false;
    }
    if (actor.role === 'worker') {
      return entry.author_id === actor.id;
    }
    return this.isDepartmentInSubtree(actor.departmentId, entry.author_department_id!);
  }

  private async assertManage(actor: AuthUser, entry: EntryRow | null): Promise<void> {
    if (!entry) {
      throw new DomainError('E-NOT-01', 'Запись не найдена');
    }
    if (actor.role === 'admin') {
      return;
    }
    if (actor.role !== 'supervisor') {
      throw new DomainError('E-AUTH-02', 'Недостаточно прав');
    }
    const allowed = await this.isDepartmentInSubtree(
      actor.departmentId,
      entry.author_department_id!,
    );
    if (!allowed) {
      throw new DomainError('E-AUTH-02', 'Недостаточно прав');
    }
  }

  private async isDepartmentInSubtree(ancestorId: string, descendantId: string): Promise<boolean> {
    if (ancestorId === descendantId) {
      return true;
    }
    const result = await this.db.query<{ ok: boolean }>(
      `with recursive ancestors as (
         select id, parent_id from departments where id = $1::uuid
         union all
         select d.id, d.parent_id from departments d join ancestors a on d.id = a.parent_id
       )
       select exists(select 1 from ancestors where id = $2::uuid) as ok`,
      [descendantId, ancestorId],
    );
    return Boolean(result.rows[0]?.ok);
  }

  private mapEntry(row: EntryRow): Record<string, unknown> {
    const {
      field_clocks: _fieldClocks,
      author_department_id: _authorDepartment,
      ...rest
    } = row as EntryRow & { field_clocks?: unknown };
    return {
      ...rest,
      version: Number(rest.version),
      revision_no: Number(rest.revision_no),
      asr_confidence:
        rest.asr_confidence === null || rest.asr_confidence === undefined
          ? null
          : Number(rest.asr_confidence),
      event_type: rest.event_type ?? 'work',
      event_data: rest.event_data ?? null,
      journal_id: (rest.journal_id as string | null) ?? DEFAULT_JOURNAL_ID,
      journal_seq:
        rest.journal_seq === null || rest.journal_seq === undefined
          ? null
          : Number(rest.journal_seq),
      late_entry: Boolean(rest.late_entry),
      sync_status: 'synced',
    };
  }
}
