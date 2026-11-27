import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  permitCsvRowSchema,
  uuidv7,
} from '@logbook/shared';
import { AuditService } from '../audit/audit.service';
import { loadEnv } from '../config/env';
import type { AuthUser, RequestMeta } from '../common/types';
import { appendChange } from '../db/change-log';
import type { SqlClient } from '../db/sql-client';
import { DB } from '../db/tokens';
import { normalizePermitNumber } from './csv';
import { selectPermitSourceAdapter } from './sources';

export { normalizePermitNumber, parseCsv } from './csv';

interface PermitRow extends Record<string, unknown> {
  id: string;
  version: number;
}

@Injectable()
export class PermitsService {
  constructor(
    @Inject(DB) private readonly db: SqlClient,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(
    actor: AuthUser,
    query: { status?: string; site_id?: string; cursor?: string; limit: number },
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const params: unknown[] = [];
    const conditions: string[] = ['p.is_deleted = false'];

    if (query.status) {
      conditions.push(`p.status = $${params.push(query.status)}::permit_status_enum`);
    }
    if (query.site_id) {
      conditions.push(`p.site_id = $${params.push(query.site_id)}::uuid`);
    }
    if (query.cursor) {
      conditions.push(`p.number_norm > $${params.push(query.cursor)}`);
    }
    if (
      loadEnv().PERMIT_VISIBILITY_MODE === 'participant' &&
      actor.role === 'worker'
    ) {
      conditions.push(
        `p.id in (select pp.permit_id from permit_participants pp where pp.user_id = $${params.push(actor.id)}::uuid)`,
      );
    }

    const limitParam = params.push(query.limit + 1);
    const result = await this.db.query<PermitRow>(
      `select p.*
         from permits p
        where ${conditions.join(' and ')}
        order by p.number_norm asc, p.id asc
        limit $${limitParam}`,
      params,
    );

    const hasMore = result.rows.length > query.limit;
    const rows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
    return {
      items: rows as Array<Record<string, unknown>>,
      next_cursor: hasMore ? String(rows[rows.length - 1]?.number_norm ?? '') : null,
    };
  }

  async get(actor: AuthUser, id: string): Promise<Record<string, unknown>> {
    const result = await this.db.query('select * from permits where id = $1', [id]);
    const row = result.rows[0];
    if (!row) {
      throw new DomainError('E-NOT-01', 'Наряд не найден');
    }
    if (
      loadEnv().PERMIT_VISIBILITY_MODE === 'participant' &&
      actor.role === 'worker'
    ) {
      const allowed = await this.db.query(
        'select 1 from permit_participants where permit_id = $1 and user_id = $2',
        [id, actor.id],
      );
      if (!allowed.rows[0]) {
        throw new DomainError('E-NOT-01', 'Наряд не найден');
      }
    }
    return row;
  }

  async importCsv(
    actor: AuthUser,
    body: {
      source_id: string;
      csv?: string;
      records?: Array<Record<string, unknown>>;
    },
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    if (!body.csv && (!body.records || body.records.length === 0)) {
      throw new DomainError(
        'E-VAL-01',
        'Передайте CSV или массив записей нарядов',
      );
    }
    const adapter = selectPermitSourceAdapter(body);
    let parsedRows;
    try {
      parsedRows = adapter.parse(body);
    } catch (error) {
      throw new DomainError(
        'E-VAL-01',
        error instanceof Error ? error.message : 'Не удалось разобрать источник',
      );
    }
    if (parsedRows.length === 0) {
      throw new DomainError('E-VAL-01', 'Источник не содержит ни одного наряда');
    }

    const errors: Array<{ row: number; message: string }> = [];
    let imported = 0;
    let updated = 0;

    for (const parsedRow of parsedRows) {
      const parsed = permitCsvRowSchema.safeParse(parsedRow.data);
      if (!parsed.success) {
        errors.push({
          row: parsedRow.row,
          message: parsed.error.issues.map((issue) => issue.message).join('; '),
        });
        continue;
      }

      const row = parsed.data;
      try {
        const result = await this.db.transaction(async (tx) => {
          const site = await tx.query<{ id: string }>(
            'select id from sites where code = $1',
            [row.site_code],
          );
          const responsible = await tx.query<{ id: string }>(
            'select id from users where lower(email) = lower($1)',
            [row.responsible_login],
          );
          if (!site.rows[0] || !responsible.rows[0]) {
            throw new DomainError(
              'E-VAL-01',
              !site.rows[0] ? 'Объект не найден' : 'Ответственный не найден',
            );
          }

          const existing = await tx.query<PermitRow>(
            `select * from permits where source_id = $1 and external_id = $2`,
            [body.source_id, row.external_id],
          );
          const numberNorm = normalizePermitNumber(row.number);
          const now = new Date().toISOString();

          if (existing.rows[0]) {
            const version = Number(existing.rows[0].version) + 1;
            await tx.query(
              `update permits
                  set number = $1, number_norm = $2, year = $3, type = $4::permit_type_enum,
                      status = $5::permit_status_enum, valid_from = $6, valid_to = $7,
                      site_id = $8, work_description = $9, responsible_user_id = $10,
                      external_url = $11::text, pdf_url = $12::text, pdf_hash = $13::text,
                      pdf_source = CASE
                        WHEN $12::text IS NOT NULL THEN 'external'::varchar
                        ELSE pdf_source
                      END,
                      updated_at_external = $14, synced_at = $14,
                      version = $15, is_deleted = false
                where id = $16`,
              [
                row.number,
                numberNorm,
                row.year,
                row.type,
                row.status,
                row.valid_from,
                row.valid_to,
                site.rows[0].id,
                row.description,
                responsible.rows[0].id,
                row.external_url ?? null,
                row.pdf_url ?? null,
                row.pdf_hash ?? null,
                now,
                version,
                existing.rows[0].id,
              ],
            );
            await appendChange(tx, {
              entityType: 'permit',
              entityId: existing.rows[0].id,
              op: 'upsert',
              version,
              actorId: actor.id,
            });
            return 'updated';
          }

          const id = uuidv7();
          await tx.query(
            `insert into permits
               (id, source_id, external_id, number, number_norm, year, type, status,
                valid_from, valid_to, site_id, work_description, responsible_user_id,
                external_url, pdf_url, pdf_hash, pdf_source,
                updated_at_external, synced_at, version)
             values ($1, $2, $3, $4, $5, $6, $7::permit_type_enum, $8::permit_status_enum,
                     $9, $10, $11, $12, $13, $14::text, $15::text, $16::text,
                     CASE WHEN $15::text IS NOT NULL THEN 'external' ELSE 'none' END,
                     $17, $17, 1)`,
            [
              id,
              body.source_id,
              row.external_id,
              row.number,
              numberNorm,
              row.year,
              row.type,
              row.status,
              row.valid_from,
              row.valid_to,
              site.rows[0].id,
              row.description,
              responsible.rows[0].id,
              row.external_url ?? null,
              row.pdf_url ?? null,
              row.pdf_hash ?? null,
              now,
            ],
          );
          await appendChange(tx, {
            entityType: 'permit',
            entityId: id,
            op: 'upsert',
            version: 1,
            actorId: actor.id,
          });
          return 'imported';
        });

        if (result === 'updated') {
          updated += 1;
        } else {
          imported += 1;
        }
      } catch (error) {
        errors.push({
          row: parsedRow.row,
          message: error instanceof Error ? error.message : 'Ошибка импорта',
        });
      }
    }

    const jobId = uuidv7();
    await this.audit.record(this.db, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'permit.import',
      entityType: 'permit',
      entityId: null,
      after: {
        job_id: jobId,
        source_id: body.source_id,
        adapter: adapter.id,
        format: adapter.kind,
        imported,
        updated,
        skipped: errors.length,
      },
      source: 'server',
      ...meta,
    });

    return {
      job_id: jobId,
      imported,
      updated,
      skipped: errors.length,
      errors,
    };
  }

  async imports(actor: AuthUser): Promise<{ items: Array<Record<string, unknown>> }> {
    const items = await this.audit.list(
      { id: actor.id, role: actor.role, departmentId: actor.departmentId },
      { action: 'permit.import', limit: 50 },
    );
    return { items };
  }
}
