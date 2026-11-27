import { Inject, Injectable } from '@nestjs/common';
import { DomainError, uuidv7 } from '@logbook/shared';
import { loadEnv, type Env } from '../../config/env';
import { sha256 } from '../../common/context';
import type { SqlClient } from '../../db/sql-client';
import { DB } from '../../db/tokens';
import type {
  AuthorizeInput,
  AuthorizeResult,
  CallbackInput,
  CallbackResult,
  OidcIdentity,
  RedirectIdentityProvider,
} from '../identity-provider';
import { JwtError } from '../oidc/jwt';
import { OidcClient, OidcTransportError } from '../oidc/oidc-client';
import {
  codeChallenge,
  createCodeVerifier,
  createNonce,
  createState,
  safeEqual,
  safeRedirectTarget,
} from '../oidc/pkce';

interface LoginRequestRow {
  id: string;
  nonce: string;
  code_verifier: string;
  redirect_after: string | null;
  device_id: string | null;
  expires_at: string;
}

/**
 * OIDC Authorization Code + PKCE provider (ADR-23, closes the dev-only gap of
 * ADR-22 for production). The PKCE transaction is persisted server-side and
 * bound to the browser by a short-lived HttpOnly `state` cookie.
 */
@Injectable()
export class OidcIdentityProvider implements RedirectIdentityProvider {
  readonly kind = 'oidc' as const;
  readonly redirectLogin = true;

  private client: OidcClient | null = null;

  constructor(@Inject(DB) private readonly db: SqlClient) {}

  static isConfigured(env: Env = loadEnv()): boolean {
    return Boolean(env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_REDIRECT_URI);
  }

  private getClient(): OidcClient {
    if (this.client) {
      return this.client;
    }
    const env = loadEnv();
    if (!OidcIdentityProvider.isConfigured(env)) {
      throw new DomainError(
        'E-OIDC-02',
        'OIDC не настроен: задайте OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_REDIRECT_URI',
      );
    }
    this.client = new OidcClient({
      issuer: env.OIDC_ISSUER as string,
      clientId: env.OIDC_CLIENT_ID as string,
      clientSecret: env.OIDC_CLIENT_SECRET,
      redirectUri: env.OIDC_REDIRECT_URI as string,
      scopes: env.OIDC_SCOPES,
      allowedAlgorithms: env.OIDC_ALLOWED_ALGORITHMS.split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      clockSkewSeconds: env.OIDC_CLOCK_SKEW_SECONDS,
      timeoutMs: env.OIDC_TIMEOUT_MS,
    });
    return this.client;
  }

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const env = loadEnv();
    const client = this.getClient();
    const state = createState();
    const nonce = createNonce();
    const verifier = createCodeVerifier();
    const challenge = codeChallenge(verifier);
    const redirectAfter = safeRedirectTarget(
      input.redirectAfter,
      safeRedirectTarget(env.OIDC_POST_LOGIN_REDIRECT, '/'),
    );

    let url: string;
    const acrValues = env.OIDC_MFA_ACR_VALUES.split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .join(' ');
    try {
      url = await client.authorizationUrl({
        state,
        nonce,
        codeChallenge: challenge,
        ...(acrValues ? { extraParams: { acr_values: acrValues } } : {}),
      });
    } catch (error) {
      throw toDomainError(error);
    }

    const expiresAt = new Date(Date.now() + env.OIDC_LOGIN_TTL_SECONDS * 1000).toISOString();
    // Housekeeping: login transactions are single-use and short-lived.
    await this.db.query(
      `delete from oidc_login_requests where expires_at < now() - interval '1 day'`,
    );
    await this.db.query(
      `insert into oidc_login_requests
         (id, state_hash, nonce, code_verifier, code_challenge, redirect_after,
          device_id, user_agent, ip, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::inet, $10)`,
      [
        uuidv7(),
        sha256(state),
        nonce,
        verifier,
        challenge,
        redirectAfter,
        input.deviceId ?? null,
        input.userAgent ?? null,
        input.ip ?? null,
        expiresAt,
      ],
    );

