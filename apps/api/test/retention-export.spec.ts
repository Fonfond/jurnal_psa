import { createHmac } from 'node:crypto';
import { hashSync } from 'bcryptjs';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { SuperAgentTest } from 'supertest';
import { DEFAULT_JOURNAL_ID, SEED_UUIDS } from '@logbook/shared';
import { seedDatabase } from '../../../db/seed/seed';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { loadEnv } from '../src/config/env';
import { runMigrations } from '../src/db/migrator';
import { PgliteSqlClient } from '../src/db/pglite-client';
import { DB } from '../src/db/tokens';

process.env.SIGNATURE_PROVIDER = 'simple';
process.env.SIGNATURE_SECRET = 'test-signature-secret-0123456789abcdef';
process.env.SIGNATURE_KEY_ID = 'test-key-v1';
process.env.SIGNATURE_AUTO_SIGN = 'true';
process.env.EXPORT_SIGNING_SECRET = 'test-export-secret-0123456789abcdef';
process.env.EXPORT_URL_TTL_SECONDS = '900';
loadEnv(true);

const PASSWORD = 'Logbook!2026';
const EXPORT_SECRET = process.env.EXPORT_SIGNING_SECRET!;
const JOURNAL = DEFAULT_JOURNAL_ID;
const WORK_TYPE = SEED_UUIDS.workTypeSimple;
const SITE = SEED_UUIDS.siteField;

interface TestContext {
  app: INestApplication;
  client: PgliteSqlClient;
}

let context: TestContext;

