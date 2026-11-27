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
import { QualifiedSignatureProvider } from '../src/signature/qualified.provider';
import { SignatureProviderError } from '../src/signature/signature.provider';
import { QualifiedEspTestProvider } from './helpers/qualified-esp-test-provider';

const PASSWORD = 'Logbook!2026';
const SEED_ENTRY = '01930000-0000-7000-8000-000000000802';

const subject = {
  entityType: 'entry' as const,
  entityId: '01930000-0000-7000-8000-000000000802',
  entityVersion: 1,
  contentHash: 'a'.repeat(64),
  signerId: '01930000-0000-7000-8000-000000000102',
};

describe('qualified e-signature provider contract (test provider)', () => {
  let providerServer: QualifiedEspTestProvider;
  let endpoint: string;

  beforeEach(async () => {
    providerServer = new QualifiedEspTestProvider();
    endpoint = await providerServer.start();
  });

  afterEach(async () => {
    await providerServer.close();
  });

  it('signs and verifies through the HTTP contract', async () => {
    const provider = new QualifiedSignatureProvider(endpoint, 'test-token', 2000);
    const signature = await provider.sign(subject);

    expect(signature).toMatchObject({
      kind: 'qualified',
      algorithm: 'CMS-BES',
      keyId: 'test-uc-key-1',
      certificateSerial: '0A1B2C3D',
    });
    expect(signature.certificateSubject).toContain('Test УЦ');
    expect(signature.value.length).toBeGreaterThan(8);
    expect(providerServer.calls[0]).toMatchObject({
      operation: 'sign',
      authorization: 'Bearer test-token',
    });

    const valid = await provider.verify(subject, signature);
    expect(valid.valid).toBe(true);

    const tampered = await provider.verify(
      { ...subject, contentHash: 'b'.repeat(64) },
      signature,
    );
    expect(tampered.valid).toBe(false);
    expect(tampered.reason).toContain('mismatch');
  });

  it('maps provider HTTP errors to E-SIG-02 semantics', async () => {
    await providerServer.close();
    endpoint = await providerServer.start({ errorStatus: 503 });
    const provider = new QualifiedSignatureProvider(endpoint, 'test-token', 2000);
    await expect(provider.sign(subject)).rejects.toBeInstanceOf(
      SignatureProviderError,
    );
    await expect(provider.sign(subject)).rejects.toThrow(/HTTP 503/);
  });

  it('fails closed on invalid JSON and on timeout', async () => {
    await providerServer.close();
    endpoint = await providerServer.start({ invalidJson: true });
    const invalid = new QualifiedSignatureProvider(endpoint, 'test-token', 2000);
    await expect(invalid.sign(subject)).rejects.toThrow(/некорректный JSON/);

    await providerServer.close();
    endpoint = await providerServer.start({ delayMs: 300 });
    const slow = new QualifiedSignatureProvider(endpoint, 'test-token', 50);
    await expect(slow.sign(subject)).rejects.toThrow(/недоступен|aborted|timeout/i);
  });
});

interface TestContext {
  app: INestApplication;
  client: PgliteSqlClient;
}

describe('qualified adapter integration in the API', () => {
  let providerServer: QualifiedEspTestProvider;
  let context: TestContext;

  beforeAll(async () => {
    providerServer = new QualifiedEspTestProvider();
    const endpoint = await providerServer.start();
    process.env.SIGNATURE_PROVIDER = 'qualified';
    process.env.SIGNATURE_QUALIFIED_ENDPOINT = endpoint;
    process.env.SIGNATURE_QUALIFIED_TOKEN = 'test-token';
    process.env.SIGNATURE_QUALIFIED_TIMEOUT_MS = '2000';
    process.env.SIGNATURE_AUTO_SIGN = 'true';
  });

  afterAll(async () => {
    await providerServer.close();
    delete process.env.SIGNATURE_PROVIDER;
    delete process.env.SIGNATURE_QUALIFIED_ENDPOINT;
    delete process.env.SIGNATURE_QUALIFIED_TOKEN;
    delete process.env.SIGNATURE_QUALIFIED_TIMEOUT_MS;
    delete process.env.SIGNATURE_AUTO_SIGN;
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

  async function login(
    email: string,
  ): Promise<{ agent: SuperAgentTest; csrf: string }> {
    const agent = request.agent(context.app.getHttpServer());
    const response = await agent
      .post('/v1/auth/dev-login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return { agent: agent as unknown as SuperAgentTest, csrf: response.body.csrf_token };
  }

  it('exposes qualified info and signs a visa manually, then verifies it', async () => {
    const supervisor = await login('supervisor@logbook.local');

    const info = await supervisor.agent.get('/v1/signature/info').expect(200);
    expect(info.body).toMatchObject({
      provider: 'qualified',
      algorithm: 'CMS-BES',
      auto_sign: false,
    });
    expect(info.body.legal_note).toContain('Квалифицированная');

    // verify must NOT auto-sign with the external provider
    const verified = await supervisor.agent
      .post(`/v1/entries/${SEED_ENTRY}/verify`)
      .set({ 'X-CSRF-Token': supervisor.csrf })
      .expect(201);
    expect(verified.body.signature).toBeUndefined();

    const signature = await supervisor.agent
      .post(`/v1/entries/${SEED_ENTRY}/sign`)
      .set({ 'X-CSRF-Token': supervisor.csrf })
      .send({})
      .expect(201);
    expect(signature.body).toMatchObject({
      kind: 'qualified',
      algorithm: 'CMS-BES',
      certificate_serial: '0A1B2C3D',
      status: 'valid',
    });
    expect(signature.body.certificate_subject).toContain('Test УЦ');

    const check = await supervisor.agent
      .post(`/v1/signature/${signature.body.id}/verify`)
      .set({ 'X-CSRF-Token': supervisor.csrf })
      .expect(200);
    expect(check.body.valid).toBe(true);

    // Out-of-band tampering must fail provider verification.
    await context.client.query(
      `update journal_entries set "text" = $1 where id = $2`,
      ['Подмена после квалифицированной подписи', SEED_ENTRY],
    );
    const invalid = await supervisor.agent
      .post(`/v1/signature/${signature.body.id}/verify`)
      .set({ 'X-CSRF-Token': supervisor.csrf })
      .expect(200);
    expect(invalid.body.valid).toBe(false);
    expect(invalid.body.signature.status).toBe('invalid');
  });

  it('returns E-SIG-02 when the КЭП provider is unavailable', async () => {
    const supervisor = await login('supervisor@logbook.local');
    await supervisor.agent
      .post(`/v1/entries/${SEED_ENTRY}/verify`)
      .set({ 'X-CSRF-Token': supervisor.csrf })
      .expect(201);

    await providerServer.close();
    const failed = await supervisor.agent
      .post(`/v1/entries/${SEED_ENTRY}/sign`)
      .set({ 'X-CSRF-Token': supervisor.csrf })
      .send({})
      .expect(501);
    expect(failed.body.error.code).toBe('E-SIG-02');

    providerServer = new QualifiedEspTestProvider();
    const endpoint = await providerServer.start();
    process.env.SIGNATURE_QUALIFIED_ENDPOINT = endpoint;
  });
});
