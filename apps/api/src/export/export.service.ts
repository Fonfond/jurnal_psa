import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  DEFAULT_JOURNAL_KEY,
  DomainError,
  uuidv7,
} from '@logbook/shared';
import { AuditService } from '../audit/audit.service';
import { loadEnv } from '../config/env';
import { sha256, stableStringify } from '../common/context';
import type { AuthUser, RequestMeta } from '../common/types';
import type { SqlClient } from '../db/sql-client';
import { DB } from '../db/tokens';
import { JournalsService } from '../journals/journals.service';
import { JournalService } from '../journal/journal.service';
import { buildJournalPdf, type JournalPdfEntry } from '../journal/journal-pdf';
import { SignatureService } from '../signature/signature.service';

interface ExportRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  type: string;
  status: string;
  journal_id: string | null;
  file_sha256: string | null;
  file_size_bytes: number | null;
  csv_sha256: string | null;
  csv_size_bytes: number | null;
  manifest: Record<string, unknown> | null;
  signature_id: string | null;
  generated_at: string | Date | null;
  expires_at: string | Date | null;
  worm: boolean;
  download_count: number;
}

interface ExportToken {
  e: string;
  h: string;
  f: 'pdf' | 'csv';
  exp: number;
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * WORM journal export (JRN-07, JRN-04): generates the server-side 3-column PDF
 * and CSV, seals them with a manifest and optional ЭП, and serves them through
 * short-lived signed URLs. Completed exports are immutable at the DB level.
 */
@Injectable()
export class ExportService {
  constructor(
    @Inject(DB) private readonly db: SqlClient,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(JournalService) private readonly journal: JournalService,
    @Inject(JournalsService) private readonly journals: JournalsService,
    @Inject(SignatureService) private readonly signatures: SignatureService,
  ) {}

  async generateJournalExport(
    actor: AuthUser,
    body: {
      journal_id?: string;
      from?: string;
      to?: string;
      archive?: boolean;
    },
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    this.assertExportRole(actor);
    let journal;
    if (body.journal_id) {
      journal = await this.journals.assertAccess(actor, body.journal_id, 'read');
    } else {
      const defaultJournal = await this.journals.loadByKey(DEFAULT_JOURNAL_KEY);
      if (!defaultJournal) {
        throw new DomainError('E-NOT-01', 'Журнал по умолчанию не найден');
      }
      journal = await this.journals.assertAccess(actor, defaultJournal.id, 'read');
    }

    const now = new Date();
    const from =
      body.from ??
      new Date(now.getFullYear() - 3, now.getMonth(), now.getDate())
        .toISOString()
        .slice(0, 10);
    const to = body.to ?? now.toISOString().slice(0, 10);
    if (from > to) {
      throw new DomainError('E-VAL-01', 'Начало периода позже конца');
    }

    const entries = await this.loadEntries(actor, journal.id, from, to);
    const signatureStatus = await this.loadSignatureStatuses(
      entries.map((entry) => entry.id),
    );
    const generatedAt = now.toISOString();

    const pdfEntries: JournalPdfEntry[] = entries.map((entry) => ({
      ...entry,
      signature_status: signatureStatus.get(entry.id) ?? 'none',
    }));
    const pdf = buildJournalPdf({
      journal_name: journal.name,
      journal_key: journal.journal_key,
      from,
      to,
      generated_at: generatedAt,
      entries: pdfEntries,
      legal_note: this.signatures.info.legal_note,
    });
    const csv = Buffer.from(
      await this.journal.exportCsv(actor, {
        from,
        to,
        journal_id: journal.id,
      }),
      'utf8',
    );

    const pdfHash = sha256Buffer(pdf);
    const csvHash = sha256Buffer(csv);
    const manifest = {
      schema: 'logbook.export.v1',
      type: body.archive ? 'archive_journal_pdf' : 'journal_pdf',
      journal: { id: journal.id, key: journal.journal_key, name: journal.name },
      period: { from, to },
      generated_at: generatedAt,
      entries_count: entries.length,
      files: {
        pdf: { sha256: pdfHash, size_bytes: pdf.length, content_type: 'application/pdf' },
        csv: { sha256: csvHash, size_bytes: csv.length, content_type: 'text/csv' },
      },
      signature: {
        provider: this.signatures.info.provider,
        algorithm: this.signatures.info.algorithm,
        legal_note: this.signatures.info.legal_note,
        auto_sign: this.signatures.canAutoSign,
      },
      retention: { years: 3, immutable: true },
    };
    const manifestHash = sha256(stableStringify(manifest));
    const id = uuidv7();

    const signature = await this.db.transaction(async (tx) => {
      const inserted = await tx.query<ExportRow>(
        `insert into export_jobs
           (id, user_id, type, status, journal_id, params, file_bytes, csv_bytes,
            file_sha256, file_size_bytes, csv_sha256, csv_size_bytes, manifest,
            generated_at, worm)
         values ($1, $2, $3, 'done', $4, $5::jsonb, $6, $7, $8, $9, $10, $11,
                 $12::jsonb, $13, true)
         returning *`,
        [
          id,
          actor.id,
          body.archive ? 'archive_journal_pdf' : 'journal_pdf',
          journal.id,
          JSON.stringify({ from, to, manifest_hash: manifestHash }),
          pdf,
          csv,
          pdfHash,
          pdf.length,
          csvHash,
          csv.length,
          JSON.stringify(manifest),
          generatedAt,
        ],
      );
      if (!inserted.rows[0]) {
        throw new DomainError('E-SRV-01', 'Не удалось сохранить экспорт');
      }

      let signed = null;
      if (this.signatures.canAutoSign) {
        signed = await this.signatures.signInTx(
          tx,
          actor,
          {
            entityType: 'export',
            entityId: id,
            entityVersion: 0,
            contentHash: pdfHash,
            signerId: actor.id,
          },
          meta,
        );
        await tx.query(
          `update export_jobs set signature_id = $1 where id = $2`,
          [signed.id, id],
        );
      }

      await this.audit.record(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: body.archive ? 'journal.archive.pdf' : 'journal.export.pdf',
        entityType: 'export',
        entityId: id,
        after: {
          journal_id: journal.id,
          from,
          to,
          entries_count: entries.length,
          pdf_sha256: pdfHash,
          csv_sha256: csvHash,
          manifest_hash: manifestHash,
          signature_id: signed?.id ?? null,
        },
        source: 'server',
        ...meta,
      });
      return signed;
    });

