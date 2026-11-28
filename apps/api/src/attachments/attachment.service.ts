import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
import { DomainError, uuidv7, type EntryAttachment } from '@logbook/shared';
import { AuditService } from '../audit/audit.service';
import { JournalService } from '../journal/journal.service';
import type { AuthUser, RequestMeta } from '../common/types';
import type { SqlClient } from '../db/sql-client';
import { DB } from '../db/tokens';
import { loadEnv } from '../config/env';
import { ObjectStorageService } from './object-storage.service';

interface AttachmentRow extends Record<string, unknown> {
  id: string;
  entry_id: string;
  kind: 'permit_scan';
  mime_type: 'application/pdf';
  pages: number;
  sha256: string;
  size_bytes: string | number;
  status: 'local' | 'uploading' | 'uploaded' | 'error';
  object_key: string;
  created_by: string;
  created_at: string | Date;
}

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PAGES = 10;
const SHA256_RE = /^[a-f0-9]{64}$/i;

export interface UploadedPdf {
  buffer: Buffer;
  size: number;
  mimetype: string;
}

function iso(value: string | Date): string {
  return typeof value === 'string' ? value : value.toISOString();
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

@Injectable()
export class AttachmentService {
  constructor(
    @Inject(DB) private readonly db: SqlClient,
    @Inject(JournalService) private readonly journal: JournalService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ObjectStorageService) private readonly storage: ObjectStorageService,
  ) {}

  private token(attachment: AttachmentRow): string {
    const env = loadEnv();
    const secret = env.ATTACHMENT_SIGNING_SECRET ?? env.COOKIE_SECRET;
    const expires = Math.floor(Date.now() / 1000) + env.ATTACHMENT_URL_TTL_SECONDS;
    const payload = `${attachment.id}.${attachment.entry_id}.${expires}`;
    const signature = createHmac('sha256', secret).update(payload).digest('base64url');
    return `${expires}.${signature}`;
  }

  private verifyToken(attachment: AttachmentRow, token: string): boolean {
    const env = loadEnv();
    const secret = env.ATTACHMENT_SIGNING_SECRET ?? env.COOKIE_SECRET;
    const [rawExpires, signature] = token.split('.');
    if (!rawExpires || !signature) return false;
    const expires = Number(rawExpires);
    if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) {
      return false;
    }
    const expected = createHmac('sha256', secret)
      .update(`${attachment.id}.${attachment.entry_id}.${expires}`)
      .digest('base64url');
    const actual = Buffer.from(signature);
    const wanted = Buffer.from(expected);
    return actual.length === wanted.length && timingSafeEqual(actual, wanted);
  }

  private map(row: AttachmentRow, withUrl: boolean): EntryAttachment {
    const item: EntryAttachment = {
      id: row.id,
      entry_id: row.entry_id,
      kind: 'permit_scan',
      mime_type: 'application/pdf',
      pages: Number(row.pages),
      sha256: row.sha256,
      size_bytes: Number(row.size_bytes),
      status: row.status,
      created_by: row.created_by,
      created_at: iso(row.created_at),
    };
    if (withUrl) {
      const env = loadEnv();
      item.url = `/v1/attachments/download/${row.id}?token=${encodeURIComponent(this.token(row))}`;
      item.expires_at = new Date(
        (Math.floor(Date.now() / 1000) + env.ATTACHMENT_URL_TTL_SECONDS) * 1000,
      ).toISOString();
    }
    return item;
  }

  async upload(
    actor: AuthUser,
    entryId: string,
    file: UploadedPdf | undefined,
    body: { pages?: string | number; sha256?: string },
    meta: RequestMeta,
  ): Promise<EntryAttachment> {
    await this.journal.get(actor, entryId);
    if (!file?.buffer || file.size <= 0) {
      throw new DomainError('E-VAL-01', 'PDF-файл не передан');
    }
    if (file.size > MAX_BYTES) {
      throw new DomainError('E-VAL-01', 'Скан больше 20 МБ');
    }
    if (file.mimetype !== 'application/pdf') {
      throw new DomainError('E-VAL-01', 'Принимается только PDF');
    }
    if (file.buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new DomainError('E-VAL-01', 'Файл не является PDF');
    }
    const pages = Number(body.pages);
    if (!Number.isInteger(pages) || pages < 1 || pages > MAX_PAGES) {
      throw new DomainError('E-VAL-01', 'В скане должно быть от 1 до 10 страниц');
    }
    let actualPages: number;
    try {
      const document = await PDFDocument.load(file.buffer, {
        ignoreEncryption: true,
      });
      actualPages = document.getPageCount();
    } catch {
      throw new DomainError('E-VAL-01', 'Не удалось прочитать страницы PDF');
    }
    if (actualPages > MAX_PAGES) {
      throw new DomainError('E-VAL-01', 'В скане не может быть больше 10 страниц');
    }
    if (actualPages !== pages) {
      throw new DomainError(
        'E-VAL-01',
        'Количество страниц PDF не совпадает с metadata',
      );
    }
    const suppliedSha = String(body.sha256 ?? '').toLowerCase();
    if (!SHA256_RE.test(suppliedSha)) {
      throw new DomainError('E-VAL-01', 'sha256 обязателен');
    }
    const actualSha = sha256(file.buffer);
    if (actualSha !== suppliedSha) {
      throw new DomainError('E-VAL-01', 'sha256 не совпадает с PDF');
    }

    const existing = await this.db.query<AttachmentRow>(
      `select * from entry_attachments
        where entry_id = $1 and deleted_at is null
        order by created_at desc limit 1`,
      [entryId],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].sha256 === actualSha) {
        return this.map(existing.rows[0], true);
      }
      throw new DomainError('E-VAL-01', 'У записи уже есть другой скан наряда');
    }

    const id = uuidv7();
    const objectKey = `attachments/${entryId}/${id}.pdf`;
    await this.storage.putPdf(objectKey, file.buffer);
    try {
      const inserted = await this.db.transaction(async (tx) => {
        const row = await tx.query<AttachmentRow>(
          `insert into entry_attachments
             (id, entry_id, kind, mime_type, pages, sha256, size_bytes, status,
              object_key, created_by)
           values ($1, $2, 'permit_scan', 'application/pdf', $3, $4, $5, 'uploaded', $6, $7)
           returning *`,
          [id, entryId, pages, actualSha, file.size, objectKey, actor.id],
        );
        await this.audit.record(tx, {
          actorId: actor.id,
          actorRole: actor.role,
          action: 'attachment.upload',
          entityType: 'entry',
          entityId: entryId,
          after: { attachment_id: id, pages, size_bytes: file.size, sha256: actualSha },
          source: 'server',
          ...meta,
        });
        return row.rows[0]!;
      });
      return this.map(inserted, true);
    } catch (error) {
      await this.storage.remove(objectKey).catch(() => undefined);
      throw error;
    }
  }

  async list(actor: AuthUser, entryId: string): Promise<{ items: EntryAttachment[] }> {
    await this.journal.get(actor, entryId);
    const rows = await this.db.query<AttachmentRow>(
      `select * from entry_attachments
        where entry_id = $1 and deleted_at is null
        order by created_at desc`,
      [entryId],
    );
    return { items: rows.rows.map((row) => this.map(row, true)) };
  }

  /**
   * Soft-delete the active scan. The object and row remain for audit; the
   * partial unique index then allows a replacement scan.
   */
  async remove(
    actor: AuthUser,
    entryId: string,
    attachmentId: string,
    meta: RequestMeta,
  ): Promise<{ ok: true }> {
    await this.journal.get(actor, entryId);
    const rows = await this.db.query<AttachmentRow>(
      `select * from entry_attachments
        where id = $1 and entry_id = $2 and deleted_at is null`,
      [attachmentId, entryId],
    );
    const row = rows.rows[0];
    if (!row) throw new DomainError('E-NOT-01', 'Скан не найден');
    if (
      actor.role !== 'admin' &&
      actor.role !== 'supervisor' &&
      row.created_by !== actor.id
    ) {
      throw new DomainError('E-AUTH-02', 'Недостаточно прав для удаления скана');
    }
    const now = new Date().toISOString();
    await this.db.transaction(async (tx) => {
      await tx.query(
        `update entry_attachments
            set deleted_at = $1, deleted_by = $2
          where id = $3`,
        [now, actor.id, attachmentId],
      );
      await this.audit.record(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'attachment.delete',
        entityType: 'entry',
        entityId: entryId,
        before: {
          attachment_id: attachmentId,
          pages: row.pages,
          sha256: row.sha256,
        },
        after: { deleted_at: now, deleted_by: actor.id },
        source: 'server',
        ...meta,
      });
    });
    return { ok: true };
  }

  async signedUrl(
    actor: AuthUser,
    entryId: string,
    attachmentId: string,
  ): Promise<{ url: string; expires_at: string; expires_in: number }> {
    await this.journal.get(actor, entryId);
    const rows = await this.db.query<AttachmentRow>(
      `select * from entry_attachments
        where id = $1 and entry_id = $2 and deleted_at is null`,
      [attachmentId, entryId],
    );
    const row = rows.rows[0];
    if (!row) throw new DomainError('E-NOT-01', 'Скан не найден');
    const env = loadEnv();
    const item = this.map(row, true);
    return {
      url: item.url!,
      expires_at: item.expires_at!,
      expires_in: env.ATTACHMENT_URL_TTL_SECONDS,
    };
  }

  async download(id: string, token: string): Promise<{ row: AttachmentRow; stream: NodeJS.ReadableStream }> {
    const rows = await this.db.query<AttachmentRow>(
      `select * from entry_attachments where id = $1 and deleted_at is null`,
      [id],
    );
    const row = rows.rows[0];
    if (!row || !this.verifyToken(row, token)) {
      throw new DomainError('E-AUTH-02', 'Ссылка на скан недействительна');
    }
    return { row, stream: await this.storage.getPdf(row.object_key) };
  }
}
