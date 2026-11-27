import { Inject, Injectable } from '@nestjs/common';
import { DomainError, uuidv7, type GroundingEventData } from '@logbook/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestMeta } from '../common/types';
import { appendChange } from '../db/change-log';
import type { SqlClient } from '../db/sql-client';
import { DB } from '../db/tokens';
import { JournalsService } from '../journals/journals.service';

export interface GroundingRow extends Record<string, unknown> {
  id: string;
  journal_id: string;
  site_id: string | null;
  point: string;
  grounding_type: 'portable' | 'fixed';
  tool_number: string | null;
  count: number;
  state: 'applied' | 'removed';
  applied_entry_id: string | null;
  applied_by: string | null;
  applied_at: string | null;
  removed_entry_id: string | null;
  removed_by: string | null;
  removed_at: string | null;
  version: number;
  created_at_server?: string;
  updated_at_server?: string;
  applied_by_name?: string | null;
  removed_by_name?: string | null;
  site_name?: string | null;
}

export interface GroundingApplyResult {
  row: GroundingRow | null;
  conflict: string | null;
}

const GROUNDING_SELECT = `select g.*,
       au.full_name as applied_by_name,
       ru.full_name as removed_by_name,
       s.name as site_name
  from groundings g
  left join users au on au.id = g.applied_by
  left join users ru on ru.id = g.removed_by
  left join sites s on s.id = g.site_id`;

/**
 * Grounding registry (JRN-06). Derived from `grounding` journal events:
 * `applied` creates the active registry row, `removed` closes it. A repeated
 * application or a removal of a non-applied point is surfaced as a conflict;
 * the journal entry is still saved (legal log wins, conflict stays visible).
 */
@Injectable()
export class GroundingsService {
  constructor(
    @Inject(DB) private readonly db: SqlClient,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(JournalsService) private readonly journals: JournalsService,
  ) {}

  async list(
    actor: AuthUser,
    query: {
      journal_id?: string;
      state?: 'applied' | 'removed';
      site_id?: string;
      limit: number;
    },
  ): Promise<{ items: Array<Record<string, unknown>> }> {
    const conditions: string[] = ['true'];
    const params: unknown[] = [];

    if (query.journal_id) {
      await this.journals.assertAccess(actor, query.journal_id, 'read');
      conditions.push(`g.journal_id = $${params.push(query.journal_id)}::uuid`);
    } else if (actor.role !== 'admin' && actor.role !== 'auditor') {
      const accessible = await this.journals.list(actor);
      const ids = (accessible.items as Array<{ id: string }>).map((item) => item.id);
      if (ids.length === 0) {
        return { items: [] };
      }
      conditions.push(`g.journal_id = any($${params.push(ids)}::uuid[])`);
    }
    if (query.state) {
      conditions.push(`g.state = $${params.push(query.state)}::grounding_state_enum`);
    }
    if (query.site_id) {
      conditions.push(`g.site_id = $${params.push(query.site_id)}::uuid`);
    }

    const result = await this.db.query<GroundingRow>(
      `${GROUNDING_SELECT}
        where ${conditions.join(' and ')}
        order by g.state asc, g.updated_at_server desc
        limit $${params.push(query.limit)}`,
      params,
    );
    return { items: result.rows.map((row) => this.mapGrounding(row)) };
  }

  async get(actor: AuthUser, id: string): Promise<Record<string, unknown>> {
    const row = await this.load(this.db, id);
    if (!row) {
      throw new DomainError('E-NOT-01', 'Заземление не найдено');
    }
    await this.journals.assertAccess(actor, row.journal_id, 'read');
    return this.mapGrounding(row);
  }

