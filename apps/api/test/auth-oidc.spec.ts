import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { seedDatabase } from '../../../db/seed/seed';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { runMigrations } from '../src/db/migrator';
import { PgliteSqlClient } from '../src/db/pglite-client';
import { DB } from '../src/db/tokens';

// OIDC profile for this spec: the dev provider must be unavailable.
process.env.AUTH_PROVIDER = 'oidc';
process.env.DEV_LOGIN_ENABLED = 'false';
process.env.OIDC_ISSUER = 'https://idp.test';
process.env.OIDC_CLIENT_ID = 'logbook';
process.env.OIDC_CLIENT_SECRET = 'test-client-secret';
process.env.OIDC_REDIRECT_URI = 'https://logbook.test/v1/auth/callback';
process.env.OIDC_DISPLAY_NAME = 'Тестовый IdP';
process.env.OIDC_JIT_PROVISION = 'false';
process.env.SIGNATURE_PROVIDER = 'none';

const ISSUER = 'https://idp.test';
const PASSWORD = 'Logbook!2026';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: 'jwk' });

let capturedNonce = '';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function buildIdToken(claims: Record<string, unknown>): string {
  const header = { alg: 'RS256', kid: 'idp-key-1', typ: 'JWT' };
  const encoding = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const signingInput = `${encoding(header)}.${encoding(claims)}`;
  const signature = createSign('RSA-SHA256')
    .update(signingInput, 'ascii')
    .sign(privateKey as KeyObject)
    .toString('base64url');
  return `${signingInput}.${signature}`;
}

const discovery = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
  userinfo_endpoint: `${ISSUER}/userinfo`,
  token_endpoint_auth_methods_supported: ['client_secret_post'],
  id_token_signing_alg_values_supported: ['RS256'],
};

const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : String((input as { url?: string }).url ?? '');
  if (url.endsWith('/.well-known/openid-configuration')) {
    return jsonResponse(discovery);
  }
  if (url.endsWith('/jwks')) {
    return jsonResponse({ keys: [{ ...publicJwk, kid: 'idp-key-1', use: 'sig' }] });
  }
  if (url.endsWith('/token')) {
    const body = new URLSearchParams(String(init?.body ?? ''));
    const code = body.get('code');
    const now = Math.floor(Date.now() / 1000);
    const stranger = code === 'unknown-code';
    const idToken = buildIdToken({
      iss: ISSUER,
      sub: stranger ? 'stranger-subject' : 'worker-subject',
      aud: 'logbook',
      exp: now + 300,
      iat: now,
      nonce: capturedNonce,
      email: stranger ? 'stranger@logbook.local' : 'worker@logbook.local',
      email_verified: true,
      name: stranger ? 'Неизвестный Пользователь' : 'Иванов Иван Иванович',
    });
    return jsonResponse({
      id_token: idToken,
      access_token: 'access-token',
      token_type: 'Bearer',
      expires_in: 300,
    });
  }
  if (url.endsWith('/userinfo')) {
    return jsonResponse({ sub: 'worker-subject', email: 'worker@logbook.local' });
  }
  return jsonResponse({ error: 'not_found' }, 404);
});

globalThis.fetch = fetchMock as unknown as typeof fetch;

interface TestContext {
  app: INestApplication;
  client: PgliteSqlClient;
}

let context: TestContext;

beforeEach(async () => {
  const client = new PgliteSqlClient();
  await runMigrations(client);
  await seedDatabase(client, PASSWORD);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB)
    .useValue(client)
    .compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  context = { app, client };
});

afterEach(async () => {
  await context.app.close();
  await context.client.close();
});

function cookieValue(
  setCookie: string[] | string | undefined,
  name: string,
): string | undefined {
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === 'string'
      ? [setCookie]
      : [];
  const match = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  return match?.split(';')[0]?.slice(name.length + 1);
}

async function authorize(): Promise<{
  state: string;
  stateCookie: string;
  location: URL;
}> {
  const response = await request(context.app.getHttpServer())
    .get('/v1/auth/authorize?redirect_after=%2Fjournal')
    .expect(302);
  const location = new URL(String(response.headers.location));
  return {
    location,
    state: location.searchParams.get('state') as string,
    stateCookie: cookieValue(response.headers['set-cookie'], 'lb_oidc_state') as string,
  };
}

