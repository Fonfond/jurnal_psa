import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  formatHlc,
  maxHlc,
  shiftActionSchema,
  shiftHandoverSchema,
  uuidv7,
  type Shift,
  type ShiftActionInput,
  type ShiftHandoverInput,
  type ShiftListQuery,
  type SyncPushOp,
  type SyncPushResult,
} from '@logbook/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestMeta } from '../common/types';
import { appendChange } from '../db/change-log';
import type { SqlClient } from '../db/sql-client';
import { DB } from '../db/tokens';
import { JournalsService } from '../journals/journals.service';
import {
  shiftAcceptanceContentHash,
  shiftEntriesHash,
  shiftHandoverContentHash,
} from '../signature/content-hash';
import { SignatureService } from '../signature/signature.service';

export interface ShiftRow extends Record<string, unknown> {
  id: string;
  journal_id: string;
  shift_date: string;
  period_start: string | Date;
  period_end: string | Date;
  status: string;
  handed_over_by: string;
  handed_over_at: string | Date;
  handover_comment: string;
  accepted_by: string | null;
  accepted_at: string | Date | null;
  acceptance_comment: string | null;
  rejected_by: string | null;
  rejected_at: string | Date | null;
  rejection_reason: string | null;
  entries_count: number;
  entries_hash: string;
  content_hash: string;
  version: number;
  hlc: string;
  handed_over_by_name?: string | null;
  accepted_by_name?: string | null;
  rejected_by_name?: string | null;
}

const SHIFT_SELECT = `select s.*,
       hu.full_name as handed_over_by_name,
       au.full_name as accepted_by_name,
       ru.full_name as rejected_by_name
  from shifts s
  join users hu on hu.id = s.handed_over_by
  left join users au on au.id = s.accepted_by
  left join users ru on ru.id = s.rejected_by`;

interface InternalOptions {
  id?: string;
  hlc?: string;
  clientTime?: string;
  deviceId?: string | null;
  opId?: string | null;
  baseVersion?: number | null;
}

/**
 * Shift handover (JRN-02, ADR-19): the outgoing supervisor hands the journal
 * over with a signature, the incoming supervisor accepts or rejects it with a
 * second signature. Both sides may act offline; sync replays the operations.
 */
@Injectable()
export class ShiftsService {
  constructor(
    @Inject(DB) private readonly db: SqlClient,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(JournalsService) private readonly journals: JournalsService,
    @Inject(SignatureService) private readonly signatures: SignatureService,
  ) {}

  async list(
    actor: AuthUser,
    query: ShiftListQuery,
  ): Promise<{ items: Array<Record<string, unknown>> }> {
    const params: unknown[] = [];
    const conditions: string[] = ['true'];

    if (query.journal_id) {
      await this.journals.assertAccess(actor, query.journal_id, 'read');
      conditions.push(`s.journal_id = $${params.push(query.journal_id)}::uuid`);
    } else if (actor.role === 'supervisor') {
      const mainParam = params.push('main');
      const memberParam = params.push(actor.id);
      conditions.push(`exists (
        select 1 from journals j
         where j.id = s.journal_id
           and (j.journal_key = $${mainParam} or exists (
             select 1 from journal_members jm
              where jm.journal_id = j.id and jm.user_id = $${memberParam}::uuid
           ))
      )`);
    } else if (actor.role === 'worker') {
      const userParam = params.push(actor.id);
      conditions.push(
        `(s.handed_over_by = $${userParam}::uuid or s.accepted_by = $${userParam}::uuid)`,
      );
    } else if (actor.role !== 'admin' && actor.role !== 'auditor') {
      throw new DomainError('E-AUTH-02', 'Недостаточно прав');
    }

    if (query.status) {
      conditions.push(`s.status = $${params.push(query.status)}::shift_status_enum`);
    }
    if (query.from) {
      conditions.push(`s.shift_date >= $${params.push(query.from)}::date`);
    }
    if (query.to) {
      conditions.push(`s.shift_date <= $${params.push(query.to)}::date`);
    }

    const result = await this.db.query<ShiftRow>(
      `${SHIFT_SELECT}
        where ${conditions.join(' and ')}
        order by s.shift_date desc, s.handed_over_at desc
        limit $${params.push(query.limit)}`,
      params,
    );

    return { items: result.rows.map((row) => this.mapShift(row)) };
  }

