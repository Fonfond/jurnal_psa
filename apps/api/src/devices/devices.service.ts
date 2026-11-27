import { Inject, Injectable } from '@nestjs/common';
import {
  type DeviceRegisterInput,
  type DeviceRegistrationResponse,
  DomainError,
  type RegisteredDevice,
  type Role,
  uuidv7,
} from '@logbook/shared';
import { AuditService } from '../audit/audit.service';
import { randomToken, sha256 } from '../common/context';
import type { AuthUser, RequestMeta } from '../common/types';
import type { SqlClient } from '../db/sql-client';
import { DB } from '../db/tokens';

interface DeviceRow {
  id: string;
  user_id: string;
  install_id: string | null;
  name: string | null;
  platform: string | null;
  app_version: string | null;
  status: 'active' | 'revoked';
  device_key_hash: string | null;
  created_at: string;
  registered_at: string;
  last_seen_at: string;
  revoked_at: string | null;
}

export interface AdminDeviceRow extends RegisteredDevice {
  user_name: string | null;
  user_email: string | null;
}

export interface AdminDeviceQuery {
  search?: string;
  status?: 'active' | 'revoked';
  limit: number;
  offset: number;
}

const DEVICE_COLUMNS = `id, user_id, install_id, name, platform, app_version, status,
       device_key_hash, created_at, registered_at, last_seen_at, revoked_at`;