    return {
      url,
      stateCookieValue: state,
      maxAgeSeconds: env.OIDC_LOGIN_TTL_SECONDS,
    };
  }

  async complete(input: CallbackInput): Promise<CallbackResult> {
    const env = loadEnv();
    if (input.error) {
      throw new DomainError(
        'E-OIDC-01',
        `IdP вернул ошибку: ${input.error}${input.errorDescription ? ` (${input.errorDescription})` : ''}`,
      );
    }
    if (!input.state || !input.stateCookie || !safeEqual(input.state, input.stateCookie)) {
      throw new DomainError(
        'E-OIDC-01',
        'Некорректный state: cookie и параметр callback не совпадают',
      );
    }
    if (!input.code) {
      throw new DomainError('E-OIDC-01', 'В callback отсутствует code');
    }

    const stateHash = sha256(input.state);
    const request = await this.db.query<LoginRequestRow>(
      `select id, nonce, code_verifier, redirect_after, device_id, expires_at
         from oidc_login_requests
        where state_hash = $1 and consumed_at is null
        limit 1`,
      [stateHash],
    );
    const row = request.rows[0];
    if (!row || new Date(row.expires_at).getTime() <= Date.now()) {
      throw new DomainError('E-OIDC-01', 'Login-транзакция не найдена или истекла');
    }

    // Single use: the second callback with the same state must fail.
    const consumed = await this.db.query(
      `update oidc_login_requests
          set consumed_at = now()
        where id = $1 and consumed_at is null`,
      [row.id],
    );
    if (consumed.rowCount === 0) {
      throw new DomainError('E-OIDC-01', 'Login-транзакция уже использована');
    }

    const client = this.getClient();
    let tokens: Awaited<ReturnType<OidcClient['exchangeCode']>>;
    try {
      tokens = await client.exchangeCode(input.code, row.code_verifier);
    } catch (error) {
      throw toDomainError(error);
    }

    let claims: Awaited<ReturnType<OidcClient['verifyIdToken']>>;
    try {
      claims = await client.verifyIdToken(tokens.id_token, row.nonce);
    } catch (error) {
      if (error instanceof JwtError) {
        throw new DomainError('E-OIDC-01', `id_token отклонён: ${error.message}`);
      }
      throw toDomainError(error);
    }

    let email = typeof claims.email === 'string' ? claims.email : null;
    if (!email && tokens.access_token) {
      try {
        const info = await client.userInfo(tokens.access_token);
        email = typeof info.email === 'string' ? info.email : null;
        if (email && !claims.name && typeof info.name === 'string') {
          claims.name = info.name;
        }
      } catch (error) {
        // userinfo is best-effort; without email the account cannot be linked.
        if (!(error instanceof OidcTransportError)) {
          throw toDomainError(error);
        }
      }
    }

    const emailVerified = claims.email_verified;
    if (
      email &&
      (emailVerified === false || emailVerified === 'false')
    ) {
      throw new DomainError(
        'E-OIDC-03',
        'IdP не подтвердил email: связывание с учётной записью запрещено',
      );
    }

    const identity: OidcIdentity = {
      issuer: (env.OIDC_ISSUER as string).replace(/\/$/, ''),
      subject: claims.sub,
      email,
      fullName:
        (typeof claims.name === 'string' && claims.name.trim()) ||
        (typeof claims.preferred_username === 'string' &&
          claims.preferred_username.trim()) ||
        null,
      preferredUsername:
        typeof claims.preferred_username === 'string'
          ? claims.preferred_username
          : null,
      claims: claims as Record<string, unknown>,
    };

    return {
      identity,
      redirectAfter: safeRedirectTarget(
        row.redirect_after ?? undefined,
        safeRedirectTarget(env.OIDC_POST_LOGIN_REDIRECT, '/'),
      ),
      deviceId: row.device_id,
    };
  }
}

function toDomainError(error: unknown): DomainError {
  if (error instanceof DomainError) {
    return error;
  }
  if (error instanceof OidcTransportError || error instanceof JwtError) {
    return new DomainError('E-OIDC-02', error.message);
  }
  return new DomainError(
    'E-OIDC-02',
    `Ошибка OIDC: ${error instanceof Error ? error.message : 'неизвестная ошибка'}`,
  );
}
