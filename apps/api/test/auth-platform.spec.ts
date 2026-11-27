import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { SuperAgentTest } from 'supertest';
import { uuidv7 } from '@logbook/shared';
import { seedDatabase } from '../../../db/seed/seed';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { parseEnv } from '../src/config/env';
import { type Jwk, verifyIdToken } from '../src/auth/oidc/jwt';
import { codeChallenge } from '../src/auth/oidc/pkce';
import { runMigrations } from '../src/db/migrator';
import { PgliteSqlClient } from '../src/db/pglite-client';
import { DB } from '../src/db/tokens';

// The auth-platform integration tests exercise the `simple` signature adapter.
process.env.SIGNATURE_PROVIDER = 'simple';
process.env.SIGNATURE_SECRET = 'test-signature-secret-0123456789abcdef';
process.env.SIGNATURE_KEY_ID = 'test-key-v1';
process.env.SIGNATURE_AUTO_SIGN = 'true';
process.env.AUTH_PROVIDER = 'dev';
process.env.DEV_LOGIN_ENABLED = 'true';

const PASSWORD = 'Logbook!2026';
const SEED_ENTRY_WORKER = '01930000-0000-7000-8000-000000000801';
const SEED_ENTRY_PLAIN = '01930000-0000-7000-8000-000000000802';
const SIMPLE_WORK_TYPE = '01930000-0000-7000-8000-000000000302';
const FIELD_SITE = '01930000-0000-7000-8000-000000000402';
const INSTALL_ID = 'install-e2e-0001';

interface TestContext {
  app: INestApplication;
  client: PgliteSqlClient;
}

let context: TestContext;

async function createContext(): Promise<TestContext> {
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

  return { app, client };
}

async function login(
  app: INestApplication,
  email: string,
): Promise<{ agent: SuperAgentTest; csrf: string }> {
  const agent = request.agent(app.getHttpServer());
  const response = await agent
    .post('/v1/auth/dev-login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return { agent: agent as unknown as SuperAgentTest, csrf: response.body.csrf_token };
}

function entryOp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    op_id: uuidv7(),
    entity_type: 'entry',
    entity_id: (overrides.entity_id as string | undefined) ?? uuidv7(),
    op_type: 'create',
    base_version: null,
    hlc: '1795000001000:00001:authtest',
    client_time: '2026-11-24T12:00:00.000Z',
    payload: {
      performed_at: '2026-11-24T11:55:00.000Z',
      performed_tz_offset_min: 180,
      work_type_id: SIMPLE_WORK_TYPE,
      site_id: FIELD_SITE,
      text: 'Проверка устройства и подписи',
      input_method: 'manual',
    },
    ...overrides,
  };
}

beforeEach(async () => {
  context = await createContext();
});

afterEach(async () => {
  await context.app.close();
  await context.client.close();
});

