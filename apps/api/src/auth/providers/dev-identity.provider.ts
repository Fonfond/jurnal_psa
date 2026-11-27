import { Inject, Injectable } from '@nestjs/common';
import { compareSync } from 'bcryptjs';
import { DomainError, type Role, type UserStatus } from '@logbook/shared';
import { loadEnv } from '../../config/env';
import type { SqlClient } from '../../db/sql-client';
import { DB } from '../../db/tokens';
import type { IdentityProvider } from '../identity-provider';

export interface DevCredentialRow {
  id: string;
  role: Role;
  department_id: string;
  full_name: string;
  email: string | null;
  status: UserStatus;
}

/**
 * Dev-only identity provider (ADR-22): email + password from `user_credentials`.
 * Disabled in production and whenever AUTH_PROVIDER=oidc / DEV_LOGIN_ENABLED=false.
 */
@Injectable()
export class DevIdentityProvider implements IdentityProvider {
  readonly kind = 'dev' as const;
  readonly redirectLogin = false;

  constructor(@Inject(DB) private readonly db: SqlClient) {}

  assertEnabled(): void {
    const env = loadEnv();
    if (env.NODE_ENV === 'production') {
      throw new DomainError('E-AUTH-02', 'Dev-вход отключён в production');
    }
    if (env.AUTH_PROVIDER !== 'dev' || !env.DEV_LOGIN_ENABLED) {
      throw new DomainError(
        'E-AUTH-02',
        'Dev-вход отключён: используется корпоративный OIDC',
      );
    }
  }

  async verifyCredentials(
    email: string,
    password: string,
  ): Promise<DevCredentialRow> {
    this.assertEnabled();

    const result = await this.db.query<DevCredentialRow & { password_hash: string }>(
      `select u.id, u.role, u.department_id, u.full_name, u.email, u.status,
              c.password_hash
         from users u
         join user_credentials c on c.user_id = u.id
        where lower(u.email) = lower($1)
        limit 1`,
      [email],
    );
    const row = result.rows[0];
    if (!row || !compareSync(password, row.password_hash)) {
      throw new DomainError('E-AUTH-01', 'Неверный email или пароль');
    }
    if (row.status !== 'active') {
      throw new DomainError('E-AUTH-02', 'Учётная запись недоступна');
    }
    return row;
  }
}
