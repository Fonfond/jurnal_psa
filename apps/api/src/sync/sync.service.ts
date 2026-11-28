import { Inject, Injectable } from '@nestjs/common';
import {
  DEFAULT_JOURNAL_ID,
  DomainError,
  entryPayloadSchema,
  entryUpdatePayloadSchema,
  maxHlc,
  normalizeSiteName,
  type GroundingEventData,
  type PermitStatus,
  type SyncPushOp,
  type SyncPushResult,
  uuidv7,
} from '@logbook/shared';
import { AuditService, type AuditInput } from '../audit/audit.service';
import { constantTimeEqual, sha256 } from '../common/context';
import { loadEnv } from '../config/env';
import type { AuthUser, RequestMeta } from '../common/types';
import { appendChange } from '../db/change-log';
import type { SqlClient } from '../db/sql-client';
import { DB } from '../db/tokens';
import { JournalsService, type JournalRow } from '../journals/journals.service';
import {
  ensureJournalSequence,
  journalSeqSequenceName,
} from '../journals/journal-seq';
import {
  GroundingsService,
  type GroundingRow,
} from '../groundings/groundings.service';
import { ShiftsService, type ShiftRow } from '../shifts/shifts.service';
import {
  decideMerge,
  MERGEABLE_FIELDS,
  type MergeableEntry,
  type MergeDecision,
  validateMergedEntry,
} from './merge';

interface EntryRow extends MergeableEntry {
  version: number;
  revision_no: number;
  author_department_id: string;
  [key: string]: unknown;
}

interface IdempotencyRow {
  response: SyncPushResult;
}

interface SeqRef {
  id: string;
  journalId: string;
  opId: string;
  result: SyncPushResult;
}

@Injectable()
export class SyncService {
  constructor(
    @Inject(DB) private readonly db: SqlClient,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(JournalsService) private readonly journals: JournalsService,
    @Inject(ShiftsService) private readonly shifts: ShiftsService,
    @Inject(GroundingsService) private readonly groundings: GroundingsService,
  ) {}

  async push(
    actor: AuthUser,
    body: { device_id: string; app_version: string; ops: SyncPushOp[] },
    meta: RequestMeta,
  ): Promise<{ server_time: string; results: SyncPushResult[] }> {
    const device = await this.db.query<{
      id: string;
      user_id: string;
      status: string;
      device_key_hash: string | null;
    }>(
      'select id, user_id, status, device_key_hash from devices where id = $1',
      [body.device_id],
    );
    const deviceRow = device.rows[0];
    if (!deviceRow || deviceRow.user_id !== actor.id) {
      throw new DomainError('E-AUTH-02', 'Устройство не принадлежит пользователю');
    }
    if (deviceRow.status !== 'active') {
      throw new DomainError('E-AUTH-02', 'Устройство отозвано');
    }
    if (deviceRow.device_key_hash) {
      if (!meta.deviceKey) {
        throw new DomainError(
          'E-AUTH-02',
          'Не передан ключ устройства (X-Device-Key)',
        );
      }
      const providedHash = sha256(meta.deviceKey);
      if (!constantTimeEqual(providedHash, deviceRow.device_key_hash)) {
        throw new DomainError('E-AUTH-02', 'Ключ устройства недействителен');
      }
    }

    // Idempotency lookup and journal_seq block reservation happen before the
    // batch transaction. Sequence nextval is lock-free (no counter row lock),
    // so concurrent pushes do not serialize on the journal counter.
    const opIds = body.ops.map((operation) => operation.op_id);
    const cachedRows = await this.db.query<{ op_id: string; response: SyncPushResult }>(
      `select op_id, response from idempotency_records
        where op_id = any($1::uuid[])`,
      [opIds],
    );
    const knownResults = new Map<string, SyncPushResult>(
      cachedRows.rows.map((row) => [row.op_id, row.response]),
    );
    const createContexts = await this.prepareCreateContexts(
      actor,
      body.ops,
      knownResults,
    );

    let auditInputs: AuditInput[] = [];
    // One transaction for the whole batch; each operation runs in its own
    // savepoint so a rejected/conflicting op does not roll back the batch.
    const results = await this.db.transaction(async (tx) => {
      this.audit.beginBatch(tx);
      const results: SyncPushResult[] = [];

      // Fast path for the common offline batch: many entry creates with valid
      // payloads, no permits/groundings. One INSERT for entries, one for
      // change_log, one for idempotency; audits are flushed once per stream.
      const bulkResults = await this.tryBulkCreate(
        tx,
        actor,
        body.device_id,
        body.ops,
        createContexts,
        knownResults,
        meta,
      );
      if (bulkResults) {
        results.push(...bulkResults);
        auditInputs = this.audit.takeBatch(tx);
        await this.audit.writeOutbox(tx, auditInputs);
        return results;
      }

      const successful: Array<{ opId: string; result: SyncPushResult }> = [];
      for (let index = 0; index < body.ops.length; index += 1) {
        const operation = body.ops[index]!;
        const cached = knownResults.get(operation.op_id);
        if (cached) {
          results.push({ ...cached, duplicate: true });
          continue;
        }

        const auditMark = this.audit.batchMark(tx);
        const savepoint = `push_op_${index}`;
        await tx.exec(`SAVEPOINT ${savepoint}`);
        try {
          const applied = await this.applyOperation(
            tx,
            actor,
            body.device_id,
            operation,
            meta,
            createContexts.get(index),
          );
          knownResults.set(operation.op_id, applied);
          successful.push({ opId: operation.op_id, result: applied });
          results.push(applied);
        } catch (error) {
          await tx.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.audit.batchRollback(tx, auditMark);
          if (error instanceof DomainError) {
            results.push({
              op_id: operation.op_id,
              status: 'rejected',
              version: null,
              duplicate: false,
              merged_entry: null,
              resolution: null,
              conflicts: null,
              error: {
                code: error.code,
                message: error.message,
                ...(error.fields ? { fields: error.fields } : {}),
              },
            });
          } else {
            results.push({
              op_id: operation.op_id,
              status: 'rejected',
              version: null,
              duplicate: false,
              merged_entry: null,
              resolution: null,
              conflicts: null,
              error: {
                code: 'E-SRV-01',
                message: 'Не удалось применить операцию',
              },
            });
          }
        }
      }

      if (successful.length > 0) {
        await tx.query(
          `insert into idempotency_records (op_id, user_id, device_id, response)
           select x.op_id, $2::uuid, $3::uuid, x.response
             from jsonb_to_recordset($1::jsonb) as x(op_id uuid, response jsonb)
           on conflict (op_id) do nothing`,
          [
            JSON.stringify(
              successful.map((item) => ({
                op_id: item.opId,
                response: item.result,
              })),
            ),
            actor.id,
            body.device_id,
          ],
        );
      }

      // Hash-chain outbox segment is written in the SAME transaction as the
      // business change; delivery to audit_events is crash-safe.
      auditInputs = this.audit.takeBatch(tx);
      await this.audit.writeOutbox(tx, auditInputs);
      return results;
    });

    this.maybeTouchDevice(body.device_id, body.app_version);
    return { server_time: new Date().toISOString(), results };
  }

  private readonly deviceTouches = new Map<string, number>();

  private maybeTouchDevice(deviceId: string, appVersion: string): void {
    const now = Date.now();
    const last = this.deviceTouches.get(deviceId) ?? 0;
    if (now - last < 30_000) {
      return;
    }
    this.deviceTouches.set(deviceId, now);
    void this.db
      .query(
        'update devices set last_seen_at = now(), app_version = $1 where id = $2',
        [appVersion, deviceId],
      )
      .catch(() => undefined);
  }

