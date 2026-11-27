import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  type Role,
  type SignatureEntityType,
  type SignatureKind,
  type SignatureRecord,
  type SignatureStatus,
  uuidv7,
} from '@logbook/shared';
import { AuditService } from '../audit/audit.service';
import { loadEnv, type Env } from '../config/env';
import type { AuthUser, RequestMeta } from '../common/types';
import type { SqlClient } from '../db/sql-client';
import { DB } from '../db/tokens';
import { entryVisaContentHash, shiftContentHash } from './content-hash';
import { createSignatureProvider } from './factory';
import { signatureLegalNote } from './signature.constants';
import type {
  ActiveSignatureKind,
  ProviderSignature,
  SignatureProvider,
  SignatureSubject,
} from './signature.provider';

interface SignatureRow {
  id: string;
  entity_type: SignatureEntityType;
  entity_id: string;
  entity_version: number;
  content_hash: string;
  kind: ActiveSignatureKind;
  algorithm: string;
  signature_value: string;
  key_id: string | null;
  certificate_serial: string | null;
  certificate_subject: string | null;
  signer_id: string;
  signed_at: string;
  status: SignatureStatus;
  metadata: Record<string, unknown> | null;
}

const SIGNATURE_COLUMNS = `id, entity_type, entity_id, entity_version, content_hash,
       kind, algorithm, signature_value, key_id, certificate_serial,
       certificate_subject, signer_id, signed_at, status, metadata`;

export interface SignatureInfo {
  provider: SignatureKind;
  algorithm: string | null;
  auto_sign: boolean;
  legal_note: string;
}

/**
 * Signature orchestration: adapter selection, persistence, verification and
 * audit. Legal status is not claimed for `simple` (OQ-04 stays open).
 */
@Injectable()
export class SignatureService {
  private readonly env: Env;
  private readonly provider: SignatureProvider | null;

  constructor(
    @Inject(DB) private readonly db: SqlClient,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.env = loadEnv();
    this.provider = createSignatureProvider(this.env);
  }

  get kind(): SignatureKind {
    return this.env.SIGNATURE_PROVIDER;
  }

  /** Auto-signing runs inside DB transactions, so only the in-process adapter. */
  get canAutoSign(): boolean {
    return (
      this.provider?.kind === 'simple' && this.env.SIGNATURE_AUTO_SIGN
    );
  }

  get info(): SignatureInfo {
    return {
      provider: this.kind,
      algorithm: this.provider?.algorithm ?? null,
      auto_sign: this.canAutoSign,
      legal_note: signatureLegalNote(this.kind, this.env.SIGNATURE_LEGAL_NOTE),
    };
  }

  private requireProvider(): SignatureProvider {
    if (!this.provider) {
      throw new DomainError(
        'E-SIG-02',
        'Электронная подпись не настроена (SIGNATURE_PROVIDER=none). См. OQ-04.',
      );
    }
    return this.provider;
  }

