import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '@logbook/shared';
import { AuditService } from '../audit/audit.service';
import { loadEnv } from '../config/env';
import type { AuthUser, RequestMeta } from '../common/types';
import type { SqlClient } from '../db/sql-client';
import { DB } from '../db/tokens';
import { buildPermitPdf, type PermitPdfData } from './pdf';

interface PermitPdfRow extends Record<string, unknown> {
  id: string;
  number: string;
  year: number;
  type: string;
  status: string;
  valid_from: string;
  valid_to: string;
  work_description: string;
  version: number;
  external_url: string | null;
  pdf_url: string | null;
  pdf_hash: string | null;
  pdf_size_bytes: number | null;
  pdf_generated_at: string | null;
  pdf_source: 'generated' | 'external' | 'none';
  source_id: string;
  external_id: string;
  site_name: string | null;
  site_code: string | null;
  responsible_name: string | null;
}

interface PdfTokenPayload {
  p: string;
  e: number;
  v: number;
  s: 'generated' | 'external';
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
 * Signed permit PDF URLs (OQ-03).
 *
 * The PDF is generated locally from the stored permit card and served through a
 * short-lived HMAC-signed URL (TTL ≤ 15 min). When the external permit system
 * supplies `pdf_url`, the signed URL redirects to that deep link instead.
 * Generation is deterministic: the stored `pdf_generated_at` is part of the
 * document, and a changed permit version invalidates old links.
 */
@Injectable()
export class PermitPdfService {
  constructor(
    @Inject(DB) private readonly db: SqlClient,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async createUrl(
    actor: AuthUser,
    id: string,
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    const permit = await this.loadPermit(id);
    await this.assertVisible(actor, permit);

    const env = loadEnv();
    const expiresAt = new Date(
      Date.now() + env.PERMIT_PDF_TTL_SECONDS * 1000,
    ).toISOString();

    let source: 'generated' | 'external' = 'generated';
    let hash = permit.pdf_hash;
    let size = permit.pdf_size_bytes;

    if (permit.pdf_url) {
      source = 'external';
      if (permit.pdf_source !== 'external' || !hash) {
        hash = createHash('sha256').update(permit.pdf_url).digest('hex');
        size = null;
        await this.db.query(
          `update permits
              set pdf_hash = $1, pdf_size_bytes = null,
                  pdf_generated_at = null, pdf_source = 'external'
            where id = $2`,
          [hash, id],
        );
      }
    } else {
      const generatedAt = permit.pdf_generated_at
        ? this.isoDate(permit.pdf_generated_at)
        : new Date().toISOString();
      const pdf = buildPermitPdf(this.toPdfData(permit, generatedAt));
      hash = createHash('sha256').update(pdf).digest('hex');
      size = pdf.length;
      if (
        permit.pdf_hash !== hash ||
        permit.pdf_size_bytes !== size ||
        permit.pdf_generated_at === null ||
        permit.pdf_source !== 'generated'
      ) {
        await this.db.query(
          `update permits
              set pdf_hash = $1, pdf_size_bytes = $2,
                  pdf_generated_at = $3, pdf_source = 'generated'
            where id = $4`,
          [hash, size, generatedAt, id],
        );
      }
    }

    const token = this.sign({
      p: id,
      e: Date.parse(expiresAt),
      v: Number(permit.version),
      s: source,
    });
    const base = env.PERMIT_PDF_PUBLIC_BASE_URL?.replace(/\/+$/, '') ?? '';
    const url = `${base}/v1/permits/pdf/${id}?token=${encodeURIComponent(token)}`;

    await this.audit.record(this.db, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'permit.pdf_url',
      entityType: 'permit',
      entityId: id,
      after: {
        source,
        hash,
        size_bytes: size,
        expires_at: expiresAt,
      },
      source: 'server',
      ...meta,
    });

    return {
      permit_id: id,
      url,
      expires_at: expiresAt,
      source,
      hash,
      size_bytes: size,
      external_url: permit.external_url,
      deep_link: permit.external_url,
      pdf_url: permit.pdf_url,
    };
  }