  /**
   * Bulk path for a batch of entry creates. It replaces ~150 per-op queries
   * (and per-op savepoints) with one INSERT for entries, one for change_log,
   * one for idempotency and the batched audit flush. Any anomaly falls back to
   * the per-op savepoint path.
   */
  private async tryBulkCreate(
    tx: SqlClient,
    actor: AuthUser,
    deviceId: string,
    ops: SyncPushOp[],
    contexts: Map<
      number,
      {
        journal: JournalRow;
        journalSeq: number;
        payload: Record<string, unknown>;
        clocks: Record<string, string>;
      }
    >,
    knownResults: Map<string, SyncPushResult>,
    meta: RequestMeta,
  ): Promise<SyncPushResult[] | null> {
    if (ops.length < 2) {
      return null;
    }
    const seen = new Set<string>();
    for (let index = 0; index < ops.length; index += 1) {
      const operation = ops[index]!;
      if (
        operation.entity_type !== 'entry' ||
        operation.op_type !== 'create' ||
        knownResults.has(operation.op_id) ||
        !contexts.has(index) ||
        seen.has(operation.entity_id)
      ) {
        return null;
      }
      seen.add(operation.entity_id);
      const payload = contexts.get(index)!.payload;
      // Grounding and permit-linked entries have side effects/policy checks.
      if (payload.event_type === 'grounding' || payload.permit_id || payload.site_name_raw) {
        return null;
      }
    }

    const now = new Date().toISOString();
    const records = ops.map((operation, index) => {
      const context = contexts.get(index)!;
      const payload = context.payload;
      return {
        id: operation.entity_id,
        author_id: actor.id,
        performed_at: payload.performed_at,
        performed_tz_offset_min: payload.performed_tz_offset_min,
        performed_at_source: payload.performed_at_source ?? 'device_auto',
        performed_at_reason_id: payload.performed_at_reason_id ?? null,
        performed_at_comment: payload.performed_at_comment ?? null,
        shift_date: payload.shift_date ?? null,
        work_type_id: payload.work_type_id,
        site_id: payload.site_id ?? null,
        permit_id: null,
        permit_number_raw: null,
        permit_binding_status: 'not_required',
        permit_status_at_sync: null,
        permit_risk_flag: false,
        permit_risk_reason: null,
        text: payload.text,
        comment: payload.comment ?? null,
        input_method: payload.input_method,
        asr_engine: payload.asr_engine ?? null,
        asr_confidence: payload.asr_confidence ?? null,
        offline_created: payload.offline_created ?? false,
        status: 'active',
        version: 1,
        hlc: operation.hlc,
        field_clocks: JSON.stringify(context.clocks),
        created_at_client: operation.client_time,
        created_at_server: now,
        updated_at_client: operation.client_time,
        updated_at_server: now,
        device_id: deviceId,
        revision_no: 0,
        last_op_id: operation.op_id,
        event_type: payload.event_type,
        event_data: payload.event_data ?? null,
        late_entry: payload.late_entry ?? false,
        journal_id: context.journal.id,
        journal_seq: context.journalSeq,
        site_name_raw: null,
        site_binding_status: payload.site_id ? 'linked' : 'not_required',
      };
    });

    const auditMark = this.audit.batchMark(tx);
    await tx.exec('SAVEPOINT push_bulk');
    try {
      const inserted = await tx.query<EntryRow>(
        `insert into journal_entries
           (id, author_id, performed_at, performed_tz_offset_min, performed_at_source,
            performed_at_reason_id, performed_at_comment, shift_date, work_type_id, site_id,
            permit_id, permit_number_raw, permit_binding_status, permit_status_at_sync,
            permit_risk_flag, permit_risk_reason, "text", comment, input_method, asr_engine,
            asr_confidence, offline_created, status, version, hlc, field_clocks,
            created_at_client, created_at_server, updated_at_client, updated_at_server,
            device_id, revision_no, last_op_id, event_type, event_data, late_entry,
            journal_id, journal_seq, site_name_raw, site_binding_status)
         select x.id, x.author_id, x.performed_at, x.performed_tz_offset_min,
                x.performed_at_source, x.performed_at_reason_id, x.performed_at_comment,
                x.shift_date, x.work_type_id, x.site_id, x.permit_id,
                x.permit_number_raw, x.permit_binding_status, x.permit_status_at_sync,
                x.permit_risk_flag, x.permit_risk_reason, x."text", x.comment,
                x.input_method, x.asr_engine, x.asr_confidence, x.offline_created,
                x.status, x.version, x.hlc, x.field_clocks, x.created_at_client,
                x.created_at_server, x.updated_at_client, x.updated_at_server,
                x.device_id, x.revision_no, x.last_op_id, x.event_type, x.event_data,
                x.late_entry, x.journal_id, x.journal_seq,
                x.site_name_raw, x.site_binding_status
           from jsonb_to_recordset($1::jsonb) as x(
                id uuid, author_id uuid, performed_at timestamptz,
                performed_tz_offset_min integer,
                performed_at_source performed_source_enum,
                performed_at_reason_id uuid, performed_at_comment text,
                shift_date date, work_type_id uuid, site_id uuid, permit_id uuid,
                permit_number_raw text, permit_binding_status binding_status_enum,
                permit_status_at_sync permit_status_enum, permit_risk_flag boolean,
                permit_risk_reason text, "text" text, comment text,
                input_method input_method_enum, asr_engine asr_engine_enum,
                asr_confidence numeric, offline_created boolean,
                status entry_status_enum, version integer, hlc text,
                field_clocks jsonb, created_at_client timestamptz,
                created_at_server timestamptz, updated_at_client timestamptz,
                updated_at_server timestamptz, device_id uuid, revision_no integer,
                last_op_id uuid, event_type journal_event_type_enum,
                event_data jsonb, late_entry boolean, journal_id uuid,
                journal_seq bigint, site_name_raw text,
                site_binding_status binding_status_enum)
         returning *`,
        [JSON.stringify(records)],
      );
      if (inserted.rows.length !== ops.length) {
        throw new Error('bulk insert row count mismatch');
      }
      const byId = new Map(inserted.rows.map((row) => [row.id as string, row]));
      const results: SyncPushResult[] = [];
      for (let index = 0; index < ops.length; index += 1) {
        const operation = ops[index]!;
        const entry = byId.get(operation.entity_id);
        if (!entry) {
          throw new Error('bulk insert missing entry');
        }
        const result = this.result(operation.op_id, 'applied', entry, null, null);
        results.push(result);
        await this.audit.record(tx, {
          actorId: actor.id,
          actorRole: actor.role,
          action: 'entry.create',
          entityType: 'entry',
          entityId: entry.id,
          after: this.mapEntry(entry),
          source: 'client',
          deviceId,
          ...meta,
        });
      }

      const ids = ops.map((operation) => operation.entity_id);
      await tx.query(
        `insert into change_log (entity_type, entity_id, op, version, actor_id)
         select 'entry', id, 'upsert', 1, $2::uuid
           from unnest($1::uuid[]) as id`,
        [ids, actor.id],
      );
      await tx.query(
        `insert into idempotency_records (op_id, user_id, device_id, response)
         select x.op_id, $2::uuid, $3::uuid, x.response
           from jsonb_to_recordset($1::jsonb) as x(op_id uuid, response jsonb)
         on conflict (op_id) do nothing`,
        [
          JSON.stringify(
            ops.map((operation, index) => ({
              op_id: operation.op_id,
              response: results[index],
            })),
          ),
          actor.id,
          deviceId,
        ],
      );
      return results;
    } catch {
      await tx.exec('ROLLBACK TO SAVEPOINT push_bulk');
      this.audit.batchRollback(tx, auditMark);
      return null;
    }
  }