  async get(actor: AuthUser, id: string): Promise<Record<string, unknown>> {
    const shift = await this.loadShift(this.db, id);
    if (!shift) {
      throw new DomainError('E-NOT-01', 'Смена не найдена');
    }
    await this.assertRead(actor, shift);
    return {
      ...this.mapShift(shift),
      signatures: await this.signatures.listFor('shift', id),
    };
  }

  /** Online handover (same core as the offline sync `create`). */
  async handover(
    actor: AuthUser,
    body: ShiftHandoverInput,
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    const parsed = shiftHandoverSchema.safeParse(body);
    if (!parsed.success) {
      throw this.validationError(parsed.error.issues);
    }
    return this.db.transaction(async (tx) => {
      const shift = await this.handoverTx(tx, actor, parsed.data, meta);
      return this.mapShift(shift);
    });
  }

  async accept(
    actor: AuthUser,
    id: string,
    body: ShiftActionInput,
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    return this.action(actor, id, { ...body, action: 'accept' }, meta);
  }

  async reject(
    actor: AuthUser,
    id: string,
    body: ShiftActionInput,
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    const parsed = shiftActionSchema.safeParse({ ...body, action: 'reject' });
    if (!parsed.success) {
      throw this.validationError(parsed.error.issues);
    }
    return this.action(actor, id, parsed.data, meta);
  }

  /**
   * Offline sync entry point: `create` = handover, `update` = accept/reject.
   * Conflicts are returned instead of thrown so the outbox can resolve them.
   */
  async applySyncOperation(
    tx: SqlClient,
    actor: AuthUser,
    deviceId: string,
    operation: SyncPushOp,
    meta: RequestMeta,
  ): Promise<SyncPushResult> {
    if (operation.op_type === 'delete') {
      throw new DomainError('E-VAL-01', 'Смену нельзя удалить');
    }

    if (operation.op_type === 'create') {
      const parsed = shiftHandoverSchema.safeParse(operation.payload);
      if (!parsed.success) {
        throw this.validationError(parsed.error.issues);
      }
      const existing = await tx.query('select id from shifts where id = $1', [
        operation.entity_id,
      ]);
      if (existing.rows[0]) {
        throw new DomainError('E-VER-01', 'Смена с таким идентификатором уже существует');
      }
      const shift = await this.handoverTx(tx, actor, parsed.data, meta, {
        id: operation.entity_id,
        hlc: operation.hlc,
        clientTime: operation.client_time,
        deviceId,
        opId: operation.op_id,
      });
      return {
        op_id: operation.op_id,
        status: 'applied',
        version: Number(shift.version),
        duplicate: false,
        merged_entry: null,
        merged_shift: this.mapShift(shift) as unknown as Shift,
        resolution: null,
        conflicts: null,
        error: null,
      };
    }

    if (operation.base_version === null) {
      throw new DomainError('E-VAL-01', 'base_version обязателен для update смены');
    }
    const parsed = shiftActionSchema.safeParse(operation.payload);
    if (!parsed.success) {
      throw this.validationError(parsed.error.issues);
    }

    const outcome = await this.actionTx(tx, actor, operation.entity_id, parsed.data, meta, {
      hlc: operation.hlc,
      clientTime: operation.client_time,
      deviceId,
      opId: operation.op_id,
      baseVersion: operation.base_version,
    });

    if (outcome.conflict) {
      return {
        op_id: operation.op_id,
        status: 'conflict',
        version: Number(outcome.shift.version),
        duplicate: false,
        merged_entry: null,
        merged_shift: this.mapShift(outcome.shift) as unknown as Shift,
        resolution: { status: 'remote' },
        conflicts: [
          {
            field: 'status',
            reason: outcome.reason ?? 'shift_version_conflict',
            local_hlc: operation.hlc,
            remote_hlc: String(outcome.shift.hlc),
          },
        ],
        error: null,
      };
    }

    return {
      op_id: operation.op_id,
      status: 'applied',
      version: Number(outcome.shift.version),
      duplicate: false,
      merged_entry: null,
      merged_shift: this.mapShift(outcome.shift) as unknown as Shift,
      resolution: null,
      conflicts: null,
      error: null,
    };
  }