  /**
   * Applies a stored grounding entry to the registry inside the sync
   * transaction. Returns a conflict reason instead of throwing so the journal
   * event is still recorded and the conflict can be reviewed.
   */
  async applyEntryEvent(
    tx: SqlClient,
    actor: AuthUser,
    entry: {
      id: string;
      journal_id: string;
      site_id: string | null;
      author_id: string;
      performed_at: string;
      event_data: GroundingEventData | null;
    },
    meta: RequestMeta,
    deviceId?: string,
  ): Promise<GroundingApplyResult> {
    const data = entry.event_data;
    if (!data || !data.point) {
      return { row: null, conflict: 'grounding_data_incomplete' };
    }

    const active = await tx.query<GroundingRow>(
      `select * from groundings
        where journal_id = $1::uuid
          and coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid)
              = coalesce($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
          and point = $3
          and grounding_type = $4::grounding_type_enum
          and coalesce(tool_number, '') = coalesce($5, '')
          and state = 'applied'
        limit 1`,
      [
        entry.journal_id,
        entry.site_id,
        data.point,
        data.grounding_type,
        data.tool_number ?? null,
      ],
    );
    const current = active.rows[0] ?? null;

    if (data.action === 'applied') {
      if (current) {
        await this.audit.record(tx, {
          actorId: actor.id,
          actorRole: actor.role,
          action: 'grounding.conflict',
          entityType: 'grounding',
          entityId: current.id,
          after: { conflict: 'grounding_already_applied', entry_id: entry.id },
          source: 'client',
          ...(deviceId ? { deviceId } : {}),
          ...meta,
        });
        return { row: current, conflict: 'grounding_already_applied' };
      }

      const inserted = await tx.query<GroundingRow>(
        `insert into groundings
           (id, journal_id, site_id, point, grounding_type, tool_number, count,
            state, applied_entry_id, applied_by, applied_at)
         values ($1, $2::uuid, $3::uuid, $4, $5::grounding_type_enum, $6, $7,
                 'applied'::grounding_state_enum, $8, $9, $10::timestamptz)
         returning *`,
        [
          uuidv7(),
          entry.journal_id,
          entry.site_id,
          data.point,
          data.grounding_type,
          data.tool_number ?? null,
          data.count ?? 1,
          entry.id,
          entry.author_id,
          entry.performed_at,
        ],
      );
      const row = inserted.rows[0]!;
      await this.afterChange(tx, actor, row, 'grounding.applied', 'applied', entry.id, meta, deviceId);
      return { row, conflict: null };
    }

    if (!current) {
      await this.audit.record(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'grounding.conflict',
        entityType: 'grounding',
        entityId: entry.id,
        after: { conflict: 'grounding_not_applied', entry_id: entry.id },
        source: 'client',
        ...(deviceId ? { deviceId } : {}),
        ...meta,
      });
      return { row: null, conflict: 'grounding_not_applied' };
    }

    const updated = await tx.query<GroundingRow>(
      `update groundings
          set state = 'removed'::grounding_state_enum,
              removed_entry_id = $1, removed_by = $2, removed_at = $3::timestamptz,
              version = version + 1, updated_at_server = now()
        where id = $4 and state = 'applied'::grounding_state_enum
        returning *`,
      [entry.id, entry.author_id, entry.performed_at, current.id],
    );
    const row = updated.rows[0];
    if (!row) {
      return { row: current, conflict: 'grounding_already_removed' };
    }
    await this.afterChange(tx, actor, row, 'grounding.removed', 'removed', entry.id, meta, deviceId);
    return { row, conflict: null };
  }

  mapGrounding(row: GroundingRow): Record<string, unknown> {
    return {
      ...row,
      count: Number(row.count ?? 1),
      version: Number(row.version ?? 1),
    };
  }

  private async load(tx: SqlClient, id: string): Promise<GroundingRow | null> {
    const result = await tx.query<GroundingRow>(`${GROUNDING_SELECT} where g.id = $1`, [id]);
    return result.rows[0] ?? null;
  }

  private async afterChange(
    tx: SqlClient,
    actor: AuthUser,
    row: GroundingRow,
    action: string,
    state: 'applied' | 'removed',
    entryId: string,
    meta: RequestMeta,
    deviceId?: string,
  ): Promise<void> {
    await appendChange(tx, {
      entityType: 'grounding',
      entityId: row.id,
      op: 'upsert',
      version: Number(row.version),
      actorId: actor.id,
    });
    await this.audit.record(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action,
      entityType: 'grounding',
      entityId: row.id,
      after: {
        entry_id: entryId,
        state,
        journal_id: row.journal_id,
        site_id: row.site_id,
        point: row.point,
        grounding_type: row.grounding_type,
        tool_number: row.tool_number,
        count: Number(row.count),
      },
      source: 'client',
      ...(deviceId ? { deviceId } : {}),
      ...meta,
    });
  }
}