  /**
   * Assigns final positive journal_seq values from journal_counters at the end
   * of the business transaction. Because the counter update is transactional,
   * a full rollback restores it and the journal stays gapless.
   */
  private async assignJournalSeqTx(
    tx: SqlClient,
    entries: Array<{
      id: string;
      journal_id?: string;
      journalId?: string;
      opId?: string;
    }>,
  ): Promise<Map<string, number>> {
    const byJournal = new Map<string, string[]>();
    for (const entry of entries) {
      const journalId = entry.journal_id ?? entry.journalId;
      if (!journalId) {
        continue;
      }
      const list = byJournal.get(journalId) ?? [];
      list.push(entry.id);
      byJournal.set(journalId, list);
    }

    const result = new Map<string, number>();
    for (const [journalId, ids] of byJournal) {
      const updated = await tx.query<{ id: string; journal_seq: string }>(
        `with reserved as (
           update journal_counters
              set last_seq = last_seq + $2,
                  updated_at = now()
            where journal_id = $1
            returning last_seq
         ), numbered as (
           select id, row_number() over (order by id) as rn
             from journal_entries
            where id = any($3::uuid[])
         ), upd as (
           update journal_entries e
              set journal_seq = reserved.last_seq - $2 + numbered.rn
             from reserved, numbered
            where e.id = numbered.id
            returning e.id, e.journal_seq::text as journal_seq
         )
         select * from upd`,
        [journalId, ids.length, ids],
      );
      for (const row of updated.rows) {
        result.set(row.id, Number(row.journal_seq));
      }
    }

    // Keep idempotent replay and the audit outbox in sync with final numbers.
    const withOps = entries.filter(
      (entry) => entry.opId && result.has(entry.id),
    );
    if (withOps.length > 0) {
      const values: unknown[] = [];
      const placeholders: string[] = [];
      for (const entry of withOps) {
        const base = values.length;
        values.push(entry.opId, result.get(entry.id));
        placeholders.push(`($${base + 1}::uuid, $${base + 2}::bigint)`);
      }
      await tx.query(
        `update idempotency_records i
            set response = jsonb_set(
                  i.response, '{merged_entry,journal_seq}', to_jsonb(v.seq))
           from (values ${placeholders.join(', ')}) as v(op_id, seq)
          where i.op_id = v.op_id`,
        values,
      );

      const auditValues: unknown[] = [];
      const auditPlaceholders: string[] = [];
      for (const entry of withOps) {
        const base = auditValues.length;
        auditValues.push(entry.id, result.get(entry.id));
        auditPlaceholders.push(`($${base + 1}::uuid, $${base + 2}::bigint)`);
      }
      await tx.query(
        `update audit_outbox o
            set after = jsonb_set(o.after, '{journal_seq}', to_jsonb(v.seq))
           from (values ${auditPlaceholders.join(', ')}) as v(entity_id, seq)
          where o.entity_id = v.entity_id and o.action = 'entry.create'`,
        auditValues,
      );
    }
    return result;
  }

  private seqQueue: SeqRef[] = [];
  private seqWaiters: Array<{
    ids: Set<string>;
    resolve: (map: Map<string, number>) => void;
  }> = [];
  private seqTimer: NodeJS.Timeout | undefined;
  private seqDraining = false;

  /**
   * Assigns final numbers AFTER the business commit in a short coalesced
   * transaction. A business rollback therefore never advances the counter;
   * entries keep negative temporary numbers until this step (and are repaired
   * on startup if the process dies in between).
   */
  private assignAfterCommit(refs: SeqRef[]): Promise<Map<string, number>> {
    return new Promise((resolve) => {
      this.seqQueue.push(...refs);
      this.seqWaiters.push({
        ids: new Set(refs.map((ref) => ref.id)),
        resolve,
      });
      if (!this.seqTimer) {
        this.seqTimer = setTimeout(() => {
          this.seqTimer = undefined;
          void this.drainSeq();
        }, 2);
      }
    });
  }

  private async drainSeq(): Promise<void> {
    if (this.seqDraining) {
      return;
    }
    this.seqDraining = true;
    const refs = this.seqQueue.splice(0);
    const waiters = this.seqWaiters;
    this.seqWaiters = [];
    try {
      const seqById = await this.db.transaction(async (tx) => {
        // This is a rebuildable post-commit step: negative journal_seq rows are
        // repaired on startup. Skipping its fsync removes the counter-lock
        // serialization while keeping business commits synchronous.
        await tx.exec('set local synchronous_commit = off');
        return this.assignJournalSeqTx(tx, refs);
      });
      for (const waiter of waiters) {
        waiter.resolve(seqById);
      }
    } catch (error) {
      console.error(
        'journal_seq assignment failed',
        error instanceof Error ? error.message : error,
      );
      for (const waiter of waiters) {
        waiter.resolve(new Map());
      }
    } finally {
      this.seqDraining = false;
      if (this.seqQueue.length > 0 && !this.seqTimer) {
        this.seqTimer = setTimeout(() => {
          this.seqTimer = undefined;
          void this.drainSeq();
        }, 2);
      }
    }
  }

  /** Legacy/manual repair helper; sequence-based batches do not use it. */
  private async repairLegacyJournalSeq(): Promise<void> {
    try {
      for (;;) {
        const pending = await this.db.query<{
          id: string;
          journal_id: string;
          last_op_id: string | null;
        }>(
          `select id, journal_id, last_op_id
             from journal_entries
            where journal_seq < 0
            order by created_at_client asc
            limit 500`,
        );
        if (pending.rows.length === 0) {
          return;
        }
        await this.db.transaction(async (tx) => {
          await tx.exec('set local synchronous_commit = off');
          return this.assignJournalSeqTx(
            tx,
            pending.rows.map((row) => ({
              id: row.id,
              journalId: row.journal_id,
              opId: row.last_op_id ?? undefined,
            })),
          );
        });
      }
    } catch (error) {
      console.error(
        'journal_seq recovery failed',
        error instanceof Error ? error.message : error,
      );
    }
  }