  private async action(
    actor: AuthUser,
    id: string,
    body: ShiftActionInput,
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    return this.db.transaction(async (tx) => {
      const outcome = await this.actionTx(tx, actor, id, body, meta, {});
      if (outcome.conflict) {
        throw new DomainError(
          'E-VER-01',
          outcome.reason ?? 'Смена уже обработана; обновите данные',
        );
      }
      return {
        ...this.mapShift(outcome.shift),
        signatures: await this.signatures.listFor('shift', id),
      };
    });
  }

  private async handoverTx(
    tx: SqlClient,
    actor: AuthUser,
    body: ShiftHandoverInput,
    meta: RequestMeta,
    options: InternalOptions = {},
  ): Promise<ShiftRow> {
    this.assertShiftRole(actor);
    await this.journals.assertAccess(actor, body.journal_id, 'write', tx);

    const id = options.id ?? uuidv7();
    const now = new Date().toISOString();
    const clientTime = options.clientTime ?? now;
    const handedOverAt = now;
    const hlc = options.hlc ?? formatHlc(Date.parse(now), 0, 'shift001');

    const entries = await tx.query<{
      id: string;
      version: number;
      hlc: string;
      journal_seq: number | string | null;
    }>(
      `select id, version, hlc, journal_seq
         from journal_entries
        where journal_id = $1::uuid
          and status = 'active'::entry_status_enum
          and performed_at >= $2::timestamptz
          and performed_at < $3::timestamptz
        order by journal_seq asc`,
      [body.journal_id, body.period_start, body.period_end],
    );

    const entriesHash = shiftEntriesHash(entries.rows);
    const duplicate = await tx.query<{ id: string }>(
      `select id from shifts
        where journal_id = $1::uuid
          and shift_date = $2::date
          and period_start = $3::timestamptz
          and status in ('handed_over', 'accepted')
        limit 1`,
      [body.journal_id, body.shift_date, body.period_start],
    );
    if (duplicate.rows[0]) {
      throw new DomainError(
        'E-VER-01',
        'Смена на этот период уже сдана; сначала завершите её приёмку или отклонение',
      );
    }
    const contentHash = shiftHandoverContentHash({
      id,
      journal_id: body.journal_id,
      shift_date: body.shift_date,
      period_start: new Date(body.period_start).toISOString(),
      period_end: new Date(body.period_end).toISOString(),
      handed_over_by: actor.id,
      handed_over_at: handedOverAt,
      handover_comment: body.handover_comment,
      entries_count: entries.rows.length,
      entries_hash: entriesHash,
    });

    const inserted = await tx.query<ShiftRow>(
      `insert into shifts
         (id, journal_id, shift_date, period_start, period_end, status,
          handed_over_by, handed_over_at, handover_comment,
          entries_count, entries_hash, content_hash, version, hlc,
          created_at_client, created_at_server, updated_at_client,
          updated_at_server, device_id, last_op_id)
       values ($1, $2::uuid, $3::date, $4::timestamptz, $5::timestamptz,
               'handed_over'::shift_status_enum, $6, $7, $8,
               $9, $10, $11, 1, $12, $13, $14, $13, $14, $15, $16)
       returning *`,
      [
        id,
        body.journal_id,
        body.shift_date,
        body.period_start,
        body.period_end,
        actor.id,
        handedOverAt,
        body.handover_comment,
        entries.rows.length,
        entriesHash,
        contentHash,
        hlc,
        clientTime,
        now,
        options.deviceId ?? null,
        options.opId ?? null,
      ],
    );

    const shift = inserted.rows[0]!;
    await appendChange(tx, {
      entityType: 'shift',
      entityId: id,
      op: 'upsert',
      version: 1,
      actorId: actor.id,
    });
    await this.audit.record(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'shift.handover',
      entityType: 'shift',
      entityId: id,
      after: {
        journal_id: body.journal_id,
        shift_date: body.shift_date,
        period_start: body.period_start,
        period_end: body.period_end,
        entries_count: entries.rows.length,
        entries_hash: entriesHash,
        content_hash: contentHash,
      },
      source: options.deviceId ? 'client' : 'server',
      ...(options.deviceId ? { deviceId: options.deviceId } : {}),
      ...meta,
    });