@Injectable()
export class DevicesService {
  constructor(
    @Inject(DB) private readonly db: SqlClient,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(userId: string): Promise<RegisteredDevice[]> {
    const result = await this.db.query<DeviceRow>(
      `select ${DEVICE_COLUMNS}
         from devices
        where user_id = $1
        order by last_seen_at desc`,
      [userId],
    );
    return result.rows.map((row) => this.mapDevice(row));
  }

  /** Admin device inventory across users (ADR-14, AUTH-02/ADM-06). */
  async listAll(
    query: AdminDeviceQuery,
  ): Promise<{ items: AdminDeviceRow[]; total: number }> {
    const params: unknown[] = [query.search ?? null, query.status ?? null];
    const filters = `
        where ($1::text is null
               or d.name ilike '%' || $1 || '%'
               or d.install_id ilike '%' || $1 || '%'
               or u.full_name ilike '%' || $1 || '%'
               or u.email ilike '%' || $1 || '%')
          and ($2::text is null or d.status = $2::device_status_enum)`;
    const total = await this.db.query<{ count: string }>(
      `select count(*)::text as count
         from devices d
         join users u on u.id = d.user_id
         ${filters}`,
      params,
    );
    const result = await this.db.query<DeviceRow & {
      user_name: string | null;
      user_email: string | null;
    }>(
      `select d.id, d.user_id, d.install_id, d.name, d.platform, d.app_version,
              d.status, d.device_key_hash, d.created_at, d.registered_at,
              d.last_seen_at, d.revoked_at,
              u.full_name as user_name, u.email as user_email
         from devices d
         join users u on u.id = d.user_id
         ${filters}
        order by d.last_seen_at desc
        limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, query.limit, query.offset],
    );
    return {
      items: result.rows.map((row) => ({
        ...this.mapDevice(row),
        user_name: row.user_name,
        user_email: row.user_email,
      })),
      total: Number(total.rows[0]?.count ?? 0),
    };
  }

  /**
   * Idempotent device self-registration by (user_id, install_id) — ADR-23.
   * The device key is returned only when it is created or explicitly rotated.
   */
  async register(
    actor: AuthUser,
    input: DeviceRegisterInput,
    meta: RequestMeta,
  ): Promise<DeviceRegistrationResponse> {
    return this.db.transaction(async (tx) => {
      const existingResult = await tx.query<DeviceRow>(
        `select ${DEVICE_COLUMNS}
           from devices
          where user_id = $1 and install_id = $2
          for update`,
        [actor.id, input.install_id],
      );
      const existing = existingResult.rows[0];

      if (existing) {
        if (existing.status !== 'active') {
          throw new DomainError(
            'E-AUTH-02',
            'Устройство отозвано администратором; повторная регистрация запрещена',
          );
        }
        const rotate = input.rotate_key === true;
        const deviceKey = rotate ? randomToken() : null;
        const updated = await tx.query<DeviceRow>(
          `update devices
              set name = coalesce($3::varchar, name),
                  platform = coalesce($4::varchar, platform),
                  app_version = coalesce($5::varchar, app_version),
                  fingerprint = coalesce($6::varchar, fingerprint),
                  user_agent = coalesce($7::varchar, user_agent),
                  last_seen_at = now(),
                  device_key_hash = coalesce($8::char(64), device_key_hash)
            where id = $1 and user_id = $2
            returning ${DEVICE_COLUMNS}`,
          [
            existing.id,
            actor.id,
            input.name ?? null,
            input.platform ?? null,
            input.app_version ?? null,
            input.fingerprint ?? null,
            meta.userAgent ?? null,
            deviceKey ? sha256(deviceKey) : null,
          ],
        );

        await this.bindSession(tx, actor.sessionId, existing.id);
        await this.audit.record(tx, {
          actorId: actor.id,
          actorRole: actor.role,
          action: 'device.register',
          entityType: 'device',
          entityId: existing.id,
          after: {
            install_id: input.install_id,
            created: false,
            key_rotated: rotate,
            platform: input.platform ?? existing.platform,
            app_version: input.app_version ?? existing.app_version,
          },
          source: 'server',
          ...meta,
        });

        return {
          device: this.mapDevice(updated.rows[0]!),
          ...(deviceKey ? { device_key: deviceKey } : {}),
        };
      }

      const deviceId = uuidv7();
      const deviceKey = randomToken();
      const inserted = await tx.query<DeviceRow>(
        `insert into devices
           (id, user_id, name, platform, app_version, user_agent, install_id,
            fingerprint, device_key_hash, registered_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         returning ${DEVICE_COLUMNS}`,
        [
          deviceId,
          actor.id,
          input.name ?? 'Logbook device',
          input.platform ?? null,
          input.app_version ?? null,
          meta.userAgent ?? null,
          input.install_id,
          input.fingerprint ?? null,
          sha256(deviceKey),
        ],
      );

      await this.bindSession(tx, actor.sessionId, deviceId);
      await this.audit.record(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'device.register',
        entityType: 'device',
        entityId: deviceId,
        after: {
          install_id: input.install_id,
          created: true,
          platform: input.platform ?? null,
          app_version: input.app_version ?? null,
        },
        source: 'server',
        ...meta,
      });

      return {
        device: this.mapDevice(inserted.rows[0]!),
        device_key: deviceKey,
      };
    });
  }

  /**
   * Revokes a device, its bound sessions and audits the action.
   * Owners revoke their own devices; admins revoke any device.
   */
  async revoke(
    actor: Pick<AuthUser, 'id' | 'role' | 'sessionId'>,
    deviceId: string,
    meta: RequestMeta,
  ): Promise<{ ok: true; revoked_sessions: number }> {
    return this.db.transaction(async (tx) => {
      const result = await tx.query<DeviceRow>(
        `select ${DEVICE_COLUMNS} from devices where id = $1 for update`,
        [deviceId],
      );
      const device = result.rows[0];
      if (!device) {
        throw new DomainError('E-NOT-01', 'Устройство не найдено');
      }
      this.assertCanManage(actor.id, actor.role, device);

      let revokedSessions = 0;
      if (device.status !== 'revoked') {
        await tx.query(
          `update devices set status = 'revoked', revoked_at = now() where id = $1`,
          [deviceId],
        );
        const sessions = await tx.query(
          `update sessions set revoked_at = now()
            where device_id = $1 and revoked_at is null`,
          [deviceId],
        );
        revokedSessions = sessions.rowCount;
        await this.audit.record(tx, {
          actorId: actor.id,
          actorRole: actor.role,
          action: 'device.revoke',
          entityType: 'device',
          entityId: deviceId,
          before: { status: device.status },
          after: { status: 'revoked', revoked_sessions: revokedSessions },
          source: 'server',
          ...meta,
        });
      }

      return { ok: true, revoked_sessions: revokedSessions };
    });
  }

  private assertCanManage(actorId: string, role: Role, device: DeviceRow): void {
    if (device.user_id === actorId) {
      return;
    }
    if (role === 'admin') {
      return;
    }
    throw new DomainError('E-AUTH-02', 'Недостаточно прав');
  }

  /** Binds the current session to the device when it is not bound yet. */
  private async bindSession(
    tx: SqlClient,
    sessionId: string,
    deviceId: string,
  ): Promise<void> {
    await tx.query(
      `update sessions
          set device_id = $2
        where id = $1 and (device_id is null or device_id = $2)`,
      [sessionId, deviceId],
    );
  }

  private mapDevice(row: DeviceRow): RegisteredDevice {
    return {
      id: row.id,
      user_id: row.user_id,
      install_id: row.install_id,
      name: row.name,
      platform: row.platform,
      app_version: row.app_version,
      status: row.status,
      device_key_set: row.device_key_hash !== null,
      created_at: row.created_at,
      registered_at: row.registered_at,
      last_seen_at: row.last_seen_at,
      revoked_at: row.revoked_at,
    };
  }
}