  private async prepareCreateContexts(
    actor: AuthUser,
    ops: SyncPushOp[],
    cached: Map<string, SyncPushResult>,
  ): Promise<
    Map<
      number,
      {
        journal: JournalRow;
        journalSeq: number;
        payload: Record<string, unknown>;
        clocks: Record<string, string>;
      }
    >
  > {
    interface Candidate {
      index: number;
      journal: JournalRow;
      payload: Record<string, unknown>;
      clocks: Record<string, string>;
    }
    const contexts = new Map<
      number,
      {
        journal: JournalRow;
        journalSeq: number;
        payload: Record<string, unknown>;
        clocks: Record<string, string>;
      }
    >();
    const journalCache = new Map<string, JournalRow>();
    const candidates: Candidate[] = [];
    const seen = new Set<string>();

    for (let index = 0; index < ops.length; index += 1) {
      const operation = ops[index]!;
      if (
        operation.entity_type !== 'entry' ||
        operation.op_type !== 'create' ||
        cached.has(operation.op_id)
      ) {
        continue;
      }
      const parsed = entryPayloadSchema.safeParse(operation.payload);
      if (!parsed.success || seen.has(operation.entity_id)) {
        continue;
      }
      seen.add(operation.entity_id);
      const payload = { ...parsed.data };
      if (!payload.event_type) {
        payload.event_type = 'work';
      }
      const requested = payload.journal_id ?? null;
      const cacheKey = requested ?? '__default__';
      let journal = journalCache.get(cacheKey);
      if (!journal) {
        try {
          journal = await this.journals.resolveForEntry(actor, requested);
        } catch (error) {
          if (error instanceof DomainError) {
            continue;
          }
          throw error;
        }
        journalCache.set(cacheKey, journal);
        journalCache.set(journal.id, journal);
      }
      const clocks: Record<string, string> = {};
      for (const field of MERGEABLE_FIELDS) {
        if (field in payload) {
          clocks[field] = operation.field_clocks?.[field] ?? operation.hlc;
        }
      }
      candidates.push({ index, journal, payload, clocks });
    }

    if (candidates.length === 0) {
      return contexts;
    }

    // Existing ids cannot be created again; they will be rejected in their
    // savepoint without consuming sequence numbers.
    const ids = candidates.map((_, index) => ops[candidates[index]!.index]!.entity_id);
    const existing = await this.db.query<{ id: string }>(
      'select id from journal_entries where id = any($1::uuid[])',
      [ids],
    );
    const existingIds = new Set(existing.rows.map((row) => row.id));
    const fresh = candidates.filter(
      (candidate) => !existingIds.has(ops[candidate.index]!.entity_id),
    );

    const counts = new Map<string, number>();
    for (const candidate of fresh) {
      counts.set(candidate.journal.id, (counts.get(candidate.journal.id) ?? 0) + 1);
    }
    if (counts.size === 0) {
      return contexts;
    }

    // Block allocation from the per-journal sequence: one roundtrip per
    // journal, numbers handed out in memory. A fully rolled-back batch can
    // leave gaps (explicit policy, migration 0016); duplicates are impossible.
    const nextByJournal = new Map<string, number>();
    for (const [journalId, count] of counts) {
      const sequenceName = journalSeqSequenceName(journalId);
      const exists = await this.db.query<{ name: string | null }>(
        'select to_regclass($1)::text as name',
        [sequenceName],
      );
      if (!exists.rows[0]?.name) {
        const max = await this.db.query<{ max: string }>(
          'select coalesce(max(journal_seq), 0)::text as max from journal_entries where journal_id = $1',
          [journalId],
        );
        await ensureJournalSequence(
          this.db,
          journalId,
          Number(max.rows[0]?.max ?? 0) + 1,
        );
      }
      const reserved = await this.db.query<{ seq: string }>(
        `select nextval($1::regclass)::text as seq
           from generate_series(1, $2)`,
        [sequenceName, count],
      );
      nextByJournal.set(journalId, Number(reserved.rows[0]?.seq ?? 1));
    }

    fresh.forEach((candidate) => {
      const next = nextByJournal.get(candidate.journal.id);
      if (next === undefined) {
        return;
      }
      contexts.set(candidate.index, {
        journal: candidate.journal,
        journalSeq: next,
        payload: candidate.payload,
        clocks: candidate.clocks,
      });
      nextByJournal.set(candidate.journal.id, next + 1);
    });
    return contexts;
  }

  async changes(
    actor: AuthUser,
    sinceSeq: number,
    limit: number,
  ): Promise<{
    next_seq: number;
    has_more: boolean;
    changes: Array<Record<string, unknown>>;
  }> {
    // ADR-07: change_log has a 90-day TTL. A client whose cursor predates the
    // oldest retained row must do a full resync instead of silently missing
    // changes.
    if (sinceSeq > 0) {
      const oldest = await this.db.query<{ min_seq: string | null }>(
        'select min(seq)::text as min_seq from change_log',
      );
      const minSeq = Number(oldest.rows[0]?.min_seq ?? 0);
      if (minSeq > 0 && sinceSeq < minSeq - 1) {
        throw new DomainError(
          'E-CURSOR-01',
          'Курсор синхронизации старше хранимого change_log; требуется полная пересинхронизация',
        );
      }
    }

    const entryParams: unknown[] = [sinceSeq];
    let entryScope = 'true';

    if (actor.role === 'worker' || actor.role === 'supervisor') {
      // Do not stream changes from journals the actor cannot read (JRN-03).
      const mainParam = entryParams.push(DEFAULT_JOURNAL_ID);
      const journalMemberParam = entryParams.push(actor.id);
      entryScope = `(e.journal_id = $${mainParam}::uuid or exists (
        select 1 from journal_members jm
         where jm.journal_id = e.journal_id and jm.user_id = $${journalMemberParam}::uuid
      ))`;
    }

    if (actor.role === 'worker') {
      entryScope += ` and e.author_id = $${entryParams.push(actor.id)}::uuid`;
    } else if (actor.role === 'supervisor') {
      const departmentParam = entryParams.push(actor.departmentId);
      entryScope += ` and e.author_id in (
        with recursive dept as (
          select id from departments where id = $${departmentParam}::uuid
          union all
          select d.id from departments d join dept on d.parent_id = dept.id
        )
        select u.id from users u where u.department_id in (select id from dept)
      )`;
    }

    const entryLimitParam = entryParams.push(limit);
    const entries = await this.db.query<EntryRow & { seq: string; op: string; changed_at: string }>(
      `select cl.seq::text as seq, cl.op, cl.version, cl.changed_at, e.*
         from change_log cl
         join journal_entries e on e.id = cl.entity_id
        where cl.entity_type = 'entry'
          and cl.seq > $1
          and ${entryScope}
        order by cl.seq asc
        limit $${entryLimitParam}`,
      entryParams,
    );

    const permitParams: unknown[] = [sinceSeq, limit];
    let permitVisibility = '';
    if (
      loadEnv().PERMIT_VISIBILITY_MODE === 'participant' &&
      actor.role === 'worker'
    ) {
      permitParams.push(actor.id);
      permitVisibility = `and p.id in (
        select pp.permit_id from permit_participants pp where pp.user_id = $3::uuid
      )`;
    }
    const permits = await this.db.query<Record<string, unknown> & { seq: string; op: string; changed_at: string }>(
      `select cl.seq::text as seq, cl.op, cl.version, cl.changed_at, p.*
         from change_log cl
         join permits p on p.id = cl.entity_id
        where cl.entity_type = 'permit'
          and cl.seq > $1
          and p.is_deleted = false
          ${permitVisibility}
        order by cl.seq asc
        limit $2`,
      permitParams,
    );

    // JRN-02: shift handover/acceptance travels through the same outbox.
    const shiftParams: unknown[] = [sinceSeq];
    let shiftVisibility = 'true';
    if (actor.role === 'worker') {
      const userParam = shiftParams.push(actor.id);
      shiftVisibility = `(s.handed_over_by = $${userParam}::uuid or s.accepted_by = $${userParam}::uuid)`;
    } else if (actor.role === 'supervisor') {
      const mainParam = shiftParams.push('main');
      const memberParam = shiftParams.push(actor.id);
      shiftVisibility = `exists (
        select 1 from journals j
         where j.id = s.journal_id
           and (j.journal_key = $${mainParam} or exists (
             select 1 from journal_members jm
              where jm.journal_id = j.id and jm.user_id = $${memberParam}::uuid
           ))
      )`;
    }
    const shiftLimitParam = shiftParams.push(limit);
    const shifts = await this.db.query<ShiftRow & { seq: string; op: string; changed_at: string }>(
      `select cl.seq::text as seq, cl.op, cl.version, cl.changed_at,
              s.*, hu.full_name as handed_over_by_name,
              au.full_name as accepted_by_name,
              ru.full_name as rejected_by_name
         from change_log cl
         join shifts s on s.id = cl.entity_id
         join users hu on hu.id = s.handed_over_by
         left join users au on au.id = s.accepted_by
         left join users ru on ru.id = s.rejected_by
        where cl.entity_type = 'shift'
          and cl.seq > $1
          and ${shiftVisibility}
        order by cl.seq asc
        limit $${shiftLimitParam}`,
      shiftParams,
    );

    // JRN-06: grounding registry changes follow the same journal visibility.
    const groundingParams: unknown[] = [sinceSeq];
    let groundingVisibility = 'true';
    if (actor.role === 'worker' || actor.role === 'supervisor') {
      const mainParam = groundingParams.push('main');
      const memberParam = groundingParams.push(actor.id);
      groundingVisibility = `exists (
        select 1 from journals j
         where j.id = g.journal_id
           and (j.journal_key = $${mainParam} or exists (
             select 1 from journal_members jm
              where jm.journal_id = j.id and jm.user_id = $${memberParam}::uuid
           ))
      )`;
    }
    const groundingLimitParam = groundingParams.push(limit);
    const groundings = await this.db.query<GroundingRow & { seq: string; op: string; changed_at: string }>(
      `select cl.seq::text as seq, cl.op, cl.version, cl.changed_at,
              g.*, au.full_name as applied_by_name,
              ru.full_name as removed_by_name,
              s.name as site_name
         from change_log cl
         join groundings g on g.id = cl.entity_id
         left join users au on au.id = g.applied_by
         left join users ru on ru.id = g.removed_by
         left join sites s on s.id = g.site_id
        where cl.entity_type = 'grounding'
          and cl.seq > $1
          and ${groundingVisibility}
        order by cl.seq asc
        limit $${groundingLimitParam}`,
      groundingParams,
    );

    const combined = [
      ...entries.rows.map((row) => ({ row, type: 'entry' as const })),
      ...permits.rows.map((row) => ({ row, type: 'permit' as const })),
      ...shifts.rows.map((row) => ({ row, type: 'shift' as const })),
      ...groundings.rows.map((row) => ({ row, type: 'grounding' as const })),
    ].sort((left, right) => Number(left.row.seq) - Number(right.row.seq));

    const hasMore =
      combined.length > limit ||
      entries.rows.length === limit ||
      permits.rows.length === limit ||
      shifts.rows.length === limit ||
      groundings.rows.length === limit;
    const page = hasMore ? combined.slice(0, limit) : combined;

    const changes = page.map(({ row, type }) => {
      if (row.op === 'delete') {
        return {
          seq: Number(row.seq),
          entity_type: type,
          op: 'delete',
          entity_id: row.id,
          version: Number(row.version ?? 0),
          deleted_at: row.deleted_at ?? row.changed_at,
        };
      }
      return {
        seq: Number(row.seq),
        entity_type: type,
        op: 'upsert',
        entity:
          type === 'entry'
            ? this.mapEntry(row as EntryRow)
            : type === 'shift'
              ? this.shifts.mapShift(row as ShiftRow)
              : type === 'grounding'
                ? this.groundings.mapGrounding(row as GroundingRow)
                : row,
      };
    });

    const last = page[page.length - 1];
    return {
      next_seq: last ? Number(last.row.seq) : sinceSeq,
      has_more: hasMore,
      changes,
    };
  }