  async download(
    actor: AuthUser,
    id: string,
    token: string | undefined,
    meta: RequestMeta,
  ): Promise<
    | { pdf: Buffer; filename: string; hash: string; size_bytes: number }
    | { redirect: string; hash: string | null; size_bytes: number | null }
  > {
    const payload = this.verify(token);
    if (!payload || payload.p !== id) {
      throw new DomainError('E-AUTH-02', 'Ссылка на PDF недействительна');
    }
    if (payload.e < Date.now()) {
      throw new DomainError('E-AUTH-02', 'Срок действия ссылки на PDF истёк');
    }

    const permit = await this.loadPermit(id);
    await this.assertVisible(actor, permit);
    if (Number(permit.version) !== payload.v) {
      throw new DomainError(
        'E-VAL-01',
        'Ссылка устарела: наряд изменён после её выдачи',
      );
    }

    if (payload.s === 'external') {
      if (!permit.pdf_url) {
        throw new DomainError('E-NOT-01', 'PDF наряда не найден');
      }
      await this.audit.record(this.db, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'permit.pdf_download',
        entityType: 'permit',
        entityId: id,
        after: { source: 'external', external: true },
        source: 'server',
        ...meta,
      });
      return {
        redirect: permit.pdf_url,
        hash: permit.pdf_hash,
        size_bytes: permit.pdf_size_bytes,
      };
    }

    if (!permit.pdf_generated_at) {
      throw new DomainError(
        'E-NOT-01',
        'PDF ещё не сформирован: запросите ссылку заново',
      );
    }
    const pdf = buildPermitPdf(
      this.toPdfData(permit, this.isoDate(permit.pdf_generated_at)),
    );
    const hash = createHash('sha256').update(pdf).digest('hex');
    if (permit.pdf_hash && permit.pdf_hash !== hash) {
      throw new DomainError(
        'E-VAL-01',
        'Целостность PDF не подтверждена: сформируйте документ заново',
      );
    }

    await this.audit.record(this.db, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'permit.pdf_download',
      entityType: 'permit',
      entityId: id,
      after: { source: 'generated', hash, size_bytes: pdf.length },
      source: 'server',
      ...meta,
    });

    return {
      pdf,
      filename: `permit-${permit.number.replace(/[^\w.-]+/g, '_')}.pdf`,
      hash,
      size_bytes: pdf.length,
    };
  }

  private sign(payload: PdfTokenPayload): string {
    const body = base64url(JSON.stringify(payload));
    const signature = createHmac('sha256', this.secret()).update(body).digest();
    return `${body}.${base64url(signature)}`;
  }

  private verify(token: string | undefined): PdfTokenPayload | null {
    if (!token) {
      return null;
    }
    const [body, signature] = token.split('.');
    if (!body || !signature) {
      return null;
    }
    const expected = createHmac('sha256', this.secret()).update(body).digest();
    const provided = fromBase64url(signature);
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      return null;
    }
    try {
      const payload = JSON.parse(fromBase64url(body).toString('utf8')) as PdfTokenPayload;
      if (
        typeof payload.p !== 'string' ||
        typeof payload.e !== 'number' ||
        typeof payload.v !== 'number' ||
        (payload.s !== 'generated' && payload.s !== 'external')
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
    return env.PERMIT_PDF_SECRET ?? env.COOKIE_SECRET;
  }

  private async loadPermit(id: string): Promise<PermitPdfRow> {
    const result = await this.db.query<PermitPdfRow>(
      `select p.*, s.name as site_name, s.code as site_code,
              u.full_name as responsible_name
         from permits p
         left join sites s on s.id = p.site_id
         left join users u on u.id = p.responsible_user_id
        where p.id = $1`,
      [id],
    );
    const permit = result.rows[0];
    if (!permit) {
      throw new DomainError('E-NOT-01', 'Наряд не найден');
    }
    return permit;
  }

  private async assertVisible(actor: AuthUser, permit: PermitPdfRow): Promise<void> {
    if (
      loadEnv().PERMIT_VISIBILITY_MODE === 'participant' &&
      actor.role === 'worker'
    ) {
      const allowed = await this.db.query(
        'select 1 from permit_participants where permit_id = $1 and user_id = $2',
        [permit.id, actor.id],
      );
      if (!allowed.rows[0]) {
        throw new DomainError('E-NOT-01', 'Наряд не найден');
      }
    }
  }

  private toPdfData(permit: PermitPdfRow, generatedAt: string): PermitPdfData {
    return {
      id: permit.id,
      number: permit.number,
      year: Number(permit.year),
      type: permit.type,
      status: permit.status,
      valid_from: this.isoDate(permit.valid_from),
      valid_to: this.isoDate(permit.valid_to),
      site_name: permit.site_name,
      site_code: permit.site_code,
      work_description: permit.work_description,
      responsible_name: permit.responsible_name,
      external_id: permit.external_id,
      source_id: permit.source_id,
      external_url: permit.external_url,
      version: Number(permit.version),
      generated_at: generatedAt,
    };
  }

  /** Stable ISO formatting: drivers may return Date or string values. */
  private isoDate(value: unknown): string {
    if (value instanceof Date) {
      return value.toISOString();
    }
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
  }
}