describe('environment validation', () => {
  const production = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://logbook:logbook@localhost:5432/logbook',
    AUTH_PROVIDER: 'oidc',
    DEV_LOGIN_ENABLED: 'false',
    COOKIE_SECRET: 'p'.repeat(48),
    OIDC_ISSUER: 'https://idp.example.com',
    OIDC_CLIENT_ID: 'logbook',
    OIDC_REDIRECT_URI: 'https://logbook.example.com/v1/auth/callback',
  };

  it('accepts a complete production OIDC profile', () => {
    const env = parseEnv(production);
    expect(env.AUTH_PROVIDER).toBe('oidc');
    expect(env.SIGNATURE_PROVIDER).toBe('none');
    expect(env.DEV_LOGIN_ENABLED).toBe(false);
  });

  it('requires DATABASE_URL in production (no silent PGlite/in-memory fallback)', () => {
    const { DATABASE_URL: _url, ...withoutDatabase } = production;
    expect(() => parseEnv(withoutDatabase)).toThrow(/DATABASE_URL/);
    expect(() =>
      parseEnv({ ...withoutDatabase, PGLITE_DIR: '.data/pglite' }),
    ).toThrow(/DATABASE_URL/);
    expect(() => parseEnv({ ...production, DATABASE_URL: '' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('keeps PGlite allowed in development and test without DATABASE_URL', () => {
    const base = {
      COOKIE_SECRET: 'l'.repeat(32),
      AUTH_PROVIDER: 'dev',
      DEV_LOGIN_ENABLED: 'true',
      PGLITE_DIR: '.data/pglite',
    };
    expect(parseEnv({ ...base, NODE_ENV: 'development' }).PGLITE_DIR).toBe(
      '.data/pglite',
    );
    expect(parseEnv({ ...base, NODE_ENV: 'test' }).DATABASE_URL).toBeUndefined();
  });

  it('rejects dev auth in production', () => {
    expect(() => parseEnv({ ...production, AUTH_PROVIDER: 'dev' })).toThrow(
      /AUTH_PROVIDER/,
    );
  });

  it('rejects the default cookie secret and dev-login in production', () => {
    expect(() =>
      parseEnv({ ...production, COOKIE_SECRET: 'dev-only-change-me' }),
    ).toThrow(/COOKIE_SECRET/);
    expect(() => parseEnv({ ...production, DEV_LOGIN_ENABLED: 'true' })).toThrow(
      /DEV_LOGIN_ENABLED/,
    );
  });

  it('requires an https issuer and a JIT department when JIT is on', () => {
    expect(() =>
      parseEnv({ ...production, OIDC_ISSUER: 'http://idp.example.com' }),
    ).toThrow(/OIDC_ISSUER/);
    expect(() =>
      parseEnv({ ...production, OIDC_JIT_PROVISION: 'true' }),
    ).toThrow(/OIDC_JIT_DEPARTMENT_ID/);
  });

  it('fails closed for simple/qualified signature adapters without secrets', () => {
    expect(() =>
      parseEnv({ ...production, SIGNATURE_PROVIDER: 'simple' }),
    ).toThrow(/SIGNATURE_SECRET/);
    expect(() =>
      parseEnv({ ...production, SIGNATURE_PROVIDER: 'simple', SIGNATURE_SECRET: 'short' }),
    ).toThrow(/SIGNATURE_SECRET/);
    expect(() =>
      parseEnv({ ...production, SIGNATURE_PROVIDER: 'qualified' }),
    ).toThrow(/SIGNATURE_QUALIFIED_ENDPOINT/);
    expect(() =>
      parseEnv({ ...production, SIGNATURE_PROVIDER: 'none' }),
    ).not.toThrow();
  });

  it('enforces AUTH-04 production security gates', () => {
    expect(() =>
      parseEnv({ ...production, RATE_LIMIT_ENABLED: 'false' }),
    ).toThrow(/RATE_LIMIT_ENABLED/);
    expect(() =>
      parseEnv({ ...production, SESSION_IDLE_MINUTES: '240' }),
    ).toThrow(/SESSION_IDLE_MINUTES/);
    expect(() =>
      parseEnv({ ...production, HSTS_MAX_AGE_SECONDS: '60' }),
    ).toThrow(/HSTS_MAX_AGE_SECONDS/);
    expect(() =>
      parseEnv({ ...production, AUTH_RATE_LIMIT_MAX: '1000' }),
    ).toThrow(/AUTH_RATE_LIMIT_MAX/);
    expect(() =>
      parseEnv({ ...production, OIDC_REQUIRE_MFA_FOR_ADMIN: 'false' }),
    ).toThrow(/OIDC_REQUIRE_MFA_FOR_ADMIN/);
    expect(() =>
      parseEnv({ ...production, LOADTEST_RATE_LIMIT_DISABLED: 'true' }),
    ).toThrow(/LOADTEST_RATE_LIMIT_DISABLED/);
  });

  it('rejects oidc without client configuration', () => {
    expect(() =>
      parseEnv({ ...production, OIDC_CLIENT_ID: undefined }),
    ).toThrow(/OIDC_CLIENT_ID/);
  });
});

describe('PKCE and id_token verification', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

  it('computes the RFC 7636 S256 challenge', () => {
    expect(codeChallenge(verifier)).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const publicJwk = publicKey.export({ format: 'jwk' });

  function signJwt(payload: Record<string, unknown>): string {
    const header = { alg: 'RS256', kid: 'test-kid', typ: 'JWT' };
    const encode = (value: unknown): string =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    const signingInput = `${encode(header)}.${encode(payload)}`;
    const signature = createSign('RSA-SHA256')
      .update(signingInput, 'ascii')
      .sign(privateKey as KeyObject)
      .toString('base64url');
    return `${signingInput}.${signature}`;
  }

  function baseClaims(): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: 'https://idp.test',
      sub: 'subject-1',
      aud: 'logbook',
      exp: now + 300,
      iat: now,
      nonce: 'nonce-1',
      email: 'worker@logbook.local',
    };
  }

  const jwks = {
    keys: [{ ...publicJwk, kid: 'test-kid', use: 'sig' }] as unknown as Jwk[],
  };
  const options = {
    issuer: 'https://idp.test',
    audience: 'logbook',
    allowedAlgorithms: ['RS256'],
    clockSkewSeconds: 60,
    expectedNonce: 'nonce-1',
  };

  it('accepts a correctly signed id_token', () => {
    const claims = verifyIdToken(signJwt(baseClaims()), jwks, options);
    expect(claims.sub).toBe('subject-1');
  });

  it('rejects tampering, wrong nonce, wrong audience and expiry', () => {
    const token = signJwt(baseClaims());
    const [header, payload, signature] = token.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...baseClaims(), sub: 'attacker' }),
      'utf8',
    ).toString('base64url');
    expect(() =>
      verifyIdToken(`${header}.${tamperedPayload}.${signature}`, jwks, options),
    ).toThrow(/Подпись/);

    expect(() =>
      verifyIdToken(signJwt({ ...baseClaims(), nonce: 'other' }), jwks, options),
    ).toThrow(/nonce/);
    expect(() =>
      verifyIdToken(signJwt({ ...baseClaims(), aud: 'another' }), jwks, options),
    ).toThrow(/audience/);
    expect(() =>
      verifyIdToken(
        signJwt({ ...baseClaims(), exp: Math.floor(Date.now() / 1000) - 600 }),
        jwks,
        options,
      ),
    ).toThrow(/истёк/);
    expect(() =>
      verifyIdToken(
        signJwt(baseClaims()),
        jwks,
        { ...options, allowedAlgorithms: ['PS256'] },
      ),
    ).toThrow(/не разрешён/);
  });
});