  /**
   * Signs an entity version. Idempotent: re-signing the same version returns
   * the existing signature instead of creating a second one.
   */
  async signInTx(
    tx: SqlClient,
    actor: Pick<AuthUser, 'id' | 'role'>,
    subject: SignatureSubject,
    meta: RequestMeta = {},
  ): Promise<SignatureRecord> {
    const provider = this.requireProvider();

    const existing = await tx.query<SignatureRow>(
      `select ${SIGNATURE_COLUMNS}
         from document_signatures
        where entity_type = $1::signature_entity_type_enum
          and entity_id = $2 and entity_version = $3 and kind = $4::signature_kind_enum
        limit 1`,
      [subject.entityType, subject.entityId, subject.entityVersion, provider.kind],
    );
    if (existing.rows[0]) {
      return this.mapSignature(existing.rows[0]);
    }

    let produced: ProviderSignature;
    try {
      produced = await provider.sign(subject);
    } catch (error) {
      throw new DomainError(
        'E-SIG-02',
        error instanceof Error ? error.message : 'Не удалось подписать документ',
      );
    }

    const inserted = await tx.query<SignatureRow>(
      `insert into document_signatures
         (id, entity_type, entity_id, entity_version, content_hash, kind, algorithm,
          signature_value, key_id, certificate_serial, certificate_subject,
          signer_id, metadata)
       values ($1, $2::signature_entity_type_enum, $3, $4, $5, $6::signature_kind_enum,
               $7, $8, $9, $10, $11, $12, $13::jsonb)
       on conflict (entity_type, entity_id, entity_version, kind) do nothing
       returning ${SIGNATURE_COLUMNS}`,
      [
        uuidv7(),
        subject.entityType,
        subject.entityId,
        subject.entityVersion,
        subject.contentHash,
        produced.kind,
        produced.algorithm,
        produced.value,
        produced.keyId,
        produced.certificateSerial,
        produced.certificateSubject,
        subject.signerId,
        produced.metadata ? JSON.stringify(produced.metadata) : null,
      ],
    );

    if (!inserted.rows[0]) {
      const current = await tx.query<SignatureRow>(
        `select ${SIGNATURE_COLUMNS}
           from document_signatures
          where entity_type = $1::signature_entity_type_enum
            and entity_id = $2 and entity_version = $3 and kind = $4::signature_kind_enum
          limit 1`,
        [subject.entityType, subject.entityId, subject.entityVersion, provider.kind],
      );
      if (!current.rows[0]) {
        throw new DomainError('E-SIG-01', 'Подпись не сохранена');
      }
      return this.mapSignature(current.rows[0]);
    }

    const signature = this.mapSignature(inserted.rows[0]);
    await this.audit.record(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'signature.create',
      entityType: 'signature',
      entityId: signature.id,
      after: {
        entity_type: signature.entity_type,
        entity_id: signature.entity_id,
        entity_version: signature.entity_version,
        kind: signature.kind,
        algorithm: signature.algorithm,
        content_hash: signature.content_hash,
      },
      source: 'server',
      ...meta,
    });