async function createContext(): Promise<TestContext> {
  const client = new PgliteSqlClient();
  await runMigrations(client);
  await seedDatabase(client, PASSWORD);
  await client.query(
    `insert into users
       (id, external_id, full_name, email, role, department_id, position, status)
     values ('01930000-0000-7000-8000-000000000105', 'ext-auditor',
             'Аудитор Смирнова Ольга', 'auditor@logbook.local',
             'auditor'::user_role_enum, $1, 'Аудитор', 'active'::user_status_enum)`,
    [SEED_UUIDS.departmentMain],
  );
  await client.query(
    'insert into user_credentials (user_id, password_hash) values ($1, $2)',
    ['01930000-0000-7000-8000-000000000105', hashSync(PASSWORD, 10)],
  );

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
  response: NodeJS.ReadableStream & {
    on: (event: string, listener: (...args: never[]) => void) => void;
  },
  callback: (error: Error | null, body?: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  response.on('data', ((chunk: Buffer) => chunks.push(chunk)) as never);
  response.on('end', (() => callback(null, Buffer.concat(chunks))) as never);
  response.on('error', ((error: Error) => callback(error)) as never);
}

function tokenOf(url: string): string {
  return new URL(url, 'http://localhost').searchParams.get('token') ?? '';
}

function forgeToken(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const signature = createHmac('sha256', EXPORT_SECRET)
    .update(body)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${body}.${signature}`;
}

async function insertEntry(
  performedAt: string,
  id: string,
): Promise<void> {
  await context.client.query(
    `insert into journal_entries
       (id, author_id, performed_at, performed_tz_offset_min, performed_at_source,
        work_type_id, site_id, "text", input_method, hlc, created_at_client,
        updated_at_client, journal_id)
     values ($1, $2, $3::timestamptz, 180, 'manual'::performed_source_enum,
             $4, $5, 'Тестовая запись для проверки retention', 'manual'::input_method_enum,
             '1795000000999:00001:ret0001', $3::timestamptz, $3::timestamptz, $6)`,
    [id, SEED_UUIDS.worker, performedAt, WORK_TYPE, SITE, JOURNAL],
  );
}

beforeEach(async () => {
  context = await createContext();
});

afterEach(async () => {
  await context.app.close();
  await context.client.close();
});

afterAll(() => {
  delete process.env.EXPORT_SIGNING_SECRET;
  delete process.env.EXPORT_URL_TTL_SECONDS;
  loadEnv(true);
});

describe('retention, audit verification and backup hooks (JRN-04)', () => {
  it('reports the 3-year policy, runs a check and detects a broken audit chain', async () => {
    const admin = await login(context.app, 'admin@logbook.local');
    const auditor = await login(context.app, 'auditor@logbook.local');

    const report = await admin.agent
      .get('/v1/admin/retention')
      .expect(200);
    expect(report.body).toMatchObject({
      policy_years: 3,
      cutoff: expect.any(String),
    });
    expect(report.body.journal_entries.total).toBe(5);
    expect(report.body.runs).toEqual([]);
    expect(report.body.checkpoints).toEqual([]);

    const run = await admin.agent
      .post('/v1/admin/retention/run')
      .set(auth(admin.csrf))
      .send({ now: '2029-11-25T00:00:00.000Z' })
      .expect(201);
    expect(run.body.report.policy_years).toBe(3);
    expect(run.body.report.cutoff).toBe('2026-11-25');
    expect(run.body.report.journal_entries.before_cutoff).toBe(5);
    expect(run.body.audit_verification.ok).toBe(true);

    const after = await admin.agent.get('/v1/admin/retention').expect(200);
    expect(after.body.runs.length).toBeGreaterThanOrEqual(1);
    expect(after.body.runs[0]).toMatchObject({
      policy_years: 3,
      audit_ok: true,
    });

    const verify = await admin.agent
      .get('/v1/admin/audit/verify')
      .expect(200);
    expect(verify.body).toMatchObject({ ok: true, events_checked: expect.any(Number) });
    expect(verify.body.streams_checked).toBeGreaterThanOrEqual(1);

    // Auditor may read the report and verify the chain, but not run mutations.
    await auditor.agent.get('/v1/admin/retention').expect(200);
    await auditor.agent.get('/v1/admin/audit/verify').expect(200);
    await auditor.agent
      .post('/v1/admin/retention/run')
      .set(auth(auditor.csrf))
      .send({})
      .expect(403);

    // Tamper with one audit hash: the daily verification must notice it.
    await context.client.query(
      `update audit_events
          set hash = $1
        where stream_seq = 1`,
      ['f'.repeat(64)],
    );
    const broken = await admin.agent
      .get('/v1/admin/audit/verify')
      .expect(200);
    expect(broken.body.ok).toBe(false);
    expect(broken.body.broken[0]).toMatchObject({ reason: 'hash mismatch' });
  });

  it('blocks hard deletion of recent entries and allows old ones', async () => {
    const recent = '01930000-0000-7000-8000-00000000aa01';
    const old = '01930000-0000-7000-8000-00000000aa02';
    await insertEntry('2026-11-20T08:00:00.000Z', recent);
    await insertEntry('2019-01-01T08:00:00.000Z', old);

    await expect(
      context.client.query('delete from journal_entries where id = $1', [recent]),
    ).rejects.toThrow(/retention/);

    await expect(
      context.client.query('delete from journal_entries where id = $1', [old]),
    ).resolves.toBeDefined();
  });
});

describe('WORM journal export with 3-column PDF and signed URL (JRN-07)', () => {
  it('generates PDF/CSV, signs the PDF and serves it through a signed URL', async () => {
    const admin = await login(context.app, 'admin@logbook.local');

    const created = await admin.agent
      .post('/v1/journal/exports')
      .set(auth(admin.csrf))
      .send({ journal_id: JOURNAL, from: '2026-11-01', to: '2026-11-30' })
      .expect(201);
    const exportId = created.body.id as string;
    expect(created.body).toMatchObject({
      status: 'done',
      type: 'journal_pdf',
      entries_count: 4,
      worm: true,
    });
    expect(created.body.file_sha256).toHaveLength(64);
    expect(created.body.file_size_bytes).toBeGreaterThan(10_000);
    expect(created.body.csv_sha256).toHaveLength(64);
    expect(created.body.svg_sha256).toBeUndefined();
    expect(created.body.manifest_hash).toHaveLength(64);
    expect(created.body.manifest.files.pdf.sha256).toBe(created.body.file_sha256);
    expect(created.body.manifest.files.csv.sha256).toBe(created.body.csv_sha256);
    expect(created.body.manifest.entries_count).toBe(4);
    expect(created.body.signature).not.toBeNull();

    const details = await admin.agent
      .get(`/v1/journal/exports/${exportId}`)
      .expect(200);
    expect(details.body.id).toBe(exportId);
    expect(details.body.manifest_hash).toBeUndefined();
    expect(details.body.file_sha256).toBe(created.body.file_sha256);

    const pdfUrl = await admin.agent
      .post(`/v1/exports/${exportId}/url`)
      .set(auth(admin.csrf))
      .send({ format: 'pdf' })
      .expect(201);
    expect(pdfUrl.body.url).toContain(`/v1/exports/${exportId}/download`);
    expect(pdfUrl.body.hash).toBe(created.body.file_sha256);

    const pdf = await admin.agent
      .get(pdfUrl.body.url as string)
      .buffer(true)
      .parse(binaryParser as never)
      .expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.headers['x-content-sha256']).toBe(created.body.file_sha256);
    const buffer = pdf.body as Buffer;
    expect(buffer.subarray(0, 8).toString()).toBe('%PDF-1.4');
    expect(buffer.length).toBe(created.body.file_size_bytes);
    expect(buffer.toString('latin1')).toContain('/CIDFontType2');
    expect(buffer.toString('latin1')).toContain('/Identity-H');

    const csvUrl = await admin.agent
      .post(`/v1/exports/${exportId}/url`)
      .set(auth(admin.csrf))
      .send({ format: 'csv' })
      .expect(201);
    const csv = await admin.agent
      .get(csvUrl.body.url as string)
      .buffer(true)
      .parse(binaryParser as never)
      .expect(200);
    const csvText = (csv.body as Buffer).toString('utf8');
    expect(csvText).toContain('journal_seq,date_time,content,visas_remarks');
    expect(csvText).toContain('Заменён автоматический выключатель');
    expect(csv.headers['x-content-sha256']).toBe(created.body.csv_sha256);

    const signature = await admin.agent
      .post(`/v1/signature/${created.body.signature.id}/verify`)
      .set(auth(admin.csrf))
      .expect(200);
    expect(signature.body.valid).toBe(true);

    const audit = await admin.agent
      .get('/v1/audit?action=journal.export.pdf&limit=10')
      .expect(200);
    expect(audit.body.items.length).toBeGreaterThan(0);
    const downloadAudit = await admin.agent
      .get('/v1/audit?action=export.download&limit=10')
      .expect(200);
    expect(downloadAudit.body.items.length).toBeGreaterThanOrEqual(2);

    // WORM: the completed export cannot be modified or deleted at DB level.
    await expect(
      context.client.query(
        `update export_jobs set file_sha256 = $1 where id = $2`,
        ['a'.repeat(64), exportId],
      ),
    ).rejects.toThrow(/WORM/);
    await expect(
      context.client.query('delete from export_jobs where id = $1', [exportId]),
    ).rejects.toThrow(/WORM/);

    const worker = await login(context.app, 'worker@logbook.local');
    await worker.agent
      .post('/v1/journal/exports')
      .set(auth(worker.csrf))
      .send({ journal_id: JOURNAL })
      .expect(403);
  });

  it('rejects tampered, expired and foreign signed export links', async () => {
    const admin = await login(context.app, 'admin@logbook.local');
    const supervisor = await login(context.app, 'supervisor@logbook.local');
    const created = await admin.agent
      .post('/v1/journal/exports')
      .set(auth(admin.csrf))
      .send({ journal_id: JOURNAL })
      .expect(201);
    const id = created.body.id as string;
    const link = await admin.agent
      .post(`/v1/exports/${id}/url`)
      .set(auth(admin.csrf))
      .send({ format: 'pdf' })
      .expect(201);
    const token = tokenOf(link.body.url as string);

    await admin.agent
      .get(`/v1/exports/${id}/download?format=pdf&token=${encodeURIComponent(`${token.slice(0, -4)}AAAA`)}`)
      .expect(403);

    const expired = forgeToken({
      e: id,
      h: created.body.file_sha256,
      f: 'pdf',
      exp: Date.now() - 60_000,
    });
    const expiredResponse = await admin.agent
      .get(`/v1/exports/${id}/download?format=pdf&token=${encodeURIComponent(expired)}`)
      .expect(403);
    expect(expiredResponse.body.error.message).toContain('истёк');

    // A supervisor who did not create the export cannot use the admin's link.
    await supervisor.agent
      .get(`/v1/exports/${id}/download?format=pdf&token=${encodeURIComponent(token)}`)
      .expect(403);

    await request(context.app.getHttpServer())
      .get(`/v1/exports/${id}/download?format=pdf&token=${encodeURIComponent(token)}`)
      .expect(401);
  });

  it('lists admin exports and seals backup checkpoints', async () => {
    const admin = await login(context.app, 'admin@logbook.local');
    const created = await admin.agent
      .post('/v1/admin/exports')
      .set(auth(admin.csrf))
      .send({ journal_id: JOURNAL })
      .expect(201);
    expect(created.body.type).toBe('journal_pdf');

    const list = await admin.agent
      .get('/v1/admin/exports?type=journal_pdf')
      .expect(200);
    expect(list.body.total).toBeGreaterThanOrEqual(1);
    expect(
      list.body.items.some((item: { id: string }) => item.id === created.body.id),
    ).toBe(true);

    const manifest = await admin.agent
      .get('/v1/admin/backup/manifest')
      .expect(200);
    expect(manifest.body.tables.journal_entries).toBe(5);
    expect(manifest.body.manifest_hash).toHaveLength(64);
    expect(
      manifest.body.exports.some(
        (item: { id: string }) => item.id === created.body.id,
      ),
    ).toBe(true);

    const checkpoint = await admin.agent
      .post('/v1/admin/backup/checkpoint')
      .set(auth(admin.csrf))
      .send({ label: 'pre-backup' })
      .expect(201);
    expect(checkpoint.body.manifest_hash).toHaveLength(64);

    const retention = await admin.agent.get('/v1/admin/retention').expect(200);
    expect(
      retention.body.checkpoints.some(
        (item: { label: string }) => item.label === 'pre-backup',
      ),
    ).toBe(true);

    const supervisor = await login(context.app, 'supervisor@logbook.local');
    await supervisor.agent
      .post('/v1/admin/backup/checkpoint')
      .set(auth(supervisor.csrf))
      .send({})
      .expect(403);
  });

  it('archives older entries into an immutable manifest', async () => {
    const admin = await login(context.app, 'admin@logbook.local');
    const old = '01930000-0000-7000-8000-00000000aa03';
    await insertEntry('2020-03-01T08:00:00.000Z', old);

    const archived = await admin.agent
      .post('/v1/admin/retention/archive')
      .set(auth(admin.csrf))
      .send({ journal_id: JOURNAL, from: '2020-01-01', to: '2020-12-31' })
      .expect(201);
    expect(archived.body.immutable).toBe(true);
    expect(archived.body.export.entries_count).toBe(1);
    expect(archived.body.manifest.files.pdf.sha256).toHaveLength(64);

    const list = await admin.agent
      .get('/v1/admin/retention/archives')
      .expect(200);
    expect(
      list.body.items.some(
        (item: { id: string }) => item.id === archived.body.archive_id,
      ),
    ).toBe(true);

    await expect(
      context.client.query(
        `update archive_manifests set entries_count = 99 where id = $1`,
        [archived.body.archive_id],
      ),
    ).rejects.toThrow(/WORM/);

    await admin.agent
      .post('/v1/admin/retention/archive')
      .set(auth(admin.csrf))
      .send({ journal_id: JOURNAL, from: '2026-01-01', to: '2026-12-31' })
      .expect(400);
  });
});