  private async applyOperation(
    tx: SqlClient,
    actor: AuthUser,
    deviceId: string,
    operation: SyncPushOp,
    meta: RequestMeta,
    prepared?: {
      journal: JournalRow;
      journalSeq: number;
      payload: Record<string, unknown>;
      clocks: Record<string, string>;
    },
  ): Promise<SyncPushResult> {
    if (operation.entity_type === 'shift') {
      return this.shifts.applySyncOperation(tx, actor, deviceId, operation, meta);
    }
    switch (operation.op_type) {
      case 'create':
        return this.create(tx, actor, deviceId, operation, meta, prepared);
      case 'update':
        return this.update(tx, actor, operation, meta);
      case 'delete':
        return this.remove(tx, actor, operation, meta);
      default:
        throw new DomainError('E-VAL-01', 'Неизвестный тип операции');
    }
  }

  private async resolveSite(
    tx: SqlClient,
    payload: Record<string, unknown>,
  ): Promise<{ siteId: string | null; status: string }> {
    const explicit = (payload.site_id as string | null | undefined) ?? null;
    if (explicit) {
      payload.site_id = explicit;
      payload.site_binding_status = 'linked';
      return { siteId: explicit, status: 'linked' };
    }
    const raw =
      typeof payload.site_name_raw === 'string'
        ? payload.site_name_raw.trim()
        : '';
    if (!raw) {
      payload.site_id = null;
      payload.site_binding_status = 'not_required';
      return { siteId: null, status: 'not_required' };
    }
    const target = normalizeSiteName(raw);
    const sites = await tx.query<{ id: string; name: string }>(
      'select id, name from sites where active = true',
    );
    const match =
      sites.rows.find((site) => normalizeSiteName(site.name) === target) ?? null;
    payload.site_name_raw = raw;
    payload.site_id = match?.id ?? null;
    payload.site_binding_status = match ? 'linked' : 'not_found';
    return { siteId: match?.id ?? null, status: match ? 'linked' : 'not_found' };
  }