    if (this.signatures.canAutoSign) {
      await this.signatures.signInTx(
        tx,
        actor,
        {
          entityType: 'shift',
          entityId: id,
          entityVersion: 1,
          contentHash,
          signerId: actor.id,
        },
        meta,
      );
    }

    return shift;
  }

  private async actionTx(
    tx: SqlClient,
    actor: AuthUser,
    id: string,
    body: ShiftActionInput,
    meta: RequestMeta,
    options: InternalOptions,
  ): Promise<{ conflict: boolean; shift: ShiftRow; reason?: string }> {
    this.assertShiftRole(actor);
    const current = await this.loadShift(tx, id, true);
    if (!current) {
      throw new DomainError('E-NOT-01', 'Смена не найдена');
    }
    await this.journals.assertAccess(actor, current.journal_id, 'write', tx);

    if (current.status !== 'handed_over') {
      return {
        conflict: true,
        shift: current,
        reason: `shift_already_${current.status}`,
      };
    }
    if (current.handed_over_by === actor.id) {
      throw new DomainError(
        'E-AUTH-02',
        'Смену принимает другой руководитель: сдающий не может принять свою смену',
      );
    }
    if (
      options.baseVersion !== undefined &&
      options.baseVersion !== null &&
      Number(current.version) !== options.baseVersion
    ) {
      return {
        conflict: true,
        shift: current,
        reason: 'newer_server_version',
      };
    }

    const now = new Date().toISOString();
    const clientTime = options.clientTime ?? now;
    const hlc = options.hlc
      ? (maxHlc([String(current.hlc), options.hlc]) ?? options.hlc)
      : formatHlc(Date.parse(now), 0, 'shift001');
    const nextVersion = Number(current.version) + 1;

    if (body.action === 'accept') {
      const acceptedAt = now;
      const acceptanceComment = body.comment ?? null;
      const contentHash = shiftAcceptanceContentHash({
        ...current,
        status: 'accepted',
        accepted_by: actor.id,
        accepted_at: acceptedAt,
        acceptance_comment: acceptanceComment,
      });

      const updated = await tx.query<ShiftRow>(
        `update shifts
            set status = 'accepted'::shift_status_enum,
                accepted_by = $1, accepted_at = $2, acceptance_comment = $3,
                content_hash = $4, version = $5, hlc = $6,
                updated_at_client = $7, updated_at_server = $2,
                device_id = coalesce($8, device_id),
                last_op_id = coalesce($9, last_op_id)
          where id = $10
          returning *`,
        [
          actor.id,
          acceptedAt,
          acceptanceComment,
          contentHash,
          nextVersion,
          hlc,
          clientTime,
          options.deviceId ?? null,
          options.opId ?? null,
          id,
        ],
      );
      const shift = updated.rows[0]!;

      await appendChange(tx, {
        entityType: 'shift',
        entityId: id,
        op: 'upsert',
        version: nextVersion,
        actorId: actor.id,
      });
      await this.audit.record(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'shift.accept',
        entityType: 'shift',
        entityId: id,
        before: { status: current.status, version: current.version },
        after: {
          status: 'accepted',
          accepted_by: actor.id,
          content_hash: contentHash,
        },
        source: options.deviceId ? 'client' : 'server',
        ...(options.deviceId ? { deviceId: options.deviceId } : {}),
        ...meta,
      });

      if (this.signatures.canAutoSign) {
        await this.signatures.signInTx(
          tx,
          actor,
          {
            entityType: 'shift',
            entityId: id,
            entityVersion: nextVersion,
            contentHash,
            signerId: actor.id,
          },
          meta,
        );
      }

      return { conflict: false, shift };
    }

    const rejectionReason = body.rejection_reason ?? body.comment ?? 'Смена отклонена';
    const rejectedAt = now;
    const updated = await tx.query<ShiftRow>(
      `update shifts
          set status = 'rejected'::shift_status_enum,
              rejected_by = $1, rejected_at = $2, rejection_reason = $3,
              version = $4, hlc = $5,
              updated_at_client = $6, updated_at_server = $2,
              device_id = coalesce($7, device_id),
              last_op_id = coalesce($8, last_op_id)
        where id = $9
        returning *`,
      [
        actor.id,
        rejectedAt,
        rejectionReason,
        nextVersion,
        hlc,
        clientTime,
        options.deviceId ?? null,
        options.opId ?? null,
        id,
      ],
    );
    const shift = updated.rows[0]!;

    await appendChange(tx, {
      entityType: 'shift',
      entityId: id,
      op: 'upsert',
      version: nextVersion,
      actorId: actor.id,
    });
    await this.audit.record(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'shift.reject',
      entityType: 'shift',
      entityId: id,
      before: { status: current.status, version: current.version },
      after: { status: 'rejected', rejection_reason: rejectionReason },
      reason: rejectionReason,
      source: options.deviceId ? 'client' : 'server',
      ...(options.deviceId ? { deviceId: options.deviceId } : {}),
      ...meta,
    });

    return { conflict: false, shift };
  }

  private async loadShift(
    tx: SqlClient,
    id: string,
    forUpdate = false,
  ): Promise<ShiftRow | null> {
    const result = await tx.query<ShiftRow>(
      `${SHIFT_SELECT} where s.id = $1 ${forUpdate ? 'for update of s' : ''}`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  private async assertRead(actor: AuthUser, shift: ShiftRow): Promise<void> {
    if (actor.role === 'admin' || actor.role === 'auditor') {
      return;
    }
    if (actor.role === 'worker') {
      if (shift.handed_over_by === actor.id || shift.accepted_by === actor.id) {
        return;
      }
      throw new DomainError('E-AUTH-02', 'Недостаточно прав');
    }
    await this.journals.assertAccess(actor, shift.journal_id, 'read');
  }

  private assertShiftRole(actor: AuthUser): void {
    if (actor.role !== 'supervisor' && actor.role !== 'admin') {
      throw new DomainError(
        'E-AUTH-02',
        'Сдачу и приёмку смены выполняет руководитель или администратор',
      );
    }
  }

  private validationError(
    issues: Array<{ path: PropertyKey[]; message: string }>,
  ): DomainError {
    const fields: Record<string, string> = {};
    for (const issue of issues) {
      const key =
        issue.path.length > 0
          ? issue.path.map((part) => String(part)).join('.')
          : '_';
      if (!fields[key]) {
        fields[key] = issue.message;
      }
    }
    return new DomainError('E-VAL-01', 'Ошибка валидации', fields);
  }

  /** Public mapping used by sync `changes` and API responses. */
  mapShift(row: ShiftRow): Record<string, unknown> {
    return {
      ...row,
      entries_count: Number(row.entries_count ?? 0),
      version: Number(row.version),
      shift_date:
        typeof row.shift_date === 'string'
          ? row.shift_date.slice(0, 10)
          : new Date(row.shift_date).toISOString().slice(0, 10),
      period_start: this.iso(row.period_start),
      period_end: this.iso(row.period_end),
      handed_over_at: this.iso(row.handed_over_at),
      accepted_at: row.accepted_at === null ? null : this.iso(row.accepted_at),
      rejected_at: row.rejected_at === null ? null : this.iso(row.rejected_at),
      created_at_client: this.iso(row.created_at_client),
      created_at_server:
        row.created_at_server === null ? null : this.iso(row.created_at_server),
      updated_at_client: this.iso(row.updated_at_client),
      updated_at_server:
        row.updated_at_server === null ? null : this.iso(row.updated_at_server),
    };
  }

  private iso(value: unknown): string {
    if (value instanceof Date) {
      return value.toISOString();
    }
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
  }
}
