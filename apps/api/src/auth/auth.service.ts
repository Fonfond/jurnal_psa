import { Inject, Injectable } from '@nestjs/common';
import {
  type AuthConfigResponse,
  DomainError,
  type Role,
  type UserStatus,
  uuidv7,
} from '@logbook/shared';
import { AuditService } from '../audit/audit.service';
import { loadEnv } from '../config/env';
import { randomToken, sha256 } from '../common/context';
import type { SqlClient } from '../db/sql-client';
import { DB } from '../db/tokens';
import { signatureLegalNote } from '../signature/signature.constants';
import type {
  AuthorizeInput,
  AuthorizeResult,
  CallbackInput,
  CallbackResult,
  OidcIdentity,
} from './identity-provider';
import { DevIdentityProvider } from './providers/dev-identity.provider';
import { OidcIdentityProvider } from './providers/oidc-identity.provider';

interface SessionRow {
  session_id: string;
  expires_at: string;
  revoked_at: string | null;
  last_seen_at: string;
  id: string;
  role: Role;
  department_id: string;
  full_name: string;
  email: string | null;
  status: UserStatus;
}

export interface Profile {
  id: string;
  full_name: string;
  role: Role;
  department: { id: string; name: string };
  status: UserStatus;
  email: string | null;
}

export interface CreatedSession {
  token: string;
  sessionId: string;
  expiresAt: string;
  deviceId: string | null;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: SqlClient,
    @Inject(DevIdentityProvider) private readonly dev: DevIdentityProvider,
    @Inject(OidcIdentityProvider) private readonly oidc: OidcIdentityProvider,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Dev login (ADR-22). Kept for local runs and tests; refuses to work in
   * production or when AUTH_PROVIDER=oidc.
   */
  async devLogin(
    email: string,
    password: string,
    userAgent?: string,
    ip?: string,
    deviceId?: string,
  ): Promise<{ profile: Profile; session: CreatedSession; csrfToken: string }> {
    const row = await this.dev.verifyCredentials(email, password);
    const session = await this.createSession(row.id, userAgent, ip, deviceId);
    const profile = await this.getProfile(row.id);
    return { profile, session, csrfToken: randomToken() };
  }

  beginOidcLogin(input: AuthorizeInput): Promise<AuthorizeResult> {
    return this.oidc.authorize(input);
  }

  async completeOidcLogin(
    input: CallbackInput,
    userAgent?: string,
    ip?: string,
  ): Promise<{
    profile: Profile;
    session: CreatedSession;
    csrfToken: string;
    redirectAfter: string;
  }> {
    const result: CallbackResult = await this.oidc.complete(input);
    const user = await this.resolveOidcUser(result.identity);
    const session = await this.createSession(
      user.id,
      userAgent,
      ip,
      result.deviceId ?? undefined,
    );
    const profile = await this.getProfile(user.id);
    return {
      profile,
      session,
      csrfToken: randomToken(),
      redirectAfter: result.redirectAfter,
    };
  }