  private async create(
    tx: SqlClient,
    actor: AuthUser,
    deviceId: string,
    operation: SyncPushOp,
    meta: RequestMeta,
    prepared?: {
      journal: JournalRow;
      journalSeq: number;
      payload: Record<string, unknown>;
      clocks: Record<string, string>;
    },
  ): Promise<SyncPushResult> {
    const parsed = entryPayloadSchema.safeParse(operation.payload);
    if (!parsed.success) {
      throw this.validationError(parsed.error.issues);
    }
    const payload = (
      prepared ? { ...prepared.payload } : { ...parsed.data }
    ) as Record<string, any>;
    if (!payload.event_type) {
      payload.event_type = 'work';
    }

    if (!prepared) {
      const existing = await tx.query('select id, version from journal_entries where id = $1', [
        operation.entity_id,
      ]);
      if (existing.rows[0]) {
        throw new DomainError('E-VER-01', 'Запись с таким идентификатором уже существует');
      }
    }

    // JRN-03: the entry belongs to exactly one journal; old payloads without
    // journal_id fall back to the default `main` journal. Batch push passes a
    // pre-resolved journal and a reserved journal_seq.
    const journal =
      prepared?.journal ??
      (await this.journals.resolveForEntry(actor, payload.journal_id ?? null, tx));

    const now = new Date().toISOString();
    const clocks: Record<string, string> = prepared
      ? { ...prepared.clocks }
      : {};
    if (!prepared) {
      for (const field of MERGEABLE_FIELDS) {
        if (field in payload) {
          clocks[field] = operation.field_clocks?.[field] ?? operation.hlc;
        }
      }
    }

    await this.resolveSite(tx, payload);
    const permitStatus = await this.loadPermitStatus(tx, payload.permit_id ?? null);
    const permitAnnulled = permitStatus === 'annulled';
    if (permitAnnulled) {
      payload.permit_status_at_sync = 'annulled';
      payload.permit_risk_flag = true;
      payload.permit_risk_reason =
        payload.permit_risk_reason ?? 'Наряд аннулирован после офлайн-записи';
      clocks.permit_status_at_sync = operation.hlc;
      clocks.permit_risk_flag = operation.hlc;
      clocks.permit_risk_reason = operation.hlc;
    }

    const inserted = await tx.query<EntryRow>(
      `insert into journal_entries
         (id, author_id, performed_at, performed_tz_offset_min, performed_at_source,
          performed_at_reason_id, performed_at_comment, shift_date, work_type_id, site_id,
          permit_id, permit_number_raw, permit_binding_status, permit_status_at_sync,
          permit_risk_flag, permit_risk_reason, "text", comment, input_method, asr_engine,
          asr_confidence, offline_created, status, version, hlc, field_clocks,
          created_at_client, created_at_server, updated_at_client, updated_at_server,
          device_id, revision_no, last_op_id, event_type, event_data, late_entry,
          journal_id, journal_seq, site_name_raw, site_binding_status)
       values
         ($1, $2, $3, $4, $5::performed_source_enum, $6, $7, $8, $9, $10,
          $11, $12, $13::binding_status_enum, $14::permit_status_enum,
          $15, $16, $17, $18, $19::input_method_enum, $20::asr_engine_enum,
          $21, $22, 'active'::entry_status_enum, 1, $23, $24::jsonb,
          $25, $26, $27, $26, $28, 0, $29,
          $30::journal_event_type_enum, $31::jsonb, $32, $33::uuid, $34,
          $35, $36::binding_status_enum)
       returning *`,
      [
        operation.entity_id,
        actor.id,
        payload.performed_at,
        payload.performed_tz_offset_min,
        payload.performed_at_source ?? 'device_auto',
        payload.performed_at_reason_id ?? null,
        payload.performed_at_comment ?? null,
        payload.shift_date ?? null,
        payload.work_type_id,
        payload.site_id ?? null,
        payload.permit_id ?? null,
        payload.permit_number_raw ?? null,
        payload.permit_binding_status ??
          (payload.permit_id ? 'linked' : 'not_required'),
        payload.permit_status_at_sync ?? null,
        payload.permit_risk_flag ?? false,
        payload.permit_risk_reason ?? null,
        payload.text,
        payload.comment ?? null,
        payload.input_method,
        payload.asr_engine ?? null,
        payload.asr_confidence ?? null,
        payload.offline_created ?? false,
        operation.hlc,
        JSON.stringify(clocks),
        operation.client_time,
        now,
        operation.client_time,
        deviceId,
        operation.op_id,
        payload.event_type,
        payload.event_data ? JSON.stringify(payload.event_data) : null,
        payload.late_entry ?? false,
        journal.id,
        prepared?.journalSeq ?? null,
        payload.site_name_raw ?? null,
        payload.site_binding_status ?? 'not_required',
      ],
    );

    const entry = inserted.rows[0]!;
    await appendChange(tx, {
      entityType: 'entry',
      entityId: entry.id,
      op: 'upsert',
      version: 1,
      actorId: actor.id,
    });
    await this.audit.record(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'entry.create',
      entityType: 'entry',
      entityId: entry.id,
      after: this.mapEntry(entry),
      source: 'client',
      deviceId,
      ...meta,
    });

    // JRN-06: grounding events drive the grounding registry. The journal entry
    // is always saved; a repeated apply/remove is surfaced as a conflict.
    let groundingConflict: string | null = null;
    if (payload.event_type === 'grounding' && payload.event_data) {
      const groundingResult = await this.groundings.applyEntryEvent(
        tx,
        actor,
        {
          id: entry.id,
          journal_id: journal.id,
          site_id: (entry.site_id as string | null) ?? null,
          author_id: actor.id,
          performed_at: new Date(
            entry.performed_at as string | Date,
          ).toISOString(),
          event_data: payload.event_data as unknown as GroundingEventData,
        },
        meta,
        deviceId,
      );
      groundingConflict = groundingResult.conflict;
      if (groundingConflict) {
        await this.savePendingConflict(tx, entry.id, {
          field: 'grounding_state',
          localValue: (payload.event_data as unknown as GroundingEventData).action,
          remoteValue: groundingConflict,
          localHlc: operation.hlc,
          remoteHlc: operation.hlc,
        });
      }
    }