describe('device registration', () => {
  it('registers idempotently, returns the key once and binds the session', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const headers = { 'X-CSRF-Token': worker.csrf };

    const first = await worker.agent
      .post('/v1/devices')
      .set(headers)
      .send({
        install_id: INSTALL_ID,
        name: 'E2E device',
        platform: 'Linux',
        app_version: '0.2.0',
      })
      .expect(201);
    const deviceId = first.body.device.id as string;
    const deviceKey = first.body.device_key as string;
    expect(first.body.device.install_id).toBe(INSTALL_ID);
    expect(first.body.device.status).toBe('active');
    expect(first.body.device.device_key_set).toBe(true);
    expect(deviceKey).toMatch(/^[0-9a-f]{64}$/);

    const repeated = await worker.agent
      .post('/v1/devices')
      .set(headers)
      .send({ install_id: INSTALL_ID })
      .expect(201);
    expect(repeated.body.device.id).toBe(deviceId);
    expect(repeated.body.device_key).toBeUndefined();

    const rotated = await worker.agent
      .post('/v1/devices')
      .set(headers)
      .send({ install_id: INSTALL_ID, rotate_key: true })
      .expect(201);
    expect(rotated.body.device.id).toBe(deviceId);
    expect(rotated.body.device_key).toEqual(expect.any(String));
    expect(rotated.body.device_key).not.toBe(deviceKey);
  });

  it('rejects push without the device key, accepts it with the key, then revokes the session', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const headers = { 'X-CSRF-Token': worker.csrf };

    const registration = await worker.agent
      .post('/v1/devices')
      .set(headers)
      .send({ install_id: INSTALL_ID, platform: 'Linux', app_version: '0.2.0' })
      .expect(201);
    const deviceId = registration.body.device.id as string;
    const deviceKey = registration.body.device_key as string;

    const pushBody = (): Record<string, unknown> => ({
      device_id: deviceId,
      app_version: '0.2.0',
      ops: [entryOp()],
    });

    const withoutKey = await worker.agent
      .post('/v1/sync/push')
      .set(headers)
      .send(pushBody())
      .expect(403);
    expect(withoutKey.body.error.code).toBe('E-AUTH-02');

    const wrongKey = await worker.agent
      .post('/v1/sync/push')
      .set({ ...headers, 'X-Device-Key': 'f'.repeat(64) })
      .send(pushBody())
      .expect(403);
    expect(wrongKey.body.error.message).toContain('Ключ устройства');

    await worker.agent
      .post('/v1/sync/push')
      .set({ ...headers, 'X-Device-Key': deviceKey })
      .send(pushBody())
      .expect(200);

    const list = await worker.agent.get('/v1/devices').expect(200);
    expect(
      list.body.items.some(
        (device: { id: string; status: string }) =>
          device.id === deviceId && device.status === 'active',
      ),
    ).toBe(true);

    const revoked = await worker.agent
      .delete(`/v1/devices/${deviceId}`)
      .set(headers)
      .expect(200);
    expect(revoked.body.revoked_sessions).toBeGreaterThanOrEqual(1);

    // The session was bound to the device at registration.
    await worker.agent.get('/v1/me').expect(401);
  });

  it('does not let another user revoke a device', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const admin = await login(context.app, 'admin@logbook.local');

    const registration = await worker.agent
      .post('/v1/devices')
      .set({ 'X-CSRF-Token': worker.csrf })
      .send({ install_id: INSTALL_ID })
      .expect(201);
    const deviceId = registration.body.device.id as string;

    const supervisor = await login(context.app, 'supervisor@logbook.local');
    await supervisor.agent
      .delete(`/v1/devices/${deviceId}`)
      .set({ 'X-CSRF-Token': supervisor.csrf })
      .expect(403);

    // Admins may revoke foreign devices.
    await admin.agent
      .delete(`/v1/devices/${deviceId}`)
      .set({ 'X-CSRF-Token': admin.csrf })
      .expect(200);
  });
});