    return signature;
  }

  async listFor(
    entityType: SignatureEntityType,
    entityId: string,
  ): Promise<SignatureRecord[]> {
    const result = await this.db.query<SignatureRow>(
      `select ${SIGNATURE_COLUMNS}
         from document_signatures
        where entity_type = $1::signature_entity_type_enum and entity_id = $2
        order by signed_at desc`,
      [entityType, entityId],
    );
    return result.rows.map((row) => this.mapSignature(row));
  }

  /**
   * Re-derives the canonical content from the stored entity and re-checks the
   * signature. An entry signature is bound to its version: any later edit or
   * unverify invalidates it.
   */
  async verifyById(
    signatureId: string,
    meta: RequestMeta = {},
  ): Promise<{
    signature: SignatureRecord;
    valid: boolean;
    reason?: string;
  }> {
    const result = await this.db.query<SignatureRow>(
      `select ${SIGNATURE_COLUMNS} from document_signatures where id = $1`,
      [signatureId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new DomainError('E-NOT-01', 'Подпись не найдена');
    }

    const subject = await this.deriveSubject(row);
    if (!subject) {
      return {
        signature: this.mapSignature(row),
        valid: false,
        reason: 'Подписанный документ не найден',
      };
    }

    let verification: { valid: boolean; reason?: string };
    if (
      subject.entityVersion !== row.entity_version &&
      row.entity_type !== 'shift' &&
      row.entity_type !== 'export'
    ) {
      verification = {
        valid: false,
        reason: 'Версия документа изменилась после подписания',
      };
    } else if (!this.provider) {
      verification = {
        valid: false,
        reason: 'Провайдер ЭП не настроен: проверка невозможна',
      };
    } else {
      try {
        verification = await this.provider.verify(subject, {
          kind: row.kind,
          algorithm: row.algorithm,
          value: row.signature_value,
          keyId: row.key_id,
          certificateSerial: row.certificate_serial,
          certificateSubject: row.certificate_subject,
          metadata: row.metadata,
        });
      } catch (error) {
        verification = {
          valid: false,
          reason:
            error instanceof Error ? error.message : 'Ошибка проверки подписи',
        };
      }
    }

    if (!verification.valid) {
      const signer = await this.db.query<{ role: Role }>(
        'select role from users where id = $1',
        [row.signer_id],
      );
      await this.db.transaction(async (tx) => {
        await tx.query(
          `update document_signatures set status = 'invalid' where id = $1`,
          [signatureId],
        );
        await this.audit.record(tx, {
          actorId: row.signer_id,
          actorRole: signer.rows[0]?.role ?? 'worker',
          action: 'signature.invalid',
          entityType: 'signature',
          entityId: signatureId,
          reason: verification.reason ?? null,
          source: 'server',
          ...meta,
        });
      });
    }

    return {
      signature: {
        ...this.mapSignature(row),
        status: verification.valid ? row.status : 'invalid',
      },
      valid: verification.valid,
      ...(verification.reason ? { reason: verification.reason } : {}),
    };
  }

  private async deriveSubject(row: SignatureRow): Promise<SignatureSubject | null> {
    if (row.entity_type === 'export') {
      const exportRow = await this.db.query<{ file_sha256: string | null }>(
        'select file_sha256 from export_jobs where id = $1',
        [row.entity_id],
      );
      const hash = exportRow.rows[0]?.file_sha256;
      if (!hash) {
        return null;
      }
      return {
        entityType: 'export',
        entityId: row.entity_id,
        entityVersion: Number(row.entity_version),
        contentHash: hash,
        signerId: row.signer_id,
      };
    }

    if (row.entity_type === 'shift') {
      const shift = await this.db.query<Record<string, unknown>>(
        'select * from shifts where id = $1',
        [row.entity_id],
      );
      const record = shift.rows[0];
      if (!record) {
        return null;
      }
      return {
        entityType: 'shift',
        entityId: row.entity_id,
        entityVersion: Number(row.entity_version),
        contentHash: shiftContentHash(record, Number(row.entity_version)),
        signerId: row.signer_id,
      };
    }

    if (row.entity_type === 'journal_review') {
      const review = await this.db.query<{ content_hash: string; reviewer_id: string }>(
        'select content_hash, reviewer_id from journal_reviews where id = $1',
        [row.entity_id],
      );
      if (!review.rows[0]) {
        return null;
      }
      return {
        entityType: 'journal_review',
        entityId: row.entity_id,
        entityVersion: 0,
        contentHash: review.rows[0].content_hash,
        signerId: row.signer_id,
      };
    }

    const entry = await this.db.query<Record<string, unknown>>(
      'select * from journal_entries where id = $1',
      [row.entity_id],
    );
    if (!entry.rows[0]) {
      return null;
    }
    return {
      entityType: 'entry',
      entityId: row.entity_id,
      entityVersion: Number(entry.rows[0].version),
      contentHash: entryVisaContentHash(entry.rows[0]),
      signerId: row.signer_id,
    };
  }

  private mapSignature(row: SignatureRow): SignatureRecord {
    return {
      id: row.id,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      entity_version: Number(row.entity_version),
      content_hash: row.content_hash,
      kind: row.kind,
      algorithm: row.algorithm,
      value: row.signature_value,
      key_id: row.key_id,
      certificate_serial: row.certificate_serial,
      certificate_subject: row.certificate_subject,
      signer_id: row.signer_id,
      signed_at:
        typeof row.signed_at === 'string'
          ? row.signed_at
          : new Date(row.signed_at).toISOString(),
      status: row.status,
      metadata: row.metadata,
      legal_note: signatureLegalNote(this.kind, this.env.SIGNATURE_LEGAL_NOTE),
    };
  }
}