    if (permitAnnulled) {
      await this.savePendingConflict(tx, entry.id, {
        field: 'permit_status_at_sync',
        localValue: operation.payload.permit_status_at_sync ?? null,
        remoteValue: 'annulled',
        localHlc: operation.hlc,
        remoteHlc: operation.hlc,
      });
      await this.audit.record(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'entry.permit_annulled',
        entityType: 'entry',
        entityId: entry.id,
        after: { permit_status_at_sync: 'annulled' },
        source: 'server',
        ...meta,
      });
      return this.result(
        operation.op_id,
        'conflict',
        entry,
        { permit_status_at_sync: 'manual' },
        [
          {
            field: 'permit_status_at_sync',
            reason: 'permit_annulled_after_offline',
            local_hlc: operation.hlc,
            remote_hlc: operation.hlc,
          },
        ],
      );
    }

    if (groundingConflict) {
      return this.result(
        operation.op_id,
        'conflict',
        entry,
        { grounding_state: 'manual' },
        [
          {
            field: 'grounding_state',
            reason: groundingConflict,
            local_hlc: operation.hlc,
            remote_hlc: operation.hlc,
          },
        ],
      );
    }

    return this.result(operation.op_id, 'applied', entry, null, null);
  }

  private async update(
    tx: SqlClient,
    actor: AuthUser,
    operation: SyncPushOp,
    meta: RequestMeta,
  ): Promise<SyncPushResult> {
    if (operation.base_version === null) {
      throw new DomainError('E-VAL-01', 'base_version обязателен для update');
    }
    const parsed = entryUpdatePayloadSchema.safeParse(operation.payload);
    if (!parsed.success) {
      throw this.validationError(parsed.error.issues);
    }

    const entry = await this.loadEntry(tx, operation.entity_id, true);
    if (!entry) {
      throw new DomainError('E-NOT-01', 'Запись не найдена');
    }
    if (
      parsed.data.journal_id !== undefined &&
      parsed.data.journal_id !== entry.journal_id
    ) {
      // Journal membership and numbering are immutable; a move would silently
      // renumber the entry in two journals.
      throw new DomainError('E-VAL-01', 'Журнал записи изменить нельзя');
    }
    if (
      entry.event_type === 'grounding' &&
      ('event_type' in operation.payload || 'event_data' in operation.payload)
    ) {
      // The registry is derived from the grounding event; editing its action or
      // point would desynchronise the registry from the legal log.
      throw new DomainError(
        'E-VAL-01',
        'Событие заземления нельзя изменить: зафиксируйте новое событие',
      );
    }
    await this.assertCanEdit(tx, actor, entry);
    if (entry.status === 'deleted') {
      throw new DomainError('E-VER-01', 'Запись удалена');
    }

    const decision = decideMerge(entry, operation, actor);

    // C-09: an annulled permit does not block the entry, but requires review.
    const permitId: string | null = decision.applied.permit_id
      ? (decision.applied.permit_id.after as string | null)
      : ((entry.permit_id as string | null) ?? null);
    const permitStatus = await this.loadPermitStatus(tx, permitId);
    const permitAnnulled =
      permitStatus === 'annulled'
        ? this.applyPermitPolicy(entry, decision, operation)
        : false;

    if (Object.keys(decision.applied).length === 0) {
      const normalConflicts = decision.conflicts.filter(
        (conflict) => conflict.reason !== 'permit_annulled_after_offline',
      );
      await this.saveConflicts(tx, entry.id, normalConflicts);
      if (permitAnnulled) {
        await this.savePendingConflict(tx, entry.id, {
          field: 'permit_status_at_sync',
          localValue: entry.permit_status_at_sync,
          remoteValue: 'annulled',
          localHlc: operation.hlc,
          remoteHlc: entry.hlc,
        });
      }
      return {
        op_id: operation.op_id,
        status: decision.conflicts.length > 0 || decision.blocked ? 'conflict' : 'applied',
        version: entry.version,
        duplicate: false,
        merged_entry: this.mapEntry(entry) as never,
        resolution: this.resolutionOf(decision.conflicts),
        conflicts: decision.conflicts.map((conflict) => ({
          field: conflict.field,
          reason: conflict.reason,
          local_hlc: conflict.local_hlc,
          remote_hlc: conflict.remote_hlc,
        })),
        error: null,
      };
    }

    // C-10: validate the merged shape before applying it.
    const candidate = {
      ...entry,
      ...Object.fromEntries(
        Object.entries(decision.applied).map(([field, change]) => [
          field,
          change.after,
        ]),
      ),
    } as MergeableEntry;
    const siteResolution = await this.resolveSite(
      tx,
      candidate as Record<string, unknown>,
    );
    if (candidate.site_id !== siteResolution.siteId) {
      decision.applied.site_id = {
        before: entry.site_id ?? null,
        after: siteResolution.siteId,
      };
      decision.fieldClocks.site_id = operation.hlc;
      candidate.site_id = siteResolution.siteId;
    }
    if (candidate.site_binding_status !== siteResolution.status) {
      decision.applied.site_binding_status = {
        before: entry.site_binding_status ?? null,
        after: siteResolution.status,
      };
      decision.fieldClocks.site_binding_status = operation.hlc;
      candidate.site_binding_status = siteResolution.status;
    }
    const invalid = validateMergedEntry(candidate);
    if (invalid.length > 0) {
      const normalConflicts = decision.conflicts.filter(
        (conflict) => conflict.reason !== 'permit_annulled_after_offline',
      );
      await this.saveConflicts(tx, entry.id, normalConflicts);
      if (permitAnnulled) {
        await this.savePendingConflict(tx, entry.id, {
          field: 'permit_status_at_sync',
          localValue: entry.permit_status_at_sync,
          remoteValue: 'annulled',
          localHlc: operation.hlc,
          remoteHlc: entry.hlc,
        });
      }
      await this.savePendingConflict(tx, entry.id, {
        field: '_entity',
        localValue: Object.fromEntries(
          Object.entries(decision.applied).map(([field, change]) => [
            field,
            change.after,
          ]),
        ),
        remoteValue: this.mapEntry(entry),
        localHlc: operation.hlc,
        remoteHlc: entry.hlc,
      });
      return {
        op_id: operation.op_id,
        status: 'conflict',
        version: entry.version,
        duplicate: false,
        merged_entry: this.mapEntry(entry) as never,
        resolution: { _entity: 'remote' },
        conflicts: [
          ...normalConflicts.map((conflict) => ({
            field: conflict.field,
            reason: conflict.reason,
            local_hlc: conflict.local_hlc,
            remote_hlc: conflict.remote_hlc,
          })),
          {
            field: '_entity',
            reason: `invalid_merge:${invalid.join(',')}`,
            local_hlc: operation.hlc,
            remote_hlc: entry.hlc,
          },
        ],
        error: null,
      };
    }

    const now = new Date().toISOString();
    const nextVersion = Number(entry.version) + 1;
    const nextRevision = Number(entry.revision_no) + 1;
    const hlc = maxHlc([entry.hlc, operation.hlc]) ?? operation.hlc;

    const assignments: string[] = [];
    const params: unknown[] = [];
    for (const [field, change] of Object.entries(decision.applied)) {
      if (!(MERGEABLE_FIELDS as readonly string[]).includes(field)) {
        continue;
      }
      const column = field === 'text' ? '"text"' : field;
      if (field === 'event_type') {
        assignments.push(`${column} = $${params.push(change.after)}::journal_event_type_enum`);
      } else if (field === 'event_data') {
        assignments.push(
          `${column} = $${params.push(change.after === null ? null : JSON.stringify(change.after))}::jsonb`,
        );
      } else {
        assignments.push(`${column} = $${params.push(change.after)}`);
      }
    }
    assignments.push(`version = $${params.push(nextVersion)}`);
    assignments.push(`revision_no = $${params.push(nextRevision)}`);
    assignments.push(`hlc = $${params.push(hlc)}`);
    assignments.push(`field_clocks = $${params.push(JSON.stringify(decision.fieldClocks))}::jsonb`);
    assignments.push(`updated_at_client = $${params.push(operation.client_time)}`);
    assignments.push(`updated_at_server = $${params.push(now)}`);
    assignments.push(`last_op_id = $${params.push(operation.op_id)}`);
    params.push(operation.entity_id);

    const updated = await tx.query<EntryRow>(
      `update journal_entries set ${assignments.join(', ')} where id = $${params.length} returning *`,
      params,
    );
    const updatedEntry = updated.rows[0]!;

    await tx.query(
      `insert into entry_revisions
         (id, entry_id, revision_no, changed_by, changed_at, source, hlc,
          base_version, result_version, diff)
       values ($1, $2, $3, $4, $5, 'server'::revision_source_enum, $6, $7, $8, $9::jsonb)`,
      [
        uuidv7(),
        entry.id,
        nextRevision,
        actor.id,
        now,
        hlc,
        entry.version,
        nextVersion,
        JSON.stringify(decision.applied),
      ],
    );

    const normalConflicts = decision.conflicts.filter(
      (conflict) => conflict.reason !== 'permit_annulled_after_offline',
    );
    await this.saveConflicts(tx, entry.id, normalConflicts);
    if (permitAnnulled) {
      await this.savePendingConflict(tx, entry.id, {
        field: 'permit_status_at_sync',
        localValue: entry.permit_status_at_sync,
        remoteValue: 'annulled',
        localHlc: operation.hlc,
        remoteHlc: entry.hlc,
      });
      await this.audit.record(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'entry.permit_annulled',
        entityType: 'entry',
        entityId: entry.id,
        after: { permit_status_at_sync: 'annulled' },
        source: 'server',
        ...meta,
      });
    }
    await appendChange(tx, {
      entityType: 'entry',
      entityId: entry.id,
      op: 'upsert',
      version: nextVersion,
      actorId: actor.id,
    });
    await this.audit.record(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'entry.update',
      entityType: 'entry',
      entityId: entry.id,
      before: Object.fromEntries(
        Object.entries(decision.applied).map(([field, change]) => [field, change.before]),
      ),
      after: Object.fromEntries(
        Object.entries(decision.applied).map(([field, change]) => [field, change.after]),
      ),
      source: 'client',
      ...meta,
    });

    return this.result(
      operation.op_id,
      decision.conflicts.length > 0 ? 'conflict' : 'applied',
      updatedEntry,
      decision.conflicts.length > 0 ? this.resolutionOf(decision.conflicts) : null,
      decision.conflicts.map((conflict) => ({
        field: conflict.field,
        reason: conflict.reason,
        local_hlc: conflict.local_hlc,
        remote_hlc: conflict.remote_hlc,
      })),
    );
  }

  private async remove(
    tx: SqlClient,
    actor: AuthUser,
    operation: SyncPushOp,
    meta: RequestMeta,
  ): Promise<SyncPushResult> {
    const entry = await this.loadEntry(tx, operation.entity_id, true);
    if (!entry) {
      throw new DomainError('E-NOT-01', 'Запись не найдена');
    }
    await this.assertCanEdit(tx, actor, entry);

    if (entry.status === 'deleted') {
      throw new DomainError('E-VER-01', 'Запись уже удалена');
    }

    if (
      operation.base_version !== null &&
      Number(entry.version) !== operation.base_version &&
      operation.hlc < entry.hlc
    ) {
      return {
        op_id: operation.op_id,
        status: 'conflict',
        version: entry.version,
        duplicate: false,
        merged_entry: this.mapEntry(entry) as never,
        resolution: { status: 'remote' },
        conflicts: [
          {
            field: 'status',
            reason: 'newer_server_version',
            local_hlc: operation.hlc,
            remote_hlc: entry.hlc,
          },
        ],
        error: null,
      };
    }

    const now = new Date().toISOString();
    const nextVersion = Number(entry.version) + 1;
    const hlc = maxHlc([entry.hlc, operation.hlc]) ?? operation.hlc;
    const updated = await tx.query<EntryRow>(
      `update journal_entries
          set status = 'deleted'::entry_status_enum, deleted_at = $1, deleted_by = $2,
              version = $3, hlc = $4, updated_at_server = $1, last_op_id = $5
        where id = $6
        returning *`,
      [now, actor.id, nextVersion, hlc, operation.op_id, entry.id],
    );

    await appendChange(tx, {
      entityType: 'entry',
      entityId: entry.id,
      op: 'delete',
      version: nextVersion,
      actorId: actor.id,
    });
    await this.audit.record(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'entry.delete',
      entityType: 'entry',
      entityId: entry.id,
      before: { status: entry.status },
      after: { status: 'deleted' },
      source: 'client',
      ...meta,
    });

    return this.result(operation.op_id, 'applied', updated.rows[0]!, null, null);
  }

  private async loadEntry(tx: SqlClient, id: string, forUpdate = false): Promise<EntryRow | null> {
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

  private async assertCanEdit(tx: SqlClient, actor: AuthUser, entry: EntryRow): Promise<void> {
    if (actor.role === 'admin') {
      return;
    }
    if (entry.author_id === actor.id) {
      return;
    }
    if (actor.role === 'supervisor') {
      const allowed = await tx.query<{ ok: boolean }>(
        `with recursive ancestors as (
           select id, parent_id from departments where id = $1::uuid
           union all
           select d.id, d.parent_id from departments d join ancestors a on d.id = a.parent_id
         )
         select exists(select 1 from ancestors where id = $2::uuid) as ok`,
        [entry.author_department_id, actor.departmentId],
      );
      if (allowed.rows[0]?.ok) {
        return;
      }
    }
    throw new DomainError('E-AUTH-02', 'Недостаточно прав на изменение записи');
  }

  private async loadPermitStatus(
    tx: SqlClient,
    permitId: string | null,
  ): Promise<PermitStatus | null> {
    if (!permitId) {
      return null;
    }
    const result = await tx.query<{ status: PermitStatus }>(
      'select status from permits where id = $1',
      [permitId],
    );
    return result.rows[0]?.status ?? null;
  }

  /**
   * C-09: the entry is saved, but an annulled permit is surfaced as a risk
   * flag and a pending review conflict; it never blocks the write.
   */
  private applyPermitPolicy(
    entry: EntryRow,
    decision: MergeDecision,
    operation: SyncPushOp,
  ): boolean {
    if (
      entry.permit_status_at_sync === 'annulled' &&
      entry.permit_risk_flag === true
    ) {
      return false;
    }

    decision.applied.permit_status_at_sync = {
      before: entry.permit_status_at_sync,
      after: 'annulled',
    };
    decision.fieldClocks.permit_status_at_sync = operation.hlc;

    if (!entry.permit_risk_flag) {
      decision.applied.permit_risk_flag = {
        before: entry.permit_risk_flag,
        after: true,
      };
      decision.fieldClocks.permit_risk_flag = operation.hlc;
    }
    if (!entry.permit_risk_reason) {
      const reason =
        (decision.applied.permit_risk_reason?.after as string | undefined) ??
        'Наряд аннулирован после офлайн-записи';
      decision.applied.permit_risk_reason = {
        before: entry.permit_risk_reason,
        after: reason,
      };
      decision.fieldClocks.permit_risk_reason = operation.hlc;
    }

    decision.conflicts.push({
      field: 'permit_status_at_sync',
      local_value: entry.permit_status_at_sync,
      remote_value: 'annulled',
      local_hlc: entry.hlc,
      remote_hlc: operation.hlc,
      reason: 'permit_annulled_after_offline',
    });
    return true;
  }

  private async savePendingConflict(
    tx: SqlClient,
    entryId: string,
    conflict: {
      field: string;
      localValue: unknown;
      remoteValue: unknown;
      localHlc: string;
      remoteHlc: string;
    },
  ): Promise<void> {
    const existing = await tx.query<{ id: string }>(
      `select id from conflict_records
        where entry_id = $1 and field = $2 and resolution = 'pending'::conflict_resolution_enum
        limit 1`,
      [entryId, conflict.field],
    );
    if (existing.rows[0]) {
      return;
    }
    await tx.query(
      `insert into conflict_records
         (id, entry_id, field, local_value, remote_value, local_hlc, remote_hlc, resolution)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, 'pending'::conflict_resolution_enum)`,
      [
        uuidv7(),
        entryId,
        conflict.field,
        JSON.stringify(conflict.localValue ?? null),
        JSON.stringify(conflict.remoteValue ?? null),
        conflict.localHlc,
        conflict.remoteHlc,
      ],
    );
  }

  private async saveConflicts(
    tx: SqlClient,
    entryId: string,
    conflicts: Array<{
      field: string;
      local_value: unknown;
      remote_value: unknown;
      local_hlc: string;
      remote_hlc: string;
    }>,
  ): Promise<void> {
    for (const conflict of conflicts) {
      await tx.query(
        `insert into conflict_records
           (id, entry_id, field, local_value, remote_value, local_hlc, remote_hlc, resolution)
         values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, 'remote'::conflict_resolution_enum)`,
        [
          uuidv7(),
          entryId,
          conflict.field,
          JSON.stringify(conflict.local_value ?? null),
          JSON.stringify(conflict.remote_value ?? null),
          conflict.local_hlc,
          conflict.remote_hlc,
        ],
      );
    }
  }

  private resolutionOf(
    conflicts: Array<{ field: string }>,
  ): Record<string, 'local' | 'remote' | 'manual'> | null {
    if (conflicts.length === 0) {
      return null;
    }
    return Object.fromEntries(conflicts.map((conflict) => [conflict.field, 'remote']));
  }

  private result(
    opId: string,
    status: 'applied' | 'conflict',
    entry: EntryRow,
    resolution: Record<string, 'local' | 'remote' | 'manual'> | null,
    conflicts: SyncPushResult['conflicts'],
  ): SyncPushResult {
    return {
      op_id: opId,
      status,
      version: Number(entry.version),
      duplicate: false,
      merged_entry: this.mapEntry(entry) as never,
      resolution,
      conflicts,
      error: null,
    };
  }

  private validationError(issues: Array<{ path: PropertyKey[]; message: string }>): DomainError {
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

  private mapEntry(row: EntryRow): Record<string, unknown> {
    const { field_clocks: _clocks, ...rest } = row;
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
