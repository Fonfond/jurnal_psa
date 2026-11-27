import { createHash, createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { SuperAgentTest } from 'supertest';
import { SEED_UUIDS } from '@logbook/shared';
import { seedDatabase } from '../../../db/seed/seed';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { loadEnv } from '../src/config/env';
import { runMigrations } from '../src/db/migrator';
import { PgliteSqlClient } from '../src/db/pglite-client';
import { DB } from '../src/db/tokens';

process.env.PERMIT_VISIBILITY_MODE = 'participant';
process.env.PERMIT_PDF_SECRET = 'test-permit-pdf-secret-0123456789abcdef';
process.env.PERMIT_PDF_TTL_SECONDS = '900';
loadEnv(true);

const PASSWORD = 'Logbook!2026';
const ACTIVE_PERMIT = SEED_UUIDS.permitActive;
const ANNULLED_PERMIT = SEED_UUIDS.permitAnnulled;
const PDF_SECRET = process.env.PERMIT_PDF_SECRET!;

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
  return {
    agent: agent as unknown as SuperAgentTest,
    csrf: response.body.csrf_token as string,
  };
}

function auth(csrf: string): Record<string, string> {
  return { 'X-CSRF-Token': csrf };
}

function binaryParser(
  response: NodeJS.ReadableStream & { on: (event: string, listener: (...args: never[]) => void) => void },
  callback: (error: Error | null, body?: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  response.on('data', ((chunk: Buffer) => chunks.push(chunk)) as never);
  response.on('end', (() => callback(null, Buffer.concat(chunks))) as never);
  response.on('error', ((error: Error) => callback(error)) as never);
}

function forgeToken(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const signature = createHmac('sha256', PDF_SECRET)
    .update(body)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${body}.${signature}`;
}

function tokenOf(url: string): string {
  const parsed = new URL(url, 'http://localhost');
  return parsed.searchParams.get('token') ?? '';
}

beforeEach(async () => {
  context = await createContext();
});

afterEach(async () => {
  await context.app.close();
  await context.client.close();
});

afterAll(() => {
  delete process.env.PERMIT_VISIBILITY_MODE;
  delete process.env.PERMIT_PDF_SECRET;
  delete process.env.PERMIT_PDF_TTL_SECONDS;
  loadEnv(true);
});

describe('permit PDF and signed URL (OQ-03)', () => {
  it('generates a deterministic PDF, serves it through a signed URL and audits access', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const admin = await login(context.app, 'admin@logbook.local');

    const link = await worker.agent
      .post(`/v1/permits/${ACTIVE_PERMIT}/pdf-url`)
      .set(auth(worker.csrf))
      .expect(200);
    expect(link.body).toMatchObject({
      source: 'generated',
      permit_id: ACTIVE_PERMIT,
    });
    expect(link.body.url).toContain(`/v1/permits/pdf/${ACTIVE_PERMIT}`);
    expect(link.body.expires_at).toEqual(expect.any(String));
    expect(link.body.hash).toHaveLength(64);
    expect(link.body.size_bytes).toBeGreaterThan(10_000);
    expect(link.body.deep_link).toBe(
      'https://permits.example.local/123',
    );

    const stored = await context.client.query<{
      pdf_hash: string;
      pdf_size_bytes: number;
      pdf_source: string;
      pdf_generated_at: string;
    }>(
      'select pdf_hash, pdf_size_bytes, pdf_source, pdf_generated_at from permits where id = $1',
      [ACTIVE_PERMIT],
    );
    expect(stored.rows[0]).toMatchObject({
      pdf_hash: link.body.hash,
      pdf_size_bytes: link.body.size_bytes,
      pdf_source: 'generated',
    });
    expect(stored.rows[0]?.pdf_generated_at).toBeTruthy();

    const download = await worker.agent
      .get(link.body.url as string)
      .buffer(true)
      .parse(binaryParser as never)
      .expect(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect(download.headers['x-content-sha256']).toBe(link.body.hash);
    expect(download.headers['content-disposition']).toContain('attachment');
    const pdf = download.body as Buffer;
    expect(pdf.length).toBe(link.body.size_bytes);
    expect(pdf.subarray(0, 8).toString()).toBe('%PDF-1.4');
    expect(createHash('sha256').update(pdf).digest('hex')).toBe(link.body.hash);
    expect(pdf.toString('latin1')).toContain('/CIDFontType2');
    expect(pdf.toString('latin1')).toContain('Identity-H');

    // Re-issuing the link keeps the document deterministic.
    const repeated = await worker.agent
      .post(`/v1/permits/${ACTIVE_PERMIT}/pdf-url`)
      .set(auth(worker.csrf))
      .expect(200);
    expect(repeated.body.hash).toBe(link.body.hash);
    expect(repeated.body.size_bytes).toBe(link.body.size_bytes);

    const auditUrl = await admin.agent
      .get('/v1/audit?action=permit.pdf_url&limit=10')
      .expect(200);
    expect(
      auditUrl.body.items.some(
        (item: { entity_id: string }) => item.entity_id === ACTIVE_PERMIT,
      ),
    ).toBe(true);
    const auditDownload = await admin.agent
      .get('/v1/audit?action=permit.pdf_download&limit=10')
      .expect(200);
    expect(auditDownload.body.items.length).toBeGreaterThan(0);
  });

  it('rejects tampered, expired and stale signed links', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const link = await worker.agent
      .post(`/v1/permits/${ACTIVE_PERMIT}/pdf-url`)
      .set(auth(worker.csrf))
      .expect(200);
    const token = tokenOf(link.body.url as string);

    const tampered = `${token.slice(0, -4)}AAAA`;
    await worker.agent
      .get(`/v1/permits/pdf/${ACTIVE_PERMIT}?token=${encodeURIComponent(tampered)}`)
      .expect(403);

    const expired = forgeToken({
      p: ACTIVE_PERMIT,
      e: Date.now() - 60_000,
      v: 1,
      s: 'generated',
    });
    const expiredResponse = await worker.agent
      .get(`/v1/permits/pdf/${ACTIVE_PERMIT}?token=${encodeURIComponent(expired)}`)
      .expect(403);
    expect(expiredResponse.body.error.message).toContain('истёк');

    // A token for one permit cannot be replayed for another.
    await worker.agent
      .get(`/v1/permits/pdf/${ANNULLED_PERMIT}?token=${encodeURIComponent(token)}`)
      .expect(403);

    // The link is bound to the permit version.
    await context.client.query(
      'update permits set version = version + 1 where id = $1',
      [ACTIVE_PERMIT],
    );
    const stale = await worker.agent
      .get(`/v1/permits/pdf/${ACTIVE_PERMIT}?token=${encodeURIComponent(token)}`)
      .expect(400);
    expect(stale.body.error.code).toBe('E-VAL-01');

    await request(context.app.getHttpServer())
      .get(`/v1/permits/pdf/${ACTIVE_PERMIT}?token=${encodeURIComponent(token)}`)
      .expect(401);
  });

  it('redirects a signed link to the external PDF deep link when the source provides one', async () => {
    const admin = await login(context.app, 'admin@logbook.local');
    const externalPdf = 'https://permits.example.local/files/nd-123.pdf';
    await context.client.query(
      `update permits
          set pdf_url = $1, pdf_hash = null, pdf_size_bytes = null,
              pdf_generated_at = null, pdf_source = 'none'
        where id = $2`,
      [externalPdf, ACTIVE_PERMIT],
    );

    const link = await admin.agent
      .post(`/v1/permits/${ACTIVE_PERMIT}/pdf-url`)
      .set(auth(admin.csrf))
      .expect(200);
    expect(link.body.source).toBe('external');
    expect(link.body.pdf_url).toBe(externalPdf);
    expect(link.body.deep_link).toBe('https://permits.example.local/123');
    expect(link.body.hash).toHaveLength(64);

    const redirect = await admin.agent
      .get(link.body.url as string)
      .redirects(0)
      .expect(302);
    expect(redirect.headers.location).toBe(externalPdf);
  });

  it('imports an external JSON source idempotently with PDF deep links', async () => {
    const admin = await login(context.app, 'admin@logbook.local');
    const record = {
      external_id: 'EXT-PDF-1',
      number: 'НД-777/2026',
      year: 2026,
      type: 'permit_to_work',
      status: 'active',
      valid_from: '2026-12-01',
      valid_to: '2026-12-31',
      site_code: 'SITE-01',
      description: 'Работы по внешнему наряду с PDF',
      responsible_login: 'supervisor@logbook.local',
      external_url: 'https://permits.example.local/777',
      pdf_url: 'https://permits.example.local/files/777.pdf',
      pdf_hash: 'b'.repeat(64),
    };

    const first = await admin.agent
      .post('/v1/admin/permits/import')
      .set(auth(admin.csrf))
      .send({ source_id: 'external-json', records: [record] })
      .expect(201);
    expect(first.body.errors).toEqual([]);
    expect(first.body).toMatchObject({ imported: 1, updated: 0, skipped: 0 });

    const second = await admin.agent
      .post('/v1/admin/permits/import')
      .set(auth(admin.csrf))
      .send({ source_id: 'external-json', records: [record] })
      .expect(201);
    expect(second.body).toMatchObject({ imported: 0, updated: 1, skipped: 0 });

    const permits = await context.client.query<{
      id: string;
      pdf_url: string;
      pdf_hash: string;
      pdf_source: string;
      external_url: string;
    }>(
      `select id, pdf_url, pdf_hash, pdf_source, external_url
         from permits where source_id = 'external-json' and external_id = 'EXT-PDF-1'`,
    );
    expect(permits.rows).toHaveLength(1);
    expect(permits.rows[0]).toMatchObject({
      pdf_url: record.pdf_url,
      pdf_hash: record.pdf_hash,
      pdf_source: 'external',
      external_url: record.external_url,
    });

    const link = await admin.agent
      .post(`/v1/permits/${permits.rows[0]!.id}/pdf-url`)
      .set(auth(admin.csrf))
      .expect(200);
    expect(link.body.source).toBe('external');
    expect(link.body.pdf_url).toBe(record.pdf_url);

    // Invalid record is reported per row and does not abort the import.
    const invalid = await admin.agent
      .post('/v1/admin/permits/import')
      .set(auth(admin.csrf))
      .send({ source_id: 'external-json', records: [{ external_id: 'BROKEN' }] })
      .expect(201);
    expect(invalid.body.skipped).toBe(1);
    expect(invalid.body.errors[0].row).toBe(2);

    await admin.agent
      .post('/v1/admin/permits/import')
      .set(auth(admin.csrf))
      .send({ source_id: 'external-json' })
      .expect(400);

    const imports = await admin.agent.get('/v1/admin/imports').expect(200);
    expect(imports.body.items.length).toBeGreaterThanOrEqual(3);
  });
});
