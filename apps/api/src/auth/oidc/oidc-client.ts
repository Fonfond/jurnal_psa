import { type IdTokenClaims, type JwkSet, verifyIdToken } from './jwt';

export interface OidcClientOptions {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string;
  allowedAlgorithms: string[];
  clockSkewSeconds: number;
  timeoutMs: number;
}

export interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
}

export interface OidcTokenResponse {
  id_token: string;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

export interface OidcUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  preferred_username?: string;
  [key: string]: unknown;
}

export class OidcTransportError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'OidcTransportError';
    this.status = status;
  }
}

type FetchLike = typeof fetch;

const DISCOVERY_TTL_MS = 5 * 60 * 1000;
const JWKS_TTL_MS = 10 * 60 * 1000;

/**
 * Minimal, dependency-free OIDC client:
 * discovery → Authorization Code + PKCE → id_token (JWKS) → optional userinfo.
 * Uses only Node's crypto, no JWT library (see jwt.ts).
 */
export class OidcClient {
  private discoveryCache: { document: OidcDiscoveryDocument; expiresAt: number } | null =
    null;
  private jwksCache: { jwks: JwkSet; expiresAt: number } | null = null;

  constructor(
    private readonly options: OidcClientOptions,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
  ) {}

  private get issuer(): string {
    return this.options.issuer.replace(/\/$/, '');
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw new OidcTransportError(
        `IdP недоступен: ${error instanceof Error ? error.message : 'сетевая ошибка'}`,
      );
    }
    return response;
  }

  private async readJson<T>(response: Response, label: string): Promise<T> {
    if (!response.ok) {
      const details = await response.text().catch(() => '');
      throw new OidcTransportError(
        `${label}: HTTP ${response.status}${details ? ` ${details.slice(0, 300)}` : ''}`,
        response.status,
      );
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new OidcTransportError(`${label}: некорректный JSON`);
    }
  }

  private discoveryCandidateUrls(): string[] {
    const issuer = this.issuer;
    // RFC 8414 keeps the path: https://host/.well-known/openid-configuration/path.
    const url = new URL(issuer);
    const path = url.pathname.replace(/\/$/, '');
    const root = `${url.origin}/.well-known/openid-configuration`;
    if (!path) {
      return [root];
    }
    return [`${root}${path}`, `${issuer}/.well-known/openid-configuration`];
  }

  async discovery(force = false): Promise<OidcDiscoveryDocument> {
    const now = Date.now();
    if (!force && this.discoveryCache && this.discoveryCache.expiresAt > now) {
      return this.discoveryCache.document;
    }

    let lastError: unknown;
    for (const url of this.discoveryCandidateUrls()) {
      try {
        const response = await this.request(url, {
          headers: { accept: 'application/json' },
        });
        const document = await this.readJson<OidcDiscoveryDocument>(
          response,
          'OIDC discovery',
        );
        for (const field of [
          'issuer',
          'authorization_endpoint',
          'token_endpoint',
          'jwks_uri',
        ] as const) {
          if (typeof document[field] !== 'string' || document[field].length === 0) {
            throw new OidcTransportError(`OIDC discovery: нет поля ${field}`);
          }
        }
        if (document.issuer.replace(/\/$/, '') !== this.issuer) {
          throw new OidcTransportError(
            'OIDC discovery: issuer не совпадает с OIDC_ISSUER',
          );
        }
        this.discoveryCache = { document, expiresAt: now + DISCOVERY_TTL_MS };
        return document;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new OidcTransportError('OIDC discovery недоступен');
  }

  async authorizationUrl(params: {
    state: string;
    nonce: string;
    codeChallenge: string;
    extraParams?: Record<string, string>;
  }): Promise<string> {
    const discovery = await this.discovery();
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', this.options.redirectUri);
    url.searchParams.set('scope', this.options.scopes);
    url.searchParams.set('state', params.state);
    url.searchParams.set('nonce', params.nonce);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('prompt', 'select_account');
    for (const [key, value] of Object.entries(params.extraParams ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<OidcTokenResponse> {
    const discovery = await this.discovery();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.options.redirectUri,
      client_id: this.options.clientId,
      code_verifier: codeVerifier,
    });

    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    const methods = discovery.token_endpoint_auth_methods_supported ?? [];
    if (this.options.clientSecret) {
      if (methods.includes('client_secret_basic')) {
        const credentials = Buffer.from(
          `${encodeURIComponent(this.options.clientId)}:${encodeURIComponent(this.options.clientSecret)}`,
        ).toString('base64');
        headers.authorization = `Basic ${credentials}`;
      } else {
        body.set('client_secret', this.options.clientSecret);
      }
    }

    const response = await this.request(discovery.token_endpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
    });
    return this.readJson<OidcTokenResponse>(response, 'OIDC token');
  }

  async jwks(force = false): Promise<JwkSet> {
    const now = Date.now();
    if (!force && this.jwksCache && this.jwksCache.expiresAt > now) {
      return this.jwksCache.jwks;
    }
    const discovery = await this.discovery();
    const response = await this.request(discovery.jwks_uri, {
      headers: { accept: 'application/json' },
    });
    const jwks = await this.readJson<JwkSet>(response, 'OIDC JWKS');
    if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
      throw new OidcTransportError('OIDC JWKS: пустой набор ключей');
    }
    this.jwksCache = { jwks, expiresAt: now + JWKS_TTL_MS };
    return jwks;
  }

  async verifyIdToken(idToken: string, expectedNonce: string): Promise<IdTokenClaims> {
    const options = {
      issuer: this.issuer,
      audience: this.options.clientId,
      allowedAlgorithms: this.options.allowedAlgorithms,
      clockSkewSeconds: this.options.clockSkewSeconds,
      expectedNonce,
    };
    try {
      return verifyIdToken(idToken, await this.jwks(), options);
    } catch (firstError) {
      // Key rotation: refresh JWKS once before failing the login.
      try {
        return verifyIdToken(idToken, await this.jwks(true), options);
      } catch {
        throw firstError instanceof Error
          ? firstError
          : new OidcTransportError('Не удалось проверить id_token');
      }
    }
  }

  async userInfo(accessToken: string): Promise<OidcUserInfo> {
    const discovery = await this.discovery();
    if (!discovery.userinfo_endpoint) {
      throw new OidcTransportError('IdP не поддерживает userinfo');
    }
    const response = await this.request(discovery.userinfo_endpoint, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
      },
    });
    return this.readJson<OidcUserInfo>(response, 'OIDC userinfo');
  }
}
