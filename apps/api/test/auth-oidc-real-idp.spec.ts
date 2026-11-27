import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { SuperAgentTest } from 'supertest';
import { seedDatabase } from '../../../db/seed/seed';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { runMigrations } from '../src/db/migrator';
import { PgliteSqlClient } from '../src/db/pglite-client';
import { DB } from '../src/db/tokens';
import { OidcTestIdp } from './helpers/oidc-test-idp';

const PASSWORD = 'Logbook!2026';
const CLIENT_ID = 'logbook';
const CLIENT_SECRET = 'test-secret';
const REDIRECT_URI = 'http://localhost:3100/v1/auth/callback';

interface TestContext {
  app: INestApplication;
  client: PgliteSqlClient;
}

let idp: OidcTestIdp;
let context: TestContext;

beforeAll(async () => {
  idp = new OidcTestIdp(CLIENT_ID, CLIENT_SECRET, 'mfa');
  const issuer = await idp.start();
  process.env.AUTH_PROVIDER = 'oidc';
  process.env.DEV_LOGIN_ENABLED = 'false';
  process.env.OIDC_ISSUER = issuer;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_CLIENT_SECRET = CLIENT_SECRET;
  process.env.OIDC_REDIRECT_URI = REDIRECT_URI;
  process.env.OIDC_ALLOWED_ALGORITHMS = 'RS256';
  process.env.OIDC_REQUIRE_MFA_FOR_ADMIN = 'true';
  process.env.OIDC_MFA_ACR_VALUES = 'mfa';
  process.env.SIGNATURE_PROVIDER = 'none';
});

afterAll(async () => {
  await idp.stop();
  for (const key of [
    'AUTH_PROVIDER',
    'DEV_LOGIN_ENABLED',
    'OIDC_ISSUER',
    'OIDC_CLIENT_ID',
    'OIDC_CLIENT_SECRET',
    'OIDC_REDIRECT_URI',
    'OIDC_ALLOWED_ALGORITHMS',
    'OIDC_REQUIRE_MFA_FOR_ADMIN',
    'OIDC_MFA_ACR_VALUES',
    'SIGNATURE_PROVIDER',
  ]) {
    delete process.env[key];
  }
});

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

function agent(): SuperAgentTest {
  return request.agent(context.app.getHttpServer()) as unknown as SuperAgentTest;
}

/**
 * Mimics the browser: API -> IdP authorization with login+MFA -> callback.
 * Uses the real HTTP IdP harness (discovery/token/JWKS), not fetch mocks.
 */
async function loginViaIdp(
  clientAgent: SuperAgentTest,
  email: string,
  mfa: boolean,
): Promise<request.Response> {
  const start = await clientAgent
    .get('/v1/auth/authorize?redirect_after=%2F')
    .expect(302);
  const authorizeUrl = new URL(String(start.headers.location));
  authorizeUrl.searchParams.set('login', email);
  authorizeUrl.searchParams.set('mfa', mfa ? '1' : '0');

  const idpResponse = await fetch(authorizeUrl, { redirect: 'manual' });
  expect(idpResponse.status).toBe(302);
  const callback = new URL(String(idpResponse.headers.get('location')));
  const code = callback.searchParams.get('code');
  const state = callback.searchParams.get('state');
  expect(code).toEqual(expect.any(String));

  return clientAgent.get(
    `${callback.pathname}${callback.search}${callback.search ? '' : ''}`,
  );
}

describe('OIDC integration harness with a real HTTP test IdP', () => {
  it('logs in an admin with MFA, checks redirect URI and acr_values', async () => {
    const admin = agent();
    const callback = await loginViaIdp(admin, 'admin@logbook.local', true);
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe('/');

    const me = await admin.get('/v1/me').expect(200);
    expect(me.body.user.role).toBe('admin');
    expect(me.body.user.email).toBe('admin@logbook.local');
    expect(me.body.auth.provider).toBe('oidc');

    const authorization = idp.lastAuthorization();
    expect(authorization?.redirectUri).toBe(REDIRECT_URI);
    expect(authorization?.acrValues).toBe('mfa');
    expect(authorization?.challenge).toHaveLength(43);
  });

  it('rejects an admin without a second factor (E-OIDC-04)', async () => {
    const admin = agent();
    const callback = await loginViaIdp(admin, 'admin@logbook.local', false);
    expect(callback.status).toBe(302);
    expect(String(callback.headers.location)).toContain('auth_error=E-OIDC-04');
    expect(String(callback.headers.location)).toContain('/login');
    await admin.get('/v1/me').expect(401);
  });

  it('allows a non-admin user without MFA', async () => {
    const worker = agent();
    const callback = await loginViaIdp(worker, 'worker@logbook.local', false);
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe('/');
    const me = await worker.get('/v1/me').expect(200);
    expect(me.body.user.role).toBe('worker');
  });

  it('maps a token endpoint failure to E-OIDC-02', async () => {
    idp.failToken(503);
    const worker = agent();
    const callback = await loginViaIdp(worker, 'worker@logbook.local', false);
    expect(callback.status).toBe(302);
    expect(String(callback.headers.location)).toContain('auth_error=E-OIDC-02');
    await worker.get('/v1/me').expect(401);
  });
});