    return {
      id,
      status: 'done',
      type: body.archive ? 'archive_journal_pdf' : 'journal_pdf',
      journal_id: journal.id,
      from,
      to,
      entries_count: entries.length,
      file_sha256: pdfHash,
      file_size_bytes: pdf.length,
      csv_sha256: csvHash,
      csv_size_bytes: csv.length,
      manifest,
      manifest_hash: manifestHash,
      worm: true,
      signature,
      generated_at: generatedAt,
    };
  }

  async createSignedUrl(
    actor: AuthUser,
    id: string,
    format: 'pdf' | 'csv',
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    const job = await this.loadExport(id);
    this.assertExportAccess(actor, job);
    if (job.status !== 'done') {
      throw new DomainError('E-VAL-01', 'Экспорт ещё не сформирован');
    }
    const hash = format === 'pdf' ? job.file_sha256 : job.csv_sha256;
    if (!hash) {
      throw new DomainError('E-NOT-01', 'Файл экспорта не найден');
    }
    const ttl = loadEnv().EXPORT_URL_TTL_SECONDS;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const token = this.sign({
      e: id,
      h: hash,
      f: format,
      exp: Date.parse(expiresAt),
    });
    const base = loadEnv().EXPORT_PUBLIC_BASE_URL?.replace(/\/+$/, '') ?? '';
    const url = `${base}/v1/exports/${id}/download?format=${format}&token=${encodeURIComponent(token)}`;

    await this.audit.record(this.db, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'export.url',
      entityType: 'export',
      entityId: id,
      after: { format, hash, expires_at: expiresAt },
      source: 'server',
      ...meta,
    });
    return { id, format, url, expires_at: expiresAt, hash, worm: job.worm };
  }

  async download(
    actor: AuthUser,
    id: string,
    token: string | undefined,
    format: 'pdf' | 'csv',
    meta: RequestMeta,
  ): Promise<{ buffer: Buffer; filename: string; hash: string; format: 'pdf' | 'csv' }> {
    const payload = this.verify(token);
    if (!payload || payload.e !== id || payload.f !== format) {
      throw new DomainError('E-AUTH-02', 'Ссылка на экспорт недействительна');
    }
    if (payload.exp < Date.now()) {
      throw new DomainError('E-AUTH-02', 'Срок действия ссылки на экспорт истёк');
    }
    const job = await this.loadExport(id);
    this.assertExportAccess(actor, job);
    if (job.status !== 'done') {
      throw new DomainError('E-VAL-01', 'Экспорт ещё не сформирован');
    }
    const hash = format === 'pdf' ? job.file_sha256 : job.csv_sha256;
    if (!hash || hash !== payload.h) {
      throw new DomainError('E-VAL-01', 'Файл экспорта изменён или недоступен');
    }
    const result = await this.db.query<{ file_bytes: Buffer | null; csv_bytes: Buffer | null }>(
      'select file_bytes, csv_bytes from export_jobs where id = $1',
      [id],
    );
    const buffer = result.rows[0]
      ? format === 'pdf'
        ? result.rows[0].file_bytes
        : result.rows[0].csv_bytes
      : null;
    if (!buffer) {
      throw new DomainError('E-NOT-01', 'Файл экспорта не найден');
    }
    await this.db.query(
      'update export_jobs set download_count = download_count + 1 where id = $1',
      [id],
    );
    await this.audit.record(this.db, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'export.download',
      entityType: 'export',
      entityId: id,
      after: { format, sha256: hash, size_bytes: buffer.length },
      source: 'server',
      ...meta,
    });

    const base = format === 'pdf' ? 'journal' : 'journal';
    return {
      buffer,
      filename: `${base}-${id.slice(0, 8)}.${format}`,
      hash,
      format,
    };
  }

  async getDetails(actor: AuthUser, id: string): Promise<Record<string, unknown>> {
    const job = await this.loadExport(id);
    this.assertExportAccess(actor, job);
    return {
      id: job.id,
      user_id: job.user_id,
      type: job.type,
      status: job.status,
      journal_id: job.journal_id,
      file_sha256: job.file_sha256,
      file_size_bytes: job.file_size_bytes,
      csv_sha256: job.csv_sha256,
      csv_size_bytes: job.csv_size_bytes,
      manifest: job.manifest,
      signature_id: job.signature_id,
      generated_at: job.generated_at,
      expires_at: job.expires_at,
      worm: job.worm,
      download_count: Number(job.download_count ?? 0),
    };
  }

  /** Admin listing of generated exports (WORM journal PDF/CSV). */
  async listExports(
    actor: AuthUser,
    query: {
      type?: string;
      status?: string;
      limit: number;
      offset: number;
    },
  ): Promise<{ items: Array<Record<string, unknown>>; total: number }> {
    if (actor.role !== 'admin' && actor.role !== 'auditor') {
      throw new DomainError('E-AUTH-02', 'Недостаточно прав');
    }
    const conditions: string[] = ['true'];
    const params: unknown[] = [];
    if (query.type) {
      conditions.push(`type = $${params.push(query.type)}`);
    }
    if (query.status) {
      conditions.push(`status = $${params.push(query.status)}`);
    }
    const where = conditions.join(' and ');
    const total = await this.db.query<{ count: string }>(
      `select count(*)::text as count from export_jobs where ${where}`,
      params,
    );
    const items = await this.db.query<Record<string, unknown>>(
      `select id, user_id, type, status, journal_id, file_sha256,
              file_size_bytes, csv_sha256, csv_size_bytes, signature_id,
              generated_at, expires_at, worm, download_count
         from export_jobs
        where ${where}
        order by generated_at desc nulls last
        limit $${params.push(query.limit)} offset $${params.push(query.offset)}`,
      params,
    );
    return {
      items: items.rows,
      total: Number(total.rows[0]?.count ?? 0),
    };
  }

  private async loadExport(id: string): Promise<ExportRow> {
    const result = await this.db.query<ExportRow>(
      'select * from export_jobs where id = $1',
      [id],
    );
    const row = result.rows[0];
    if (!row) {
      throw new DomainError('E-NOT-01', 'Экспорт не найден');
    }
    return row;
  }

  private assertExportRole(actor: AuthUser): void {
    if (actor.role !== 'supervisor' && actor.role !== 'admin' && actor.role !== 'auditor') {
      throw new DomainError(
        'E-AUTH-02',
        'Экспорт журнала доступен руководителю, администратору и аудитору',
      );
    }
  }

  private assertExportAccess(actor: AuthUser, job: ExportRow): void {
    if (actor.role === 'admin' || actor.role === 'auditor') {
      return;
    }
    if (job.user_id !== actor.id) {
      throw new DomainError('E-AUTH-02', 'Недостаточно прав');
    }
  }

  private async loadEntries(
    actor: AuthUser,
    journalId: string,
    from: string,
    to: string,
  ): Promise<
    Array<{
      id: string;
      journal_seq: number | null;
      performed_at: string;
      event_type: string;
      text: string;
      comment: string | null;
      verified_at: string | null;
      author_name: string | null;
    }>
  > {
    const params: unknown[] = [journalId, from, to];
    let scope = 'true';
    if (actor.role === 'supervisor') {
      const departmentParam = params.push(actor.departmentId);
      scope = `e.author_id in (
        with recursive dept as (
          select id from departments where id = $${departmentParam}::uuid
          union all
          select d.id from departments d join dept on d.parent_id = dept.id
        )
        select u.id from users u where u.department_id in (select id from dept)
      )`;
    }
    const result = await this.db.query<{
      id: string;
      journal_seq: number | string | null;
      performed_at: string | Date;
      event_type: string;
      text: string;
      comment: string | null;
      verified_at: string | Date | null;
      author_name: string | null;
    }>(
      `select e.id, e.journal_seq, e.performed_at, e.event_type, e."text",
              e.comment, e.verified_at, u.full_name as author_name
         from journal_entries e
         join users u on u.id = e.author_id
        where e.journal_id = $1::uuid
          and e.status = 'active'::entry_status_enum
          and e.performed_at >= $2::date
          and e.performed_at < ($3::date + interval '1 day')
          and ${scope}
        order by e.journal_seq asc`,
      params,
    );
    return result.rows.map((row) => ({
      ...row,
      journal_seq:
        row.journal_seq === null ? null : Number(row.journal_seq),
      performed_at: toIso(row.performed_at),
      verified_at: row.verified_at === null ? null : toIso(row.verified_at),
    }));
  }

  private async loadSignatureStatuses(
    entryIds: string[],
  ): Promise<Map<string, 'valid' | 'invalid'>> {
    if (entryIds.length === 0) {
      return new Map();
    }
    const result = await this.db.query<{ entity_id: string; status: string }>(
      `select entity_id, status from document_signatures
        where entity_type = 'entry'::signature_entity_type_enum
          and entity_id = any($1::uuid[])`,
      [entryIds],
    );
    const map = new Map<string, 'valid' | 'invalid'>();
    for (const row of result.rows) {
      if (row.status === 'invalid') {
        map.set(row.entity_id, 'invalid');
      } else if (row.status === 'valid' && map.get(row.entity_id) !== 'invalid') {
        map.set(row.entity_id, 'valid');
      }
    }
    return map;
  }

  private sign(payload: ExportToken): string {
    const body = base64url(JSON.stringify(payload));
    const signature = createHmac('sha256', this.secret()).update(body).digest();
    return `${body}.${base64url(signature)}`;
  }

  private verify(token: string | undefined): ExportToken | null {
    if (!token) {
      return null;
    }
    const [body, signature] = token.split('.');
    if (!body || !signature) {
      return null;
    }
    const expected = createHmac('sha256', this.secret()).update(body).digest();
    const provided = fromBase64url(signature);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return null;
    }
    try {
      const payload = JSON.parse(fromBase64url(body).toString('utf8')) as ExportToken;
      if (
        typeof payload.e !== 'string' ||
        typeof payload.h !== 'string' ||
        (payload.f !== 'pdf' && payload.f !== 'csv') ||
        typeof payload.exp !== 'number'
      ) {
        return null;
      }
      return payload;
    } catch {
      return null;
    }
  }

  private secret(): string {
    const env = loadEnv();
    return env.EXPORT_SIGNING_SECRET ?? env.COOKIE_SECRET;
  }
}

function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}