describe('OIDC authorization code + PKCE', () => {
  it('reports oidc config and disables the dev provider', async () => {
    const config = await request(context.app.getHttpServer())
      .get('/v1/auth/config')
      .expect(200);
    expect(config.body.auth_provider).toBe('oidc');
    expect(config.body.dev_login_enabled).toBe(false);
    expect(config.body.oidc).toMatchObject({ display_name: 'Тестовый IdP' });

    const devLogin = await request(context.app.getHttpServer())
      .post('/v1/auth/dev-login')
      .send({ email: 'worker@logbook.local', password: PASSWORD })
      .expect(403);
    expect(devLogin.body.error.code).toBe('E-AUTH-02');
  });

  it('redirects to the IdP with PKCE parameters and binds state in a cookie', async () => {
    const { location, state, stateCookie } = await authorize();
    expect(location.origin).toBe(ISSUER);
    expect(location.pathname).toBe('/authorize');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('client_id')).toBe('logbook');
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://logbook.test/v1/auth/callback',
    );
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toHaveLength(43);
    expect(location.searchParams.get('nonce')).toEqual(expect.any(String));
    expect(state).toHaveLength(43);
    expect(stateCookie).toBe(state);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('completes the login by verified email, links the identity and rejects replay', async () => {
    const first = await authorize();
    capturedNonce = first.location.searchParams.get('nonce') as string;

    const callback = await request(context.app.getHttpServer())
      .get(`/v1/auth/callback?code=good-code&state=${first.state}`)
      .set('Cookie', `lb_oidc_state=${first.stateCookie}`)
      .expect(302);
    expect(callback.headers.location).toBe('/journal');
    const session = cookieValue(callback.headers['set-cookie'], 'lb_session');
    expect(session).toEqual(expect.any(String));

    const me = await request(context.app.getHttpServer())
      .get('/v1/me')
      .set('Cookie', `lb_session=${session}`)
      .expect(200);
    expect(me.body.user.email).toBe('worker@logbook.local');
    expect(me.body.user.role).toBe('worker');
    expect(me.body.auth.provider).toBe('oidc');

    const identity = await context.client.query<{ count: string }>(
      'select count(*)::text as count from user_identities where subject = $1',
      ['worker-subject'],
    );
    expect(identity.rows[0]?.count).toBe('1');

    // The state is single-use: replay must fail even with the same cookie.
    const replay = await request(context.app.getHttpServer())
      .get(`/v1/auth/callback?code=good-code&state=${first.state}`)
      .set('Cookie', `lb_oidc_state=${first.stateCookie}`)
      .expect(302);
    expect(String(replay.headers.location)).toContain('auth_error=E-OIDC-01');
  });

  it('rejects a callback whose state cookie does not match', async () => {
    const { state } = await authorize();
    const response = await request(context.app.getHttpServer())
      .get(`/v1/auth/callback?code=good-code&state=${state}`)
      .set('Cookie', 'lb_oidc_state=tampered-cookie-value')
      .expect(302);
    expect(String(response.headers.location)).toContain('auth_error=E-OIDC-01');
    expect(String(response.headers.location)).toContain('/login');
  });

  it('denies login for a user that was not provisioned (no self-registration)', async () => {
    const { state, stateCookie, location } = await authorize();
    capturedNonce = location.searchParams.get('nonce') as string;

    const response = await request(context.app.getHttpServer())
      .get(`/v1/auth/callback?code=unknown-code&state=${state}`)
      .set('Cookie', `lb_oidc_state=${stateCookie}`)
      .expect(302);
    expect(String(response.headers.location)).toContain('auth_error=E-OIDC-03');

    const users = await context.client.query<{ count: string }>(
      'select count(*)::text as count from users where lower(email) = $1',
      ['stranger@logbook.local'],
    );
    expect(users.rows[0]?.count).toBe('0');
  });
});
