import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface TestIdpUser {
  email: string;
  sub: string;
  name: string;
  mfa: boolean;
}

interface AuthorizationRequest {
  nonce: string;
  challenge: string;
  redirectUri: string;
  clientId: string;
  acrValues: string | null;
  user: TestIdpUser;
}

interface CodeRecord {
  request: AuthorizationRequest;
  redirectUri: string;
}

const USERS: TestIdpUser[] = [
  {
    email: 'admin@logbook.local',
    sub: 'idp-admin-sub',
    name: 'Сидорова Анна Сергеевна',
    mfa: true,
  },
  {
    email: 'worker@logbook.local',
    sub: 'idp-worker-sub',
    name: 'Иванов Иван Иванович',
    mfa: false,
  },
];

/**
 * Test-only OIDC provider over real HTTP (discovery/authorize/token/JWKS/userinfo).
 * It supports an MFA profile (acr=acr_mfa, amr=[pwd,otp]) and is used by the
 * integration harness; it is not an IdP and must not be deployed (REP-02).
 */
export class OidcTestIdp {
  private server: Server | null = null;
  private readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly kid = 'test-idp-key-1';
  private readonly authorizations = new Map<string, AuthorizationRequest>();
  private readonly codes = new Map<string, CodeRecord>();
  private issuer = '';
  private tokenErrorStatus: number | null = null;

  constructor(
    private readonly clientId = 'logbook',
    private readonly clientSecret = 'test-secret',
    private readonly acrMfa = 'mfa',
  ) {}

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: String(error) }));
      });
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Test IdP failed to bind');
    }
    this.issuer = `http://127.0.0.1:${address.port}`;
    return this.issuer;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = null;
  }

  /** Force the token endpoint to fail (OIDC transport error path). */
  failToken(status: number): void {
    this.tokenErrorStatus = status;
  }

  /** Last authorize request for assertions (redirect URI, acr_values, PKCE). */
  lastAuthorization(): AuthorizationRequest | null {
    const values = [...this.authorizations.values()];
    return values[values.length - 1] ?? null;
  }

  get publicJwk(): Record<string, unknown> {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    return { ...jwk, kid: this.kid, use: 'sig', alg: 'RS256' };
  }

  private signIdToken(claims: Record<string, unknown>): string {
    const header = { alg: 'RS256', kid: this.kid, typ: 'JWT' };
    const encode = (value: unknown): string =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    const signingInput = `${encode(header)}.${encode(claims)}`;
    const signature = createSign('RSA-SHA256')
      .update(signingInput, 'ascii')
      .sign(this.keys.privateKey)
      .toString('base64url');
    return `${signingInput}.${signature}`;
  }

  private async readBody(request: IncomingMessage): Promise<Record<string, string>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
  }

  private json(response: ServerResponse, body: unknown, status = 200): void {
    response.statusCode = status;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.issuer || 'http://127.0.0.1');
    if (url.pathname === '/.well-known/openid-configuration') {
      this.json(response, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        userinfo_endpoint: `${this.issuer}/userinfo`,
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        id_token_signing_alg_values_supported: ['RS256'],
      });
      return;
    }
    if (url.pathname === '/jwks') {
      this.json(response, { keys: [this.publicJwk] });
      return;
    }
    if (url.pathname === '/authorize') {
      await this.authorize(url, response);
      return;
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      await this.token(request, response);
      return;
    }
    if (url.pathname === '/userinfo') {
      this.json(response, { sub: 'idp-user', email: 'worker@logbook.local' });
      return;
    }
    this.json(response, { error: 'not_found' }, 404);
  }

  private async authorize(url: URL, response: ServerResponse): Promise<void> {
    const clientId = url.searchParams.get('client_id');
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');
    const nonce = url.searchParams.get('nonce');
    const challenge = url.searchParams.get('code_challenge');
    const method = url.searchParams.get('code_challenge_method');
    if (
      clientId !== this.clientId ||
      !redirectUri ||
      !state ||
      !nonce ||
      !challenge ||
      method !== 'S256'
    ) {
      this.json(response, { error: 'invalid_request' }, 400);
      return;
    }

    const email = url.searchParams.get('login') ?? '';
    const user = USERS.find((candidate) => candidate.email === email);
    if (!user) {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(
        `<form method="get"><input name="login" placeholder="email"><input name="mfa" value="0"><button>Войти</button></form>`,
      );
      return;
    }

    const mfa = url.searchParams.get('mfa') === '1';
    const resolved: TestIdpUser = { ...user, mfa };
    this.authorizations.set(state, {
      nonce,
      challenge,
      redirectUri,
      clientId,
      acrValues: url.searchParams.get('acr_values'),
      user: resolved,
    });
    const code = `code-${Buffer.from(state).toString('base64url').slice(0, 12)}-${Date.now()}`;
    this.codes.set(code, {
      request: this.authorizations.get(state) as AuthorizationRequest,
      redirectUri,
    });
    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    target.searchParams.set('state', state);
    response.statusCode = 302;
    response.setHeader('location', target.toString());
    response.end();
  }

  private async token(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.tokenErrorStatus !== null) {
      this.json(response, { error: 'temporarily_unavailable' }, this.tokenErrorStatus);
      return;
    }
    const body = await this.readBody(request);
    if (
      body.grant_type !== 'authorization_code' ||
      body.client_id !== this.clientId ||
      body.client_secret !== this.clientSecret
    ) {
      this.json(response, { error: 'invalid_client' }, 401);
      return;
    }
    const record = body.code ? this.codes.get(body.code) : undefined;
    if (!record) {
      this.json(response, { error: 'invalid_grant' }, 400);
      return;
    }
    this.codes.delete(body.code as string);
    if (body.redirect_uri !== record.redirectUri) {
      this.json(response, { error: 'invalid_grant', reason: 'redirect_uri' }, 400);
      return;
    }
    const verifier = body.code_verifier ?? '';
    const computed = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    if (computed !== record.request.challenge) {
      this.json(response, { error: 'invalid_grant', reason: 'pkce' }, 400);
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: this.issuer,
      sub: record.request.user.sub,
      aud: this.clientId,
      exp: now + 300,
      iat: now,
      nonce: record.request.nonce,
      email: record.request.user.email,
      email_verified: true,
      name: record.request.user.name,
      acr: record.request.user.mfa ? this.acrMfa : 'pwd',
      amr: record.request.user.mfa ? ['pwd', 'otp'] : ['pwd'],
    };
    this.json(response, {
      id_token: this.signIdToken(claims),
      access_token: 'test-access-token',
      token_type: 'Bearer',
      expires_in: 300,
    });
  }
}
