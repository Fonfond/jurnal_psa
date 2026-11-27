import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { DomainError, type Role, uuidv7 } from '@logbook/shared';
import { sha256, stableStringify } from '../common/context';
import type { SqlClient } from '../db/sql-client';
import { DB } from '../db/tokens';

export interface AuditInput {
  actorId: string;
  actorRole: Role;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  source: 'client' | 'server';
  deviceId?: string | null;
  requestId?: string | null;
  appVersion?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  occurredAt?: string;
}

interface AuditRow {
  id: string;
  occurred_at: string;
  actor_id: string;
  actor_role: Role;
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
}

/**
 * Canonical JSON value used for hashing/writing audit payloads: dates become
 * ISO strings and undefined properties are dropped, so the hash recomputed
 * from the JSONB column matches the original.
 */
function auditValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  return JSON.parse(JSON.stringify(value)) as unknown;
}

@Injectable()
export class AuditService implements OnModuleInit, OnModuleDestroy {
  /**
   * Per-transaction audit buffers used by the batch sync push. While a buffer
   * is active, `record` only collects the input; the caller writes the whole
   * buffer to the durable audit outbox inside the SAME business transaction.
   */
  private readonly batches = new WeakMap<SqlClient, AuditInput[]>();

  private timer: NodeJS.Timeout | undefined;
  private draining = false;
  private closed = false;

  constructor(@Inject(DB) private readonly db: SqlClient) {}

