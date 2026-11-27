import { Inject, Injectable } from '@nestjs/common';
import { hashSync } from 'bcryptjs';
import { DomainError, uuidv7, type Role, type UserStatus } from '@logbook/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestMeta } from '../common/types';
import type { SqlClient } from '../db/sql-client';
import { DB } from '../db/tokens';

export interface CreateUserInput {
  email: string;
  full_name: string;
  role: Role;
  department_id: string;
  position?: string;
  external_id?: string;
  /** Local demo credential; never accepted by the OIDC production provider. */
  password: string;
}

export interface PatchUserInput {
  full_name?: string;
  role?: Role;
  department_id?: string;
  status?: UserStatus;
  position?: string;
}

export interface AdminUserListQuery {
  search?: string;
  role?: Role;
  status?: UserStatus;
  department_id?: string;
  limit: number;
  offset: number;
}

export interface AdminUserRow extends Record<string, unknown> {
  id: string;
  external_id: string | null;
  full_name: string;
  email: string | null;
  role: Role;
  department_id: string | null;
  department_name: string | null;
  position: string | null;
  status: UserStatus;
  version: number;
  created_at: string;
  updated_at: string;
}

const ADMIN_USER_COLUMNS = `u.id, u.external_id, u.full_name, u.email, u.role,
       u.department_id, d.name as department_name, u.position, u.status,
       u.version, u.created_at, u.updated_at`;

@Injectable()
export class AdminService {
  constructor(
    @Inject(DB) private readonly db: SqlClient,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async createUser(
    actor: AuthUser,
    input: CreateUserInput,
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    const department = await this.db.query('select id from departments where id = $1', [
      input.department_id,
    ]);
    if (!department.rows[0]) {
      throw new DomainError('E-VAL-01', 'Подразделение не найдено');
    }

    const id = uuidv7();
    const externalId = input.external_id ?? `local:${id}`;
    return this.db.transaction(async (tx) => {
      const inserted = await tx.query<Record<string, unknown>>(
        `insert into users
           (id, external_id, full_name, email, role, department_id, position, status)
         values ($1, $2, $3, $4, $5::user_role_enum, $6, $7, 'active'::user_status_enum)
         returning id, external_id, full_name, email, role, department_id, position, status, version`,
        [
          id,
          externalId,
          input.full_name,
          input.email,
          input.role,
          input.department_id,
          input.position ?? null,
        ],
      );

      await tx.query(
        `insert into user_credentials (user_id, password_hash)
         values ($1, $2)`,
        [id, hashSync(input.password, 10)],
      );

      await this.audit.record(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'user.create',
        entityType: 'user',
        entityId: id,
        after: { email: input.email, role: input.role },
        source: 'server',
        ...meta,
      });

      return inserted.rows[0]!;
    });
  }

  async patchUser(
    actor: AuthUser,
    id: string,
    input: PatchUserInput,
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    return this.db.transaction(async (tx) => {
      const current = await tx.query<Record<string, unknown>>(
        'select * from users where id = $1 for update',
        [id],
      );
      const before = current.rows[0];
      if (!before) {
        throw new DomainError('E-NOT-01', 'Пользователь не найден');
      }

      const assignments: string[] = [];
      const params: unknown[] = [];
      if (input.full_name !== undefined) {
        assignments.push(`full_name = $${params.push(input.full_name)}`);
      }
      if (input.role !== undefined) {
        assignments.push(`role = $${params.push(input.role)}::user_role_enum`);
      }
      if (input.department_id !== undefined) {
        assignments.push(`department_id = $${params.push(input.department_id)}::uuid`);
      }
      if (input.status !== undefined) {
        assignments.push(`status = $${params.push(input.status)}::user_status_enum`);
      }
      if (input.position !== undefined) {
        assignments.push(`position = $${params.push(input.position)}`);
      }
      if (assignments.length === 0) {
        return before;
      }

      assignments.push('version = version + 1');
      assignments.push('updated_at = now()');
      params.push(id);

      const updated = await tx.query<Record<string, unknown>>(
        `update users set ${assignments.join(', ')} where id = $${params.length}
         returning id, external_id, full_name, email, role, department_id, position, status, version`,
        params,
      );

      await this.audit.record(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'user.update',
        entityType: 'user',
        entityId: id,
        before,
        after: input,
        source: 'server',
        ...meta,
      });

      return updated.rows[0]!;
    });
  }

  async revokeSessions(
    actor: AuthUser,
    id: string,
    meta: RequestMeta,
  ): Promise<{ ok: true; revoked: number }> {
    return this.db.transaction(async (tx) => {
      const result = await tx.query(
        'update sessions set revoked_at = now() where user_id = $1 and revoked_at is null',
        [id],
      );
      await this.audit.record(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'user.revoke_sessions',
        entityType: 'user',
        entityId: id,
        after: { revoked: result.rowCount },
        source: 'server',
        ...meta,
      });
      return { ok: true, revoked: result.rowCount };
    });
  }

  /** Users directory for the admin SPA (ADR-14, ADM-01/ADM-02). */
  async listUsers(
    query: AdminUserListQuery,
  ): Promise<{ items: AdminUserRow[]; total: number }> {
    const params: unknown[] = [
      query.search ?? null,
      query.role ?? null,
      query.status ?? null,
      query.department_id ?? null,
    ];
    const filters = `
        where ($1::text is null
               or u.full_name ilike '%' || $1 || '%'
               or u.email ilike '%' || $1 || '%'
               or u.external_id ilike '%' || $1 || '%')
          and ($2::text is null or u.role = $2::user_role_enum)
          and ($3::text is null or u.status = $3::user_status_enum)
          and ($4::uuid is null or u.department_id = $4::uuid)`;
    const total = await this.db.query<{ count: string }>(
      `select count(*)::text as count from users u ${filters}`,
      params,
    );
    const rows = await this.db.query<AdminUserRow>(
      `select ${ADMIN_USER_COLUMNS}
         from users u
         left join departments d on d.id = u.department_id
         ${filters}
        order by u.full_name, u.id
        limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, query.limit, query.offset],
    );
    return {
      items: rows.rows,
      total: Number(total.rows[0]?.count ?? 0),
    };
  }

  async listDepartments(): Promise<
    Array<{ id: string; name: string; parent_id: string | null }>
  > {
    const rows = await this.db.query<{
      id: string;
      name: string;
      parent_id: string | null;
    }>('select id, name, parent_id from departments order by name');
    return rows.rows;
  }
}