  async createSession(
    userId: string,
    userAgent?: string,
    ip?: string,
    deviceId?: string,
  ): Promise<CreatedSession> {
    const env = loadEnv();
    if (deviceId) {
      await this.assertActiveDevice(userId, deviceId);
    }

    const token = randomToken();
    const tokenHash = sha256(token);
    const sessionId = uuidv7();
    const expiresAt = new Date(
      Date.now() + env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    await this.db.query(
      `insert into sessions
         (id, user_id, token_hash, user_agent, ip, expires_at, device_id)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        sessionId,
        userId,
        tokenHash,
        userAgent ?? null,
        ip ?? null,
        expiresAt,
        deviceId ?? null,
      ],
    );

    return { token, sessionId, expiresAt, deviceId: deviceId ?? null };
  }

  async resolveSession(token: string): Promise<{
    sessionId: string;
    expiresAt: string;
    user: {
      id: string;
      role: Role;
      departmentId: string;
      fullName: string;
      email: string | null;
    };
  } | null> {
    const env = loadEnv();
    const result = await this.db.query<SessionRow>(
      `select s.id as session_id, s.expires_at, s.revoked_at,
              s.last_seen_at,
              u.id, u.role, u.department_id, u.full_name, u.email, u.status
         from sessions s
         join users u on u.id = s.user_id
        where s.token_hash = $1
        limit 1`,
      [sha256(token)],
    );
    const row = result.rows[0];
    if (!row || row.revoked_at || row.status !== 'active') {
      return null;
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      return null;
    }

    // AUTH-04: sliding idle timeout. Revoke the session once so a stolen cookie
    // cannot be reused after the idle window, even if it is presented later.
    const idleMs = env.SESSION_IDLE_MINUTES * 60 * 1000;
    if (Date.now() - new Date(row.last_seen_at).getTime() > idleMs) {
      await this.db.query(
        `update sessions set revoked_at = now()
          where id = $1 and revoked_at is null`,
        [row.session_id],
      );
      return null;
    }

    return {
      sessionId: row.session_id,
      expiresAt: row.expires_at,
      user: {
        id: row.id,
        role: row.role,
        departmentId: row.department_id,
        fullName: row.full_name,
        email: row.email,
      },
    };
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.db.query('update sessions set last_seen_at = now() where id = $1', [
      sessionId,
    ]);
  }

  async logout(sessionId: string): Promise<void> {
    await this.db.query(
      'update sessions set revoked_at = now() where id = $1 and revoked_at is null',
      [sessionId],
    );
  }

  async getProfile(userId: string): Promise<Profile> {
    const result = await this.db.query<{
      id: string;
      full_name: string;
      role: Role;
      status: UserStatus;
      email: string | null;
      department_id: string;
      department_name: string;
    }>(
      `select u.id, u.full_name, u.role, u.status, u.email,
              d.id as department_id, d.name as department_name
         from users u
         join departments d on d.id = u.department_id
        where u.id = $1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new DomainError('E-NOT-01', 'Пользователь не найден');
    }
    return {
      id: row.id,
      full_name: row.full_name,
      role: row.role,
      department: { id: row.department_id, name: row.department_name },
      status: row.status,
      email: row.email,
    };
  }

  getAuthConfig(): AuthConfigResponse {
    const env = loadEnv();
    const provider = env.SIGNATURE_PROVIDER;
    const devLoginEnabled =
      env.NODE_ENV !== 'production' &&
      env.AUTH_PROVIDER === 'dev' &&
      env.DEV_LOGIN_ENABLED;

    return {
      auth_provider: env.AUTH_PROVIDER,
      dev_login_enabled: devLoginEnabled,
      oidc:
        env.AUTH_PROVIDER === 'oidc' && OidcIdentityProvider.isConfigured(env)
          ? {
              display_name: env.OIDC_DISPLAY_NAME,
              authorize_url: '/v1/auth/authorize',
            }
          : null,
      signature: {
        provider,
        algorithm:
          provider === 'simple'
            ? 'HMAC-SHA256'
            : provider === 'qualified'
              ? 'CMS-BES'
              : null,
        auto_sign: provider !== 'none' && env.SIGNATURE_AUTO_SIGN,
        legal_note: signatureLegalNote(provider, env.SIGNATURE_LEGAL_NOTE),
      },
    };
  }

  private async assertActiveDevice(userId: string, deviceId: string): Promise<void> {
    const device = await this.db.query<{ status: string }>(
      'select status from devices where id = $1 and user_id = $2',
      [deviceId, userId],
    );
    const row = device.rows[0];
    if (!row) {
      throw new DomainError('E-AUTH-02', 'Устройство не принадлежит пользователю');
    }
    if (row.status !== 'active') {
      throw new DomainError('E-AUTH-02', 'Устройство отозвано');
    }
  }

  /**
   * NFR-SEC-02: an admin session requires a second factor from the IdP.
   * Accepted signals: `acr` in OIDC_MFA_ACR_VALUES or `amr` with an MFA method.
   */
  private assertAdminMfa(role: Role, identity: OidcIdentity): void {
    const env = loadEnv();
    if (role !== 'admin' || !env.OIDC_REQUIRE_MFA_FOR_ADMIN) {
      return;
    }
    const allowedAcr = env.OIDC_MFA_ACR_VALUES.split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const acr = typeof identity.claims.acr === 'string' ? identity.claims.acr : '';
    const amr = Array.isArray(identity.claims.amr)
      ? identity.claims.amr.filter(
          (method): method is string => typeof method === 'string',
        )
      : [];
    const mfaMethods = new Set(['mfa', 'otp', 'hwk', 'swk', 'totp', 'pwd+mfa']);
    const hasMfaAmr = amr.some((method) => mfaMethods.has(method.toLowerCase()));
    if (allowedAcr.includes(acr) || hasMfaAmr) {
      return;
    }
    throw new DomainError(
      'E-OIDC-04',
      'Для администратора требуется MFA: IdP не подтвердил второй фактор (acr/amr)',
    );
  }

  /**
   * Maps an OIDC identity to a provisioned user (ADR-23):
   * 1) existing (issuer, subject) link;
   * 2) verified email of an existing user (bind + audit);
   * 3) optional JIT provisioning into a configured department;
   * otherwise access is denied — self-registration is forbidden (FR-AUTH-01).
   */
  private async resolveOidcUser(identity: OidcIdentity): Promise<{ id: string }> {
    const env = loadEnv();

    return this.db.transaction(async (tx) => {
      const linked = await tx.query<{ id: string; role: Role; status: UserStatus }>(
        `select u.id, u.role, u.status
           from user_identities i
           join users u on u.id = i.user_id
          where i.issuer = $1 and i.subject = $2
          limit 1`,
        [identity.issuer, identity.subject],
      );
      const linkedUser = linked.rows[0];
      if (linkedUser) {
        if (linkedUser.status !== 'active') {
          throw new DomainError('E-AUTH-02', 'Учётная запись недоступна');
        }
        this.assertAdminMfa(linkedUser.role, identity);
        await tx.query(
          `update user_identities
              set last_login_at = now(), email = coalesce($3, email)
            where issuer = $1 and subject = $2`,
          [identity.issuer, identity.subject, identity.email],
        );
        await tx.query('update users set last_login_at = now() where id = $1', [
          linkedUser.id,
        ]);
        return { id: linkedUser.id };
      }

      const byEmail = identity.email
        ? await tx.query<{ id: string; role: Role; status: UserStatus }>(
            `select id, role, status from users where lower(email) = lower($1) limit 1`,
            [identity.email],
          )
        : { rows: [] as Array<{ id: string; role: Role; status: UserStatus }> };
      const existing = byEmail.rows[0];

      if (existing) {
        if (existing.status !== 'active') {
          throw new DomainError('E-AUTH-02', 'Учётная запись недоступна');
        }
        this.assertAdminMfa(existing.role, identity);
        await tx.query(
          `insert into user_identities
             (id, user_id, provider, issuer, subject, email, last_login_at)
           values ($1, $2, 'oidc', $3, $4, $5, now())`,
          [uuidv7(), existing.id, identity.issuer, identity.subject, identity.email],
        );
        await tx.query('update users set last_login_at = now() where id = $1', [
          existing.id,
        ]);
        await this.audit.record(tx, {
          actorId: existing.id,
          actorRole: existing.role,
          action: 'user.oidc_link',
          entityType: 'user',
          entityId: existing.id,
          after: {
            issuer: identity.issuer,
            subject: identity.subject,
            email: identity.email,
          },
          source: 'server',
        });
        return { id: existing.id };
      }

      if (!env.OIDC_JIT_PROVISION || !env.OIDC_JIT_DEPARTMENT_ID) {
        throw new DomainError(
          'E-OIDC-03',
          'Учётная запись не найдена. Обратитесь к администратору: самостоятельная регистрация запрещена.',
        );
      }

      this.assertAdminMfa(env.OIDC_JIT_ROLE, identity);

      const department = await tx.query<{ id: string }>(
        'select id from departments where id = $1 and active = true',
        [env.OIDC_JIT_DEPARTMENT_ID],
      );
      if (!department.rows[0]) {
        throw new DomainError(
          'E-OIDC-03',
          'Подразделение для JIT-провижининга не найдено',
        );
      }

      const userId = uuidv7();
      const externalId = `oidc:${sha256(identity.subject).slice(0, 40)}`;
      const fullName =
        identity.fullName ?? identity.email ?? `Пользователь OIDC ${identity.subject.slice(0, 8)}`;
      await tx.query(
        `insert into users
           (id, external_id, full_name, email, role, department_id, status)
         values ($1, $2, $3, $4, $5::user_role_enum, $6, 'active'::user_status_enum)`,
        [
          userId,
          externalId,
          fullName,
          identity.email,
          env.OIDC_JIT_ROLE,
          env.OIDC_JIT_DEPARTMENT_ID,
        ],
      );
      await tx.query(
        `insert into user_identities
           (id, user_id, provider, issuer, subject, email, last_login_at)
         values ($1, $2, 'oidc', $3, $4, $5, now())`,
        [uuidv7(), userId, identity.issuer, identity.subject, identity.email],
      );
      await this.audit.record(tx, {
        actorId: userId,
        actorRole: env.OIDC_JIT_ROLE,
        action: 'user.provision_oidc',
        entityType: 'user',
        entityId: userId,
        after: {
          issuer: identity.issuer,
          subject: identity.subject,
          email: identity.email,
          role: env.OIDC_JIT_ROLE,
          department_id: env.OIDC_JIT_DEPARTMENT_ID,
        },
        source: 'server',
      });
      return { id: userId };
    });
  }
}