  onModuleInit(): void {
    // Durable outbox delivery: crash-safe, at-least-once within one transaction.
    this.timer = setInterval(() => {
      void this.drainOutbox().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!/closed|shutdown/i.test(message)) {
          console.error('audit outbox delivery failed', message);
        }
      });
    }, 25);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.flushPending();
  }

  beginBatch(tx: SqlClient): void {
    if (!this.batches.has(tx)) {
      this.batches.set(tx, []);
    }
  }

  batchMark(tx: SqlClient): number {
    return this.batches.get(tx)?.length ?? 0;
  }

  /** Discards audit events collected inside a rolled-back savepoint. */
  batchRollback(tx: SqlClient, mark: number): void {
    const buffer = this.batches.get(tx);
    if (buffer) {
      buffer.length = Math.min(buffer.length, mark);
    }
  }

  async record(tx: SqlClient, input: AuditInput): Promise<string> {
    const buffer = this.batches.get(tx);
    if (buffer) {
      buffer.push(input);
      return '';
    }
    return this.recordNow(tx, input);
  }

  /** Detaches buffered inputs so the caller can write them to the outbox. */
  takeBatch(tx: SqlClient): AuditInput[] {
    const inputs = this.batches.get(tx) ?? [];
    this.batches.delete(tx);
    return inputs;
  }

  /** Patches `after` of the last buffered event for an entity (journal_seq). */
  patchBufferedAfter(
    tx: SqlClient,
    entityId: string,
    patch: Record<string, unknown>,
  ): void {
    const buffer = this.batches.get(tx);
    if (!buffer) {
      return;
    }
    for (let index = buffer.length - 1; index >= 0; index -= 1) {
      const input = buffer[index]!;
      if (input.entityId === entityId && input.after && typeof input.after === 'object') {
        Object.assign(input.after as Record<string, unknown>, patch);
        return;
      }
    }
  }

  /**
   * Writes buffered audit events to `audit_outbox` in the caller's transaction.
   * This is atomic with the business change: a crash after commit leaves rows
   * in the outbox, and the delivery worker finishes the hash chain later.
   */
  async writeOutbox(tx: SqlClient, inputs: AuditInput[]): Promise<number> {
    if (inputs.length === 0) {
      return 0;
    }
    const records = inputs.map((input) => ({
      id: uuidv7(),
      occurred_at: input.occurredAt ?? new Date().toISOString(),
      actor_id: input.actorId,
      actor_role: input.actorRole,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId ?? null,
      before: auditValue(input.before),
      after: auditValue(input.after),
      reason: input.reason ?? null,
      source: input.source,
      device_id: input.deviceId ?? null,
      ip: input.ip ?? null,
      user_agent: input.userAgent ?? null,
      request_id: input.requestId ?? null,
      app_version: input.appVersion ?? null,
    }));
    await tx.query(
      `insert into audit_outbox
         (id, occurred_at, actor_id, actor_role, action, entity_type, entity_id,
          before, after, reason, source, device_id, ip, user_agent, request_id,
          app_version)
       select x.id, x.occurred_at, x.actor_id, x.actor_role, x.action,
              x.entity_type, x.entity_id, x.before, x.after, x.reason,
              x.source, x.device_id, x.ip, x.user_agent, x.request_id,
              x.app_version
         from jsonb_to_recordset($1::jsonb) as x(
              id uuid, occurred_at timestamptz, actor_id uuid,
              actor_role user_role_enum, action text, entity_type text,
              entity_id uuid, before jsonb, after jsonb, reason text,
              source text, device_id uuid, ip inet, user_agent text,
              request_id text, app_version text)`,
      [JSON.stringify(records)],
    );
    return records.length;
  }

  /**
   * Delivers one outbox batch: claim rows (SKIP LOCKED for multiple API
   * instances), write the hash-chain segment, delete the claimed rows — all in
   * one transaction. A crash rolls everything back; rows remain for retry.
   */
  async drainOutbox(limit = 300): Promise<number> {
    if (this.draining) {
      return 0;
    }
    this.draining = true;
    try {
      return await this.db.transaction(async (tx) => {
        const rows = await tx.query<{
          id: string;
          occurred_at: string | Date;
          actor_id: string;
          actor_role: Role;
          action: string;
          entity_type: string;
          entity_id: string | null;
          before: unknown;
          after: unknown;
          reason: string | null;
          source: string;
          device_id: string | null;
          ip: string | null;
          user_agent: string | null;
          request_id: string | null;
          app_version: string | null;
        }>(
          `select id, occurred_at, actor_id, actor_role, action, entity_type,
                  entity_id, before, after, reason, source, device_id, ip,
                  user_agent, request_id, app_version
             from audit_outbox
            where not (
                    action = 'entry.create'
                    and (after->>'journal_seq') is not null
                    and (after->>'journal_seq')::bigint < 0
                  )
            order by created_at asc, id asc
            limit $1
            for update skip locked`,
          [limit],
        );
        if (rows.rows.length === 0) {
          return 0;
        }
        const inputs: AuditInput[] = rows.rows.map((row) => ({
          actorId: row.actor_id,
          actorRole: row.actor_role,
          action: row.action,
          entityType: row.entity_type,
          entityId: row.entity_id,
          before: row.before,
          after: row.after,
          reason: row.reason,
          source: row.source as 'client' | 'server',
          deviceId: row.device_id,
          ip: row.ip,
          userAgent: row.user_agent,
          requestId: row.request_id,
          appVersion: row.app_version,
          occurredAt:
            row.occurred_at instanceof Date
              ? row.occurred_at.toISOString()
              : new Date(String(row.occurred_at)).toISOString(),
        }));
        await this.writeInputs(tx, inputs);
        await tx.query(
          'delete from audit_outbox where id = any($1::uuid[])',
          [rows.rows.map((row) => row.id)],
        );
        return rows.rows.length;
      });
    } finally {
      this.draining = false;
    }
  }

  /**
   * Waits until queued audit events are written; used by audit reads and the
   * retention hash-chain verification so tests/admin see a consistent chain.
   */
  async flushPending(): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (this.draining) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        continue;
      }
      const delivered = await this.drainOutbox();
      if (delivered === 0) {
        return;
      }
    }
  }

  /**
   * Flushes buffered audit inputs: one advisory lock and one SELECT per stream,
   * sequential hash-chain computation, one multi-row INSERT per stream.
   */
  async flushBatch(tx: SqlClient): Promise<number> {
    return this.writeInputs(tx, this.takeBatch(tx));
  }

  private async writeInputs(
    tx: SqlClient,
    inputs: AuditInput[],
  ): Promise<number> {
    if (inputs.length === 0) {
      return 0;
    }
    const groups = new Map<string, Array<{ input: AuditInput; occurredAt: string }>>();
    for (const input of inputs) {
      const occurredAt = input.occurredAt ?? new Date().toISOString();
      const stream = `logbook:${occurredAt.slice(0, 10)}`;
      const list = groups.get(stream) ?? [];
      list.push({ input, occurredAt });
      groups.set(stream, list);
    }

    let written = 0;
    for (const [stream, entries] of groups) {
      if (tx.advisoryXactLock) {
        await tx.advisoryXactLock(stream);
      }
      const last = await tx.query<{ stream_seq: string; hash: string }>(
        `select stream_seq::text as stream_seq, hash
           from audit_events
          where stream = $1
          order by audit_events.stream_seq desc
          limit 1`,
        [stream],
      );
      let streamSeq = last.rows[0] ? Number(last.rows[0].stream_seq) : 0;
      let prevHash = last.rows[0]?.hash ?? '0'.repeat(64);

      const values: unknown[] = [];
      const placeholders: string[] = [];
      for (const entry of entries) {
        streamSeq += 1;
        const input = entry.input;
        const before = auditValue(input.before);
        const after = auditValue(input.after);
        const payload = {
          occurred_at: entry.occurredAt,
          actor_id: input.actorId,
          actor_role: input.actorRole,
          action: input.action,
          entity_type: input.entityType,
          entity_id: input.entityId ?? null,
          before,
          after,
          reason: input.reason ?? null,
          source: input.source,
          stream,
          stream_seq: streamSeq,
        };
        const hash = sha256(prevHash + stableStringify(payload));
        const base = values.length;
        values.push(
          uuidv7(),
          entry.occurredAt,
          input.actorId,
          input.actorRole,
          input.action,
          input.entityType,
          input.entityId ?? null,
          before === null ? null : JSON.stringify(before),
          after === null ? null : JSON.stringify(after),
          input.reason ?? null,
          input.source,
          input.deviceId ?? null,
          input.ip ?? null,
          input.userAgent ?? null,
          input.requestId ?? null,
          input.appVersion ?? null,
          stream,
          streamSeq,
          prevHash,
          hash,
        );
        placeholders.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::user_role_enum,
            $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}::jsonb,
            $${base + 9}::jsonb, $${base + 10}, $${base + 11}, $${base + 12},
            $${base + 13}::inet, $${base + 14}, $${base + 15}, $${base + 16},
            $${base + 17}, $${base + 18}, $${base + 19}, $${base + 20})`,
        );
        prevHash = hash;
      }

      await tx.query(
        `insert into audit_events
           (id, occurred_at, actor_id, actor_role, action, entity_type, entity_id,
            before, after, reason, source, device_id, ip, user_agent, request_id,
            app_version, stream, stream_seq, prev_hash, hash)
         values ${placeholders.join(', ')}`,
        values,
      );
      written += entries.length;
    }
    return written;
  }

  private async recordNow(tx: SqlClient, input: AuditInput): Promise<string> {
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const stream = `logbook:${occurredAt.slice(0, 10)}`;

    // The audit chain is read-last-seq + insert. On PostgreSQL concurrent
    // writers would compute the same stream_seq and hit audit_stream_unique.
    // A transaction-scoped advisory lock serializes allocation per stream;
    // `transaction` is nested for callers already inside a transaction, so the
    // audit event stays atomic with the business change.
    return tx.transaction(async (inner) => {
      if (inner.advisoryXactLock) {
        await inner.advisoryXactLock(stream);
      }

      const last = await inner.query<{ stream_seq: string; hash: string }>(
        `select stream_seq::text as stream_seq, hash
           from audit_events
          where stream = $1
          order by audit_events.stream_seq desc
          limit 1`,
        [stream],
      );
      const previous = last.rows[0];
      const streamSeq = previous ? Number(previous.stream_seq) + 1 : 1;
      const prevHash = previous?.hash ?? '0'.repeat(64);

      const payload = {
        occurred_at: occurredAt,
        actor_id: input.actorId,
        actor_role: input.actorRole,
        action: input.action,
        entity_type: input.entityType,
        entity_id: input.entityId ?? null,
        before: auditValue(input.before),
        after: auditValue(input.after),
        reason: input.reason ?? null,
        source: input.source,
        stream,
        stream_seq: streamSeq,
      };
      const hash = sha256(prevHash + stableStringify(payload));

      await inner.query(
        `insert into audit_events
           (id, occurred_at, actor_id, actor_role, action, entity_type, entity_id,
            before, after, reason, source, device_id, ip, user_agent, request_id,
            app_version, stream, stream_seq, prev_hash, hash)
         values
           ($1, $2, $3, $4::user_role_enum, $5, $6, $7,
            $8::jsonb, $9::jsonb, $10, $11, $12, $13::inet, $14, $15,
            $16, $17, $18, $19, $20)`,
        [
          uuidv7(),
          occurredAt,
          input.actorId,
          input.actorRole,
          input.action,
          input.entityType,
          input.entityId ?? null,
          payload.before === null ? null : JSON.stringify(payload.before),
          payload.after === null ? null : JSON.stringify(payload.after),
          input.reason ?? null,
          input.source,
          input.deviceId ?? null,
          input.ip ?? null,
          input.userAgent ?? null,
          input.requestId ?? null,
          input.appVersion ?? null,
          stream,
          streamSeq,
          prevHash,
          hash,
        ],
      );

      return hash;
    });
  }

  async list(
    actor: { id: string; role: Role; departmentId: string },
    query: {
      action?: string;
      entity_type?: string;
      entity_id?: string;
      from?: string;
      to?: string;
      limit: number;
    },
  ): Promise<Array<Record<string, unknown>>> {
    await this.flushPending();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.action) {
      params.push(query.action);
      conditions.push(`a.action = $${params.length}`);
    }
    if (query.entity_type) {
      params.push(query.entity_type);
      conditions.push(`a.entity_type = $${params.length}`);
    }
    if (query.entity_id) {
      params.push(query.entity_id);
      conditions.push(`a.entity_id = $${params.length}`);
    }
    if (query.from) {
      params.push(query.from);
      conditions.push(`a.occurred_at >= $${params.length}`);
    }
    if (query.to) {
      params.push(query.to);
      conditions.push(`a.occurred_at <= $${params.length}`);
    }

    if (actor.role === 'worker') {
      params.push(actor.id);
      conditions.push(`a.actor_id = $${params.length}`);
    } else if (actor.role === 'supervisor') {
      params.push(actor.departmentId);
      conditions.push(`a.actor_id in (
        with recursive dept as (
          select id from departments where id = $${params.length}
          union all
          select d.id from departments d join dept on d.parent_id = dept.id
        )
        select u.id from users u where u.department_id in (select id from dept)
      )`);
    }

    params.push(query.limit);
    const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : '';

    const result = await this.db.query<AuditRow>(
      `select a.id, a.occurred_at, a.actor_id, a.actor_role, a.action,
              a.entity_type, a.entity_id, a.before, a.after, a.reason, a.source,
              a.stream, a.stream_seq::text as stream_seq, a.prev_hash, a.hash
         from audit_events a
         ${where}
        order by a.occurred_at desc, a.stream_seq desc
        limit $${params.length}`,
      params,
    );

    return result.rows.map((row) => ({
      id: row.id,
      occurred_at: row.occurred_at,
      actor_id: row.actor_id,
      actor_role: row.actor_role,
      action: row.action,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      before: row.before,
      after: row.after,
      reason: row.reason,
      source: row.source,
      stream: row.stream,
      stream_seq: Number(row.stream_seq),
      prev_hash: row.prev_hash,
      hash: row.hash,
    }));
  }

  async createExport(
    userId: string,
    type: string,
  ): Promise<{ id: string; status: string }> {
    if (!['audit', 'entries', 'user_data'].includes(type)) {
      throw new DomainError('E-VAL-01', 'Неизвестный тип выгрузки');
    }
    const id = uuidv7();
    // TODO(v1.1): actual file generation and signed URL.
    await this.db.query(
      `insert into export_jobs (id, user_id, type, status, expires_at)
       values ($1, $2, $3, 'queued', $4)`,
      [id, userId, type, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()],
    );
    return { id, status: 'queued' };
  }

  async getExport(
    userId: string,
    role: Role,
    id: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.db.query(
      `select id, user_id, type, status, file_url, created_at, expires_at
         from export_jobs where id = $1`,
      [id],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new DomainError('E-NOT-01', 'Выгрузка не найдена');
    }
    if (role !== 'admin' && row.user_id !== userId) {
      throw new DomainError('E-AUTH-02', 'Недостаточно прав');
    }
    return row;
  }
}
