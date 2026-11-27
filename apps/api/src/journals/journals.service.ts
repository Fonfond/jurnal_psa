import { Inject, Injectable } from '@nestjs/common';
import {
  DEFAULT_JOURNAL_KEY,
  DomainError,
  uuidv7,
  type JournalAccessLevel,
  type JournalCreateInput,
  type JournalPatchInput,
} from '@logbook/shared';
import { AuditService } from '../audit/audit.service';
import { ensureJournalSequence } from './journal-seq';
import type { AuthUser, RequestMeta } from '../common/types';
import type { SqlClient } from '../db/sql-client';
import { DB } from '../db/tokens';

export interface JournalRow extends Record<string, unknown> {
  id: string;
  journal_key: string;
  name: string;
  description: string | null;
  active: boolean;
  sort_order: number;
  created_at?: string;
  access_level?: JournalAccessLevel | null;
}

export type JournalAccess = 'read' | 'write' | 'manage';

/**
 * Multi-journal catalogue and access rules (JRN-03, ADR-24).
 *
 * Access model:
 *  - admin: manage every journal (create/patch/members);
 *  - auditor: read every active journal;
 *  - worker/supervisor: the default `main` journal stays open for backward
 *    compatibility, other journals require a `journal_members` grant.
 *  - `read` grants read access, `write` also allows entries, `manage` grants
 *    membership administration for that journal.
 */
@Injectable()
export class JournalsService {
  constructor(
    @Inject(DB) private readonly db: SqlClient,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(actor: AuthUser): Promise<{ items: Array<Record<string, unknown>> }> {
    if (actor.role === 'admin' || actor.role === 'auditor') {
      const rows = await this.db.query<JournalRow>(
        `select j.*
           from journals j
          where ($1::boolean or j.active = true)
          order by j.sort_order, j.journal_key`,
        [actor.role === 'admin'],
      );
      return {
        items: rows.rows.map((row) => ({
          ...this.mapJournal(row),
          access_level: actor.role === 'admin' ? 'manage' : 'read',
        })),
      };
    }

    const rows = await this.db.query<JournalRow>(
      `select j.*, m.access_level
         from journals j
         left join journal_members m
           on m.journal_id = j.id and m.user_id = $1
        where j.active = true
          and (j.journal_key = $2 or m.user_id is not null)
        order by j.sort_order, j.journal_key`,
      [actor.id, DEFAULT_JOURNAL_KEY],
    );

    return {
      items: rows.rows.map((row) => ({
        ...this.mapJournal(row),
        access_level:
          row.access_level ?? (row.journal_key === DEFAULT_JOURNAL_KEY ? 'write' : null),
      })),
    };
  }

  async get(actor: AuthUser, id: string): Promise<Record<string, unknown>> {
    const journal = await this.assertAccess(actor, id, 'read');
    return {
      ...this.mapJournal(journal),
      access_level: await this.accessLevel(actor, journal),
    };
  }

  async load(id: string, client: SqlClient = this.db): Promise<JournalRow | null> {
    const result = await client.query<JournalRow>('select * from journals where id = $1', [id]);
    return result.rows[0] ?? null;
  }

  async loadByKey(key: string, client: SqlClient = this.db): Promise<JournalRow | null> {
    const result = await client.query<JournalRow>(
      'select * from journals where journal_key = $1',
      [key],
    );
    return result.rows[0] ?? null;
  }

  /** Effective access level of the actor for a journal (null = no access). */
  async accessLevel(
    actor: AuthUser,
    journal: JournalRow,
    client: SqlClient = this.db,
  ): Promise<JournalAccess | null> {
    if (actor.role === 'admin') {
      return 'manage';
    }
    if (actor.role === 'auditor') {
      return 'read';
    }
    const result = await client.query<{ access_level: JournalAccess }>(
      `select access_level from journal_members
        where journal_id = $1 and user_id = $2`,
      [journal.id, actor.id],
    );
    const granted = result.rows[0]?.access_level ?? null;
    if (journal.journal_key === DEFAULT_JOURNAL_KEY) {
      // Legacy: the primary journal is open to operational users who have no
      // explicit grant. An explicit `read` grant stays read-only.
      return granted ?? 'write';
    }
    return granted;
  }

  /**
   * Assert that the actor may use the journal at the requested level.
   * Used by entries, reviews, export and sync so the rule lives in one place.
   */
  async assertAccess(
    actor: AuthUser,
    journalId: string,
    needed: JournalAccess,
    client: SqlClient = this.db,
  ): Promise<JournalRow> {
    const journal = await this.load(journalId, client);
    if (!journal) {
      throw new DomainError('E-NOT-01', 'Журнал не найден');
    }
    if (!journal.active && actor.role !== 'admin' && needed !== 'read') {
      throw new DomainError('E-VAL-01', 'Журнал закрыт для новых записей');
    }
    const level = await this.accessLevel(actor, journal, client);
    const allowed =
      level === 'manage' ||
      (needed === 'read' && level !== null) ||
      (needed === 'write' && level === 'write');
    if (!allowed) {
      throw new DomainError('E-AUTH-02', 'Нет доступа к журналу');
    }
    return journal;
  }

  /** Resolve the journal for a new entry; omitted journal means `main`. */
  async resolveForEntry(
    actor: AuthUser,
    journalId: string | null | undefined,
    client: SqlClient = this.db,
  ): Promise<JournalRow> {
    if (!journalId) {
      const journal = await this.loadByKey(DEFAULT_JOURNAL_KEY, client);
      if (!journal) {
        throw new DomainError('E-NOT-01', 'Журнал по умолчанию не найден');
      }
      return this.assertAccess(actor, journal.id, 'write', client);
    }
    return this.assertAccess(actor, journalId, 'write', client);
  }

  async create(
    actor: AuthUser,
    body: JournalCreateInput,
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    const existing = await this.loadByKey(body.journal_key);
    if (existing) {
      throw new DomainError('E-VAL-01', 'Журнал с таким ключом уже существует');
    }

    const id = uuidv7();
    const inserted = await this.db.query<JournalRow>(
      `insert into journals
         (id, journal_key, name, description, active, sort_order)
       values ($1, $2, $3, $4, $5, $6)
       returning *`,
      [
        id,
        body.journal_key,
        body.name,
        body.description ?? null,
        body.active ?? true,
        body.sort_order ?? 100,
      ],
    );
    await this.db.query(
      'insert into journal_counters (journal_id, last_seq) values ($1, 0) on conflict (journal_id) do nothing',
      [id],
    );
    await ensureJournalSequence(this.db, id, 1);
    await this.bumpDictionaryVersion();
    await this.audit.record(this.db, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'journal.create',
      entityType: 'journal',
      entityId: id,
      after: {
        journal_key: body.journal_key,
        name: body.name,
        sort_order: body.sort_order ?? 100,
      },
      source: 'server',
      ...meta,
    });

    return this.mapJournal(inserted.rows[0]!);
  }