describe('signature abstraction (simple adapter)', () => {
  it('auto-signs a visa, exposes it and verifies integrity', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const supervisor = await login(context.app, 'supervisor@logbook.local');

    const info = await supervisor.agent.get('/v1/signature/info').expect(200);
    expect(info.body).toMatchObject({
      provider: 'simple',
      algorithm: 'HMAC-SHA256',
      auto_sign: true,
    });
    expect(info.body.legal_note).toContain('Не является КЭП');

    const verified = await supervisor.agent
      .post(`/v1/entries/${SEED_ENTRY_WORKER}/verify`)
      .set({ 'X-CSRF-Token': supervisor.csrf })
      .expect(201);
    expect(verified.body.signature).toMatchObject({
      entity_type: 'entry',
      kind: 'simple',
      algorithm: 'HMAC-SHA256',
      status: 'valid',
    });
    expect(verified.body.signature.content_hash).toHaveLength(64);

    const detail = await worker.agent
      .get(`/v1/entries/${SEED_ENTRY_WORKER}`)
      .expect(200);
    expect(detail.body.signatures).toHaveLength(1);
    const signatureId = detail.body.signatures[0].id as string;

    const check = await supervisor.agent
      .post(`/v1/signature/${signatureId}/verify`)
      .set({ 'X-CSRF-Token': supervisor.csrf })
      .expect(200);
    expect(check.body.valid).toBe(true);

    // Out-of-band tampering breaks the content hash.
    await context.client.query(
      `update journal_entries set "text" = $1 where id = $2`,
      ['Подмена текста после подписания', SEED_ENTRY_WORKER],
    );
    const invalid = await supervisor.agent
      .post(`/v1/signature/${signatureId}/verify`)
      .set({ 'X-CSRF-Token': supervisor.csrf })
      .expect(200);
    expect(invalid.body.valid).toBe(false);
    expect(invalid.body.signature.status).toBe('invalid');
  });

  it('rejects signing an unverified entry and revokes a visa on unverify', async () => {
    const supervisor = await login(context.app, 'supervisor@logbook.local');

    const unverified = await supervisor.agent
      .post(`/v1/entries/${SEED_ENTRY_PLAIN}/sign`)
      .set({ 'X-CSRF-Token': supervisor.csrf })
      .send({})
      .expect(400);
    expect(unverified.body.error.code).toBe('E-VAL-01');

    await supervisor.agent
      .post(`/v1/entries/${SEED_ENTRY_PLAIN}/verify`)
      .set({ 'X-CSRF-Token': supervisor.csrf })
      .expect(201);

    await supervisor.agent
      .post(`/v1/entries/${SEED_ENTRY_PLAIN}/unverify`)
      .set({ 'X-CSRF-Token': supervisor.csrf })
      .send({ comment: 'Нужно уточнение' })
      .expect(201);

    const detail = await supervisor.agent
      .get(`/v1/entries/${SEED_ENTRY_PLAIN}`)
      .expect(200);
    expect(detail.body.signatures[0].status).toBe('revoked');
  });

  it('signs journal reviews and enforces the author-only rule', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const supervisor = await login(context.app, 'supervisor@logbook.local');

    const review = await supervisor.agent
      .post('/v1/journal/reviews')
      .set({ 'X-CSRF-Token': supervisor.csrf })
      .send({ period_start: '2026-11-01', period_end: '2026-11-30' })
      .expect(201);
    expect(review.body.signature.kind).toBe('simple');
    expect(review.body.content_hash).toHaveLength(64);

    const signatures = await supervisor.agent
      .get(`/v1/journal/reviews/${review.body.id}/signatures`)
      .expect(200);
    expect(signatures.body.items).toHaveLength(1);

    await worker.agent
      .post(`/v1/journal/reviews/${review.body.id}/sign`)
      .set({ 'X-CSRF-Token': worker.csrf })
      .send({})
      .expect(403);

    // Manual signing is idempotent for the same review version.
    const manual = await supervisor.agent
      .post(`/v1/journal/reviews/${review.body.id}/sign`)
      .set({ 'X-CSRF-Token': supervisor.csrf })
      .send({ reason: 'повторная подпись' })
      .expect(201);
    expect(manual.body.id).toBe(signatures.body.items[0].id);
  });
});
