import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { SuperAgentTest } from 'supertest';
import { uuidv7 } from '@logbook/shared';
import { seedDatabase } from '../../../db/seed/seed';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { runMigrations } from '../src/db/migrator';
import { PgliteSqlClient } from '../src/db/pglite-client';
import { DB } from '../src/db/tokens';
import {
  nextScheduledRun,
  parseScheduleUtc,
} from '../src/export/retention-schedule';
import { RetentionService } from '../src/export/retention.service';

process.env.RETENTION_SCHEDULER_ENABLED = 'false';

const PASSWORD = 'Logbook!2026';
const WORKER = '01930000-0000-7000-8000-000000000101';
const ADMIN = '01930000-0000-7000-8000-000000000103';
const WORK_TYPE = '01930000-0000-7000-8000-000000000302';
const SITE = '01930000-0000-7000-8000-000000000402';
const JOURNAL = '01930000-0000-7000-8000-000000001001';
const RUN_NOW = '2029-11-25T00:00:00.000Z';

interface TestContext {
  app: INestApplication;
  client: PgliteSqlClient;
}

async function createContext(withSeed = true): Promise<TestContext> {
  const client = new PgliteSqlClient();
  await runMigrations(client);
  if (withSeed) {
    await seedDatabase(client, PASSWORD);
  }
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
  email = 'admin@logbook.local',
): Promise<{ agent: SuperAgentTest; csrf: string }> {
  const agent = request.agent(app.getHttpServer());
  const response = await agent
    .post('/v1/auth/dev-login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return { agent: agent as unknown as SuperAgentTest, csrf: response.body.csrf_token };
}

async function insertEntry(
  client: PgliteSqlClient,
  performedAt: string,
): Promise<string> {
  const id = uuidv7();
  await client.query(
    `insert into journal_entries
       (id, author_id, performed_at, performed_tz_offset_min, performed_at_source,
        work_type_id, site_id, text, input_method, hlc,
        created_at_client, updated_at_client, journal_id)
     values ($1, $2, $3::timestamptz, 180, 'manual'::performed_source_enum,
             $4, $5, 'Запись для проверки retention TTL', 'manual'::input_method_enum,
             $6, $3::timestamptz, $3::timestamptz, $7)`,
    [id, WORKER, performedAt, WORK_TYPE, SITE, '1795000001000:00001:ret0001', JOURNAL],
  );
  return id;
}

describe('retention scheduler (REP-05)', () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await createContext();
  });

  afterEach(async () => {
    await context.app.close();
    await context.client.close();
  });

  it('computes the next UTC schedule deterministically', () => {
    expect(
      nextScheduledRun(new Date('2026-01-01T01:00:00.000Z'), 2, 0).toISOString(),
    ).toBe('2026-01-01T02:00:00.000Z');
    expect(
      nextScheduledRun(new Date('2026-01-01T03:00:00.000Z'), 2, 0).toISOString(),
    ).toBe('2026-01-02T02:00:00.000Z');
    expect(parseScheduleUtc('02:30')).toEqual({ hour: 2, minute: 30 });
    expect(() => parseScheduleUtc('24:00')).toThrow(/RETENTION_SCHEDULE_UTC/);
  });

  it('is idempotent per UTC day for the scheduler', async () => {
    const admin = await login(context.app);
    const first = await admin.agent
      .post('/v1/admin/retention/scheduler/run')
      .set({ 'X-CSRF-Token': admin.csrf })
      .send({ now: RUN_NOW })
      .expect(201);
    expect(first.body.skipped).toBeUndefined();
    expect(first.body.trigger).toBe('scheduler');
    expect(first.body.report.ttl).toMatchObject({
      change_log_days: 90,
      export_job_days: 7,
    });

    const second = await admin.agent
      .post('/v1/admin/retention/scheduler/run')
      .set({ 'X-CSRF-Token': admin.csrf })
      .send({ now: RUN_NOW })
      .expect(201);
    expect(second.body).toMatchObject({
      skipped: true,
      reason: 'already_ran_today',
    });

    const runs = await context.client.query<{ count: string }>(
      `select count(*)::text as count from retention_runs
        where trigger = 'scheduler' and run_date = '2029-11-25'`,
    );
    expect(runs.rows[0]?.count).toBe('1');

    const report = await admin.agent.get('/v1/admin/retention').expect(200);
    expect(report.body.scheduler).toMatchObject({
      enabled: false,
      schedule_utc: '02:00',
    });
    expect(report.body.scheduler.latest_run).toMatchObject({ status: 'success' });
    expect(report.body.runs[0]).toMatchObject({ trigger: 'scheduler', status: 'success' });
  });

  it('applies change_log/export_jobs TTL without touching journal entries', async () => {
    const oldChange = await insertEntry(context.client, '2026-01-01T00:00:00.000Z');
    const recentChange = await insertEntry(context.client, '2029-11-01T00:00:00.000Z');
    await context.client.query(
      `insert into change_log (entity_type, entity_id, op, changed_at)
       values ('entry', $1, 'upsert', '2029-01-01T00:00:00.000Z'),
              ('entry', $2, 'upsert', '2029-11-20T00:00:00.000Z')`,
      [oldChange, recentChange],
    );
    const expiredId = uuidv7();
    const freshId = uuidv7();
    const wormId = uuidv7();
    await context.client.query(
      `insert into export_jobs (id, user_id, type, status, expires_at, worm)
       values ($1, $4, 'audit', 'queued', '2029-11-10T00:00:00.000Z', false),
              ($2, $4, 'audit', 'queued', '2029-11-24T00:00:00.000Z', false),
              ($3, $4, 'audit', 'queued', '2029-11-10T00:00:00.000Z', true)`,
      [expiredId, freshId, wormId, ADMIN],
    );
    const youngerEntry = await insertEntry(context.client, '2029-11-20T00:00:00.000Z');

    const admin = await login(context.app);
    const run = await admin.agent
      .post('/v1/admin/retention/scheduler/run')
      .set({ 'X-CSRF-Token': admin.csrf })
      .send({ now: RUN_NOW })
      .expect(201);
    expect(run.body.report.ttl.change_log_deleted).toBe(1);
    expect(run.body.report.ttl.export_jobs_deleted).toBe(1);

    const changeRows = await context.client.query<{ id: string }>(
      'select entity_id as id from change_log order by changed_at',
    );
    expect(changeRows.rows.map((row) => row.id)).toEqual([recentChange]);

    const jobRows = await context.client.query<{ id: string }>(
      'select id from export_jobs order by id',
    );
    expect(jobRows.rows.map((row) => row.id).sort()).toEqual(
      [freshId, wormId].sort(),
    );

    // No entry deletion at all: both older and younger records remain.
    const entries = await context.client.query<{ count: string }>(
      `select count(*)::text as count from journal_entries
        where id in ($1, $2)`,
      [oldChange, youngerEntry],
    );
    expect(entries.rows[0]?.count).toBe('2');
  });

  it('rejects a sync cursor older than the retained change_log', async () => {
    await context.client.query('delete from change_log');
    await context.client.query(
      `select setval(pg_get_serial_sequence('change_log', 'seq'), 100, true)`,
    );
    await context.client.query(
      `insert into change_log (entity_type, entity_id, op)
       values ('entry', $1, 'upsert')`,
      [uuidv7()],
    );
    const admin = await login(context.app);
    const stale = await admin.agent
      .get('/v1/sync/changes?since_seq=1&limit=10')
      .expect(410);
    expect(stale.body.error.code).toBe('E-CURSOR-01');
  });

  it('persists an audit-broken alert', async () => {
    const admin = await login(context.app);
    // First run creates audit events; then corrupt the last one and run again.
    await admin.agent
      .post('/v1/admin/retention/run')
      .set({ 'X-CSRF-Token': admin.csrf })
      .send({ now: '2029-11-24T00:00:00.000Z' })
      .expect(201);
    const last = await context.client.query<{ id: string }>(
      'select id from audit_events order by occurred_at desc limit 1',
    );
    expect(last.rows[0]).toBeDefined();
    await context.client.query(
      `update audit_events set hash = repeat('f', 64) where id = $1`,
      [last.rows[0]!.id],
    );
    const run = await admin.agent
      .post('/v1/admin/retention/run')
      .set({ 'X-CSRF-Token': admin.csrf })
      .send({ now: RUN_NOW })
      .expect(201);
    expect(run.body.audit_verification.ok).toBe(false);

    const alerts = await admin.agent.get('/v1/admin/retention/alerts').expect(200);
    expect(
      alerts.body.items.some(
        (alert: { kind: string; severity: string }) =>
          alert.kind === 'audit_broken' && alert.severity === 'critical',
      ),
    ).toBe(true);
  });

  it('skips and alerts when no admin actor exists for the scheduler', async () => {
    await context.app.close();
    await context.client.close();
    context = await createContext(false);
    const retention = context.app.get(RetentionService);
    const result = await retention.runScheduled(RUN_NOW);
    expect(result).toMatchObject({ skipped: true, reason: 'no_admin_actor' });
    const alerts = await context.client.query<{ kind: string; severity: string }>(
      'select kind, severity from retention_alerts order by created_at desc',
    );
    expect(alerts.rows[0]).toMatchObject({ kind: 'run_failed', severity: 'critical' });
  });
});