  async update(
    actor: AuthUser,
    id: string,
    body: JournalPatchInput,
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    const journal = await this.load(id);
    if (!journal) {
      throw new DomainError('E-NOT-01', 'Журнал не найден');
    }

    const assignments: string[] = [];
    const params: unknown[] = [];
    if (body.name !== undefined) {
      assignments.push(`name = $${params.push(body.name)}`);
    }
    if (body.description !== undefined) {
      assignments.push(`description = $${params.push(body.description ?? null)}`);
    }
    if (body.active !== undefined) {
      assignments.push(`active = $${params.push(body.active)}`);
    }
    if (body.sort_order !== undefined) {
      assignments.push(`sort_order = $${params.push(body.sort_order)}`);
    }
    if (assignments.length === 0) {
      return this.mapJournal(journal);
    }

    params.push(id);
    const updated = await this.db.query<JournalRow>(
      `update journals set ${assignments.join(', ')} where id = $${params.length} returning *`,
      params,
    );
    await this.bumpDictionaryVersion();
    await this.audit.record(this.db, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'journal.update',
      entityType: 'journal',
      entityId: id,
      before: {
        name: journal.name,
        description: journal.description,
        active: journal.active,
        sort_order: journal.sort_order,
      },
      after: {
        name: body.name ?? journal.name,
        description: body.description ?? journal.description,
        active: body.active ?? journal.active,
        sort_order: body.sort_order ?? journal.sort_order,
      },
      source: 'server',
      ...meta,
    });

    return this.mapJournal(updated.rows[0]!);
  }

  async members(actor: AuthUser, journalId: string): Promise<Record<string, unknown>> {
    await this.assertAccess(actor, journalId, 'read');
    const rows = await this.db.query(
      `select m.journal_id, m.user_id, m.access_level, m.granted_at,
              u.full_name, u.email
         from journal_members m
         join users u on u.id = m.user_id
        where m.journal_id = $1
        order by u.full_name`,
      [journalId],
    );
    return { items: rows.rows };
  }

  async upsertMember(
    actor: AuthUser,
    journalId: string,
    userId: string,
    accessLevel: JournalAccessLevel,
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    const journal = await this.load(journalId);
    if (!journal) {
      throw new DomainError('E-NOT-01', 'Журнал не найден');
    }
    const user = await this.db.query<{ id: string; full_name: string }>(
      'select id, full_name from users where id = $1',
      [userId],
    );
    if (!user.rows[0]) {
      throw new DomainError('E-NOT-01', 'Пользователь не найден');
    }

    const upserted = await this.db.query(
      `insert into journal_members (journal_id, user_id, access_level, granted_by, granted_at)
       values ($1, $2, $3, $4, now())
       on conflict (journal_id, user_id) do update
         set access_level = excluded.access_level,
             granted_by = excluded.granted_by,
             granted_at = excluded.granted_at
       returning *`,
      [journalId, userId, accessLevel, actor.id],
    );
    await this.audit.record(this.db, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'journal.member.grant',
      entityType: 'journal',
      entityId: journalId,
      after: { user_id: userId, access_level: accessLevel },
      source: 'server',
      ...meta,
    });

    return {
      ...(upserted.rows[0] as Record<string, unknown>),
      full_name: user.rows[0].full_name,
    };
  }

  async removeMember(
    actor: AuthUser,
    journalId: string,
    userId: string,
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    const journal = await this.load(journalId);
    if (!journal) {
      throw new DomainError('E-NOT-01', 'Журнал не найден');
    }
    await this.db.query(
      'delete from journal_members where journal_id = $1 and user_id = $2',
      [journalId, userId],
    );
    await this.audit.record(this.db, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'journal.member.revoke',
      entityType: 'journal',
      entityId: journalId,
      after: { user_id: userId },
      source: 'server',
      ...meta,
    });
    return { journal_id: journalId, user_id: userId, access_level: null };
  }

  private async bumpDictionaryVersion(): Promise<void> {
    await this.db.query(
      `insert into dictionary_versions (name, version, updated_at)
       values ('journals', 1, now())
       on conflict (name) do update
         set version = dictionary_versions.version + 1, updated_at = now()`,
    );
  }

  private mapJournal(row: JournalRow): Record<string, unknown> {
    const { access_level: _accessLevel, ...rest } = row;
    return { ...rest, sort_order: Number(rest.sort_order) };
  }
}
