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

const PASSWORD = 'Logbook!2026';
const WORKER_DEVICE = '01930000-0000-7000-8000-000000000201';
const SIMPLE_WORK_TYPE = '01930000-0000-7000-8000-000000000302';
const PERMIT_WORK_TYPE = '01930000-0000-7000-8000-000000000301';
const FIELD_SITE = '01930000-0000-7000-8000-000000000402';
const WORKSHOP_SITE = '01930000-0000-7000-8000-000000000401';
const ACTIVE_PERMIT = '01930000-0000-7000-8000-000000000701';
const SEED_ENTRY_WORKER = '01930000-0000-7000-8000-000000000801';
const SEED_ENTRY_PLAIN = '01930000-0000-7000-8000-000000000802';
const SEED_ENTRY_VERIFIED = '01930000-0000-7000-8000-000000000801';
const SEED_ENTRY_SUPERVISOR = '01930000-0000-7000-8000-000000000804';

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
): Promise<{ agent: SuperAgentTest; csrf: string; user: Record<string, unknown> }> {
  const agent = request.agent(app.getHttpServer());
  const response = await agent
    .post('/v1/auth/dev-login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return {
    agent: agent as unknown as SuperAgentTest,
    csrf: response.body.csrf_token as string,
    user: response.body.user as Record<string, unknown>,
  };
}

function authHeaders(csrf: string): Record<string, string> {
  return { 'X-CSRF-Token': csrf };
}

function entryOp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = (overrides.entity_id as string | undefined) ?? uuidv7();
  return {
    op_id: uuidv7(),
    entity_type: 'entry',
    entity_id: id,
    op_type: 'create',
    base_version: null,
    hlc: '1795000000200:00001:test0001',
    client_time: '2026-11-23T12:00:00.000Z',
    payload: {
      performed_at: '2026-11-23T11:55:00.000Z',
      performed_tz_offset_min: 180,
      work_type_id: SIMPLE_WORK_TYPE,
      site_id: FIELD_SITE,
      text: 'Проверена запись через синхронизацию',
      input_method: 'manual',
    },
    ...overrides,
  };
}

async function push(
  app: INestApplication,
  agent: SuperAgentTest,
  csrf: string,
  ops: Array<Record<string, unknown>>,
): Promise<request.Response> {
  return agent
    .post('/v1/sync/push')
    .set(authHeaders(csrf))
    .send({ device_id: WORKER_DEVICE, app_version: '0.1.0', ops })
    .expect(200);
}

beforeEach(async () => {
  context = await createContext();
});

afterEach(async () => {
  await context.app.close();
  await context.client.close();
});

describe('auth and CSRF', () => {
  it('logs in, returns /me and rejects wrong password', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    expect(worker.user).toMatchObject({
      email: 'worker@logbook.local',
      role: 'worker',
    });

    const me = await worker.agent.get('/v1/me').expect(200);
    expect(me.body.user.role).toBe('worker');
    expect(me.body.session.offline_valid_until).toEqual(expect.any(String));
    expect(me.body.features).toMatchObject({ supervisor_cache: false });

    // ADR-16/SYN-02: the offline supervisor cache is enabled for reviewers.
    const supervisor = await login(context.app, 'supervisor@logbook.local');
    const supervisorMe = await supervisor.agent.get('/v1/me').expect(200);
    expect(supervisorMe.body.features).toMatchObject({ supervisor_cache: true });

    const anonymous = await request(context.app.getHttpServer())
      .get('/v1/me')
      .expect(401);
    expect(anonymous.body.error.code).toBe('E-AUTH-01');
    expect(anonymous.body.error.request_id).toEqual(expect.stringMatching(/^req_/));

    await request(context.app.getHttpServer())
      .post('/v1/auth/dev-login')
      .send({ email: 'worker@logbook.local', password: 'wrong-password' })
      .expect(401);
  });

  it('requires CSRF for mutations and revokes the session on logout', async () => {
    const worker = await login(context.app, 'worker@logbook.local');

    const withoutCsrf = await worker.agent.post('/v1/auth/logout').expect(403);
    expect(withoutCsrf.body.error.code).toBe('E-AUTH-02');

    await worker.agent
      .post('/v1/auth/logout')
      .set(authHeaders(worker.csrf))
      .expect(200);

    await worker.agent.get('/v1/me').expect(401);
  });
});

describe('session and devices', () => {
  it('refreshes the session and revokes a device', async () => {
    const worker = await login(context.app, 'worker@logbook.local');

    const refreshed = await worker.agent
      .post('/v1/auth/session')
      .set(authHeaders(worker.csrf))
      .expect(200);
    expect(refreshed.body.session.offline_valid_until).toEqual(expect.any(String));

    const devices = await worker.agent.get('/v1/devices').expect(200);
    expect(devices.body.items).toHaveLength(1);
    expect(devices.body.items[0].id).toBe(WORKER_DEVICE);

    await worker.agent
      .delete(`/v1/devices/${WORKER_DEVICE}`)
      .set(authHeaders(worker.csrf))
      .expect(200);

    const after = await worker.agent.get('/v1/devices').expect(200);
    expect(after.body.items[0].status).toBe('revoked');
  });
});

describe('journal visibility', () => {
  it('filters entries by role and department', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const supervisor = await login(context.app, 'supervisor@logbook.local');
    const admin = await login(context.app, 'admin@logbook.local');

    const workerList = await worker.agent.get('/v1/entries').expect(200);
    expect(workerList.body.items).toHaveLength(3);

    const supervisorList = await supervisor.agent.get('/v1/entries').expect(200);
    expect(supervisorList.body.items).toHaveLength(4);

    const adminList = await admin.agent.get('/v1/entries').expect(200);
    expect(adminList.body.items).toHaveLength(4);

    await worker.agent.get(`/v1/entries/${SEED_ENTRY_SUPERVISOR}`).expect(404);
    await supervisor.agent.get(`/v1/entries/${SEED_ENTRY_SUPERVISOR}`).expect(200);
  });
});

describe('sync push', () => {
  it('creates an entry, is idempotent and exposes changes', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const op = entryOp();

    const first = await push(context.app, worker.agent, worker.csrf, [op]);
    expect(first.body.results[0]).toMatchObject({
      status: 'applied',
      version: 1,
      duplicate: false,
    });

    const repeated = await push(context.app, worker.agent, worker.csrf, [op]);
    expect(repeated.body.results[0]).toMatchObject({
      status: 'applied',
      version: 1,
      duplicate: true,
    });

    const changes = await worker.agent
      .get('/v1/sync/changes?since_seq=0&limit=50')
      .expect(200);
    const created = changes.body.changes.find(
      (item: { entity?: { id: string } }) => item.entity?.id === op.entity_id,
    );
    expect(created).toBeDefined();
    expect(created.entity.text).toContain('синхронизацию');
  });

  it('merges different fields and records an older-field conflict', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const supervisor = await login(context.app, 'supervisor@logbook.local');
    const entityId = uuidv7();

    const create = await push(context.app, worker.agent, worker.csrf, [
      entryOp({ entity_id: entityId, hlc: '1795000000200:00001:test0001' }),
    ]);
    expect(create.body.results[0].version).toBe(1);

    const updateText = await push(context.app, worker.agent, worker.csrf, [
      {
        op_id: uuidv7(),
        entity_type: 'entry',
        entity_id: entityId,
        op_type: 'update',
        base_version: 1,
        hlc: '1795000000201:00001:test0001',
        client_time: '2026-11-23T12:01:00.000Z',
        payload: { text: 'Уточнённый текст после проверки' },
      },
    ]);
    expect(updateText.body.results[0]).toMatchObject({
      status: 'applied',
      version: 2,
    });

    const updateComment = await push(context.app, worker.agent, worker.csrf, [
      {
        op_id: uuidv7(),
        entity_type: 'entry',
        entity_id: entityId,
        op_type: 'update',
        base_version: 1,
        hlc: '1795000000202:00001:test0001',
        client_time: '2026-11-23T12:02:00.000Z',
        payload: { comment: 'Добавлен комментарий позже' },
      },
    ]);
    expect(updateComment.body.results[0]).toMatchObject({
      status: 'applied',
      version: 3,
    });
    expect(updateComment.body.results[0].merged_entry.text).toContain('Уточнённый');
    expect(updateComment.body.results[0].merged_entry.comment).toContain('комментарий');

    const detail = await worker.agent
      .get(`/v1/entries/${entityId}`)
      .expect(200);
    expect(detail.body.revisions.length).toBeGreaterThanOrEqual(1);
    expect(
      detail.body.revisions.some(
        (revision: { diff?: Record<string, unknown> }) => revision.diff?.text,
      ),
    ).toBe(true);

    const stale = await push(context.app, worker.agent, worker.csrf, [
      {
        op_id: uuidv7(),
        entity_type: 'entry',
        entity_id: entityId,
        op_type: 'update',
        base_version: 3,
        hlc: '1795000000100:00001:test0001',
        client_time: '2026-11-23T12:03:00.000Z',
        payload: { text: 'Старая версия текста не должна победить' },
      },
    ]);
    expect(stale.body.results[0].status).toBe('conflict');
    expect(stale.body.results[0].merged_entry.text).toContain('Уточнённый');

    const conflicts = await supervisor.agent.get('/v1/conflicts').expect(200);
    expect(conflicts.body.items.length).toBeGreaterThan(0);

    const conflict = conflicts.body.items[0] as { id: string };
    const resolved = await supervisor.agent
      .post(`/v1/conflicts/${conflict.id}/resolve`)
      .set(authHeaders(supervisor.csrf))
      .send({
        resolution: 'local',
        values: { text: 'Текст выбран руководителем при разборе' },
      })
      .expect(201);
    expect(resolved.body.entry_version).toBe(4);

    const entryAfter = await worker.agent
      .get(`/v1/entries/${entityId}`)
      .expect(200);
    expect(entryAfter.body.text).toContain('руководителем');
  });

  it('blocks author edits of a verified entry', async () => {
    const worker = await login(context.app, 'worker@logbook.local');

    const response = await push(context.app, worker.agent, worker.csrf, [
      {
        op_id: uuidv7(),
        entity_type: 'entry',
        entity_id: SEED_ENTRY_VERIFIED,
        op_type: 'update',
        base_version: 1,
        hlc: '1795000000900:00001:test0001',
        client_time: '2026-11-23T12:10:00.000Z',
        payload: { text: 'Попытка изменить проверенную запись' },
      },
    ]);

    expect(response.body.results[0].status).toBe('conflict');
    expect(response.body.results[0].merged_entry.version).toBe(1);
    expect(response.body.results[0].conflicts[0].reason).toBe('verified_entry');
  });

  it('returns a tombstone in changes after delete', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const entityId = uuidv7();

    await push(context.app, worker.agent, worker.csrf, [
      entryOp({ entity_id: entityId, hlc: '1795000000300:00001:test0001' }),
    ]);

    const deleted = await push(context.app, worker.agent, worker.csrf, [
      {
        op_id: uuidv7(),
        entity_type: 'entry',
        entity_id: entityId,
        op_type: 'delete',
        base_version: 1,
        hlc: '1795000000301:00001:test0001',
        client_time: '2026-11-23T12:20:00.000Z',
        payload: {},
      },
    ]);
    expect(deleted.body.results[0].status).toBe('applied');

    const changes = await worker.agent
      .get('/v1/sync/changes?since_seq=0&limit=100')
      .expect(200);
    const tombstone = changes.body.changes.find(
      (item: { entity_id: string; op: string }) =>
        item.entity_id === entityId && item.op === 'delete',
    );
    expect(tombstone).toBeDefined();

    const list = await worker.agent.get('/v1/entries').expect(200);
    expect(list.body.items.some((item: { id: string }) => item.id === entityId)).toBe(
      false,
    );
  });
});

describe('merge policies C-08/C-09/C-10', () => {
  it('C-08 keeps a server-corrected time until consent is explicit', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    await context.client.query(
      `update journal_entries set performed_at_source = 'server_corrected'
        where id = $1`,
      [SEED_ENTRY_PLAIN],
    );
    const before = await worker.agent
      .get(`/v1/entries/${SEED_ENTRY_PLAIN}`)
      .expect(200);

    const denied = await push(context.app, worker.agent, worker.csrf, [
      {
        op_id: uuidv7(),
        entity_type: 'entry',
        entity_id: SEED_ENTRY_PLAIN,
        op_type: 'update',
        base_version: 1,
        hlc: '1795000000800:00001:test0001',
        client_time: '2026-11-24T09:00:00.000Z',
        payload: { performed_at: '2026-11-24T09:00:00.000Z' },
      },
    ]);
    expect(denied.body.results[0].status).toBe('conflict');
    expect(denied.body.results[0].conflicts[0].reason).toBe(
      'server_correction_requires_consent',
    );
    expect(new Date(denied.body.results[0].merged_entry.performed_at).toISOString()).toBe(
      new Date(before.body.performed_at).toISOString(),
    );

    const accepted = await push(context.app, worker.agent, worker.csrf, [
      {
        op_id: uuidv7(),
        entity_type: 'entry',
        entity_id: SEED_ENTRY_PLAIN,
        op_type: 'update',
        base_version: 1,
        hlc: '1795000000801:00001:test0001',
        client_time: '2026-11-24T09:01:00.000Z',
        payload: {
          performed_at: '2026-11-24T09:00:00.000Z',
          accept_server_time: true,
        },
      },
    ]);
    expect(accepted.body.results[0].status).toBe('applied');
    expect(accepted.body.results[0].merged_entry.performed_at_source).toBe('manual');
  });

  it('C-09 saves the entry with a risk flag and a pending permit review', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const supervisor = await login(context.app, 'supervisor@logbook.local');
    await context.client.query(
      `update permits set status = 'annulled' where id = $1`,
      [ACTIVE_PERMIT],
    );

    const response = await push(context.app, worker.agent, worker.csrf, [
      entryOp({
        entity_id: uuidv7(),
        hlc: '1795000000810:00001:test0001',
        payload: {
          performed_at: '2026-11-24T09:10:00.000Z',
          performed_tz_offset_min: 180,
          work_type_id: PERMIT_WORK_TYPE,
          site_id: WORKSHOP_SITE,
          permit_id: ACTIVE_PERMIT,
          permit_binding_status: 'linked',
          permit_status_at_sync: 'active',
          text: 'Работы по наряду после офлайн-записи',
          input_method: 'manual',
        },
      }),
    ]);

    expect(response.body.results[0].status).toBe('conflict');
    expect(response.body.results[0].merged_entry.permit_status_at_sync).toBe(
      'annulled',
    );
    expect(response.body.results[0].merged_entry.permit_risk_flag).toBe(true);
    expect(response.body.results[0].merged_entry.permit_risk_reason).toBeTruthy();

    const conflicts = await supervisor.agent.get('/v1/conflicts').expect(200);
    expect(
      conflicts.body.items.some(
        (item: { field: string }) => item.field === 'permit_status_at_sync',
      ),
    ).toBe(true);
  });

  it('C-09 catches an annulment that happened after the entry was created', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const entityId = uuidv7();
    const create = await push(context.app, worker.agent, worker.csrf, [
      entryOp({
        entity_id: entityId,
        hlc: '1795000000815:00001:test0001',
        payload: {
          performed_at: '2026-11-24T09:15:00.000Z',
          performed_tz_offset_min: 180,
          work_type_id: PERMIT_WORK_TYPE,
          site_id: WORKSHOP_SITE,
          permit_id: ACTIVE_PERMIT,
          permit_binding_status: 'linked',
          permit_status_at_sync: 'active',
          text: 'Работы по наряду до аннулирования',
          input_method: 'manual',
        },
      }),
    ]);
    expect(create.body.results[0].status).toBe('applied');

    await context.client.query(
      `update permits set status = 'annulled' where id = $1`,
      [ACTIVE_PERMIT],
    );
    const update = await push(context.app, worker.agent, worker.csrf, [
      {
        op_id: uuidv7(),
        entity_type: 'entry',
        entity_id: entityId,
        op_type: 'update',
        base_version: 1,
        hlc: '1795000000816:00001:test0001',
        client_time: '2026-11-24T09:16:00.000Z',
        payload: { text: 'Уточнение после аннулирования наряда' },
      },
    ]);

    expect(update.body.results[0].status).toBe('conflict');
    expect(update.body.results[0].merged_entry.permit_status_at_sync).toBe(
      'annulled',
    );
    expect(update.body.results[0].merged_entry.permit_risk_flag).toBe(true);
  });

  it('C-10 rejects an invalid merged state instead of hitting a DB constraint', async () => {
    const worker = await login(context.app, 'worker@logbook.local');

    const response = await push(context.app, worker.agent, worker.csrf, [
      {
        op_id: uuidv7(),
        entity_type: 'entry',
        entity_id: SEED_ENTRY_PLAIN,
        op_type: 'update',
        base_version: 1,
        hlc: '1795000000820:00001:test0001',
        client_time: '2026-11-24T09:20:00.000Z',
        payload: {
          permit_id: ACTIVE_PERMIT,
          permit_number_raw: 'НД-1',
        },
      },
    ]);

    expect(response.body.results[0].status).toBe('conflict');
    expect(response.body.results[0].version).toBe(1);
    expect(response.body.results[0].merged_entry.permit_id).toBeNull();
    expect(response.body.results[0].conflicts[0].field).toBe('_entity');
    expect(response.body.results[0].conflicts[0].reason).toContain('invalid_merge');
  });
});

describe('journal compliance layer', () => {
  it('assigns journal_seq and defaults old payloads to work', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const entityId = uuidv7();
    const response = await push(context.app, worker.agent, worker.csrf, [
      entryOp({
        entity_id: entityId,
        hlc: '1795000000900:00001:test0001',
      }),
    ]);

    expect(response.body.results[0].status).toBe('applied');
    expect(response.body.results[0].merged_entry.event_type).toBe('work');
    expect(response.body.results[0].merged_entry.late_entry).toBe(false);
    expect(typeof response.body.results[0].merged_entry.journal_seq).toBe('number');

    const detail = await worker.agent.get(`/v1/entries/${entityId}`).expect(200);
    expect(detail.body.journal_seq).toBe(
      response.body.results[0].merged_entry.journal_seq,
    );
  });

  it('stores structured command events and validates event_data', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const entityId = uuidv7();
    const response = await push(context.app, worker.agent, worker.csrf, [
      entryOp({
        entity_id: entityId,
        hlc: '1795000000910:00001:test0001',
        payload: {
          performed_at: '2026-11-24T10:00:00.000Z',
          performed_tz_offset_min: 180,
          work_type_id: SIMPLE_WORK_TYPE,
          site_id: FIELD_SITE,
          text: 'Получена команда на переключение',
          input_method: 'manual',
          event_type: 'command',
          event_data: { issued_by: 'НСЭ Иванов', executed_at: '2026-11-24T10:05:00.000Z' },
        },
      }),
    ]);

    expect(response.body.results[0].status).toBe('applied');
    expect(response.body.results[0].merged_entry.event_type).toBe('command');
    expect(response.body.results[0].merged_entry.event_data.issued_by).toBe(
      'НСЭ Иванов',
    );

    const invalid = await push(context.app, worker.agent, worker.csrf, [
      entryOp({
        entity_id: uuidv7(),
        hlc: '1795000000911:00001:test0001',
        payload: {
          performed_at: '2026-11-24T10:10:00.000Z',
          performed_tz_offset_min: 180,
          work_type_id: SIMPLE_WORK_TYPE,
          site_id: FIELD_SITE,
          text: 'Некорректное событие заземления',
          input_method: 'manual',
          event_type: 'grounding',
          event_data: { action: 'applied' },
        },
      }),
    ]);
    expect(invalid.body.results[0].status).toBe('rejected');
    expect(invalid.body.results[0].error.code).toBe('E-VAL-01');
  });

  it('creates journal reviews and exports a 3-column CSV', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const supervisor = await login(context.app, 'supervisor@logbook.local');
    const admin = await login(context.app, 'admin@logbook.local');

    const review = await supervisor.agent
      .post('/v1/journal/reviews')
      .set(authHeaders(supervisor.csrf))
      .send({
        period_start: '2026-11-01',
        period_end: '2026-11-30',
        remarks: 'Замечаний нет',
      })
      .expect(201);

    expect(review.body.entries_count).toBeGreaterThan(0);
    expect(review.body.content_hash).toHaveLength(64);

    const list = await admin.agent.get('/v1/journal/reviews').expect(200);
    expect(list.body.items.length).toBeGreaterThan(0);

    await worker.agent
      .post('/v1/journal/reviews')
      .set(authHeaders(worker.csrf))
      .send({ period_start: '2026-11-01', period_end: '2026-11-30' })
      .expect(403);

    const csv = await worker.agent
      .get('/v1/journal/export?from=2026-11-01&to=2026-11-30')
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('journal_seq,date_time,content,visas_remarks');
    expect(csv.text).toContain('TODO(OQ-04)');
    expect(csv.text).toContain('Заменён автоматический выключатель');
  });
});

describe('permits', () => {
  it('imports CSV idempotently and exposes permits', async () => {
    const admin = await login(context.app, 'admin@logbook.local');
    const worker = await login(context.app, 'worker@logbook.local');

    const csv = [
      'external_id,number,year,type,status,valid_from,valid_to,site_code,description,responsible_login,external_url',
      'EXT-900,НД-900/2026,2026,permit_to_work,active,2026-12-01,2026-12-31,SITE-01,Тестовые работы по наряду,supervisor@logbook.local,',
    ].join('\n');

    const first = await admin.agent
      .post('/v1/admin/permits/import')
      .set(authHeaders(admin.csrf))
      .send({ source_id: 'test-csv', csv })
      .expect(201);
    expect(first.body).toMatchObject({ imported: 1, updated: 0, skipped: 0 });

    const second = await admin.agent
      .post('/v1/admin/permits/import')
      .set(authHeaders(admin.csrf))
      .send({ source_id: 'test-csv', csv })
      .expect(201);
    expect(second.body).toMatchObject({ imported: 0, updated: 1, skipped: 0 });

    const list = await worker.agent.get('/v1/permits?status=active').expect(200);
    expect(
      list.body.items.some((permit: { number: string }) => permit.number === 'НД-900/2026'),
    ).toBe(true);

    const pdfUrl = await admin.agent
      .post('/v1/permits/01930000-0000-7000-8000-000000000701/pdf-url')
      .set(authHeaders(admin.csrf))
      .expect(200);
    expect(pdfUrl.body.url).toContain('/v1/permits/pdf/');
    expect(pdfUrl.body.expires_at).toEqual(expect.any(String));
    expect(pdfUrl.body.hash).toHaveLength(64);

    await worker.agent
      .post('/v1/admin/permits/import')
      .set(authHeaders(worker.csrf))
      .send({ source_id: 'x', csv })
      .expect(403);
  });
});

describe('supervisor actions', () => {
  it('verifies, unverifies and restores entries with audit', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const supervisor = await login(context.app, 'supervisor@logbook.local');
    const admin = await login(context.app, 'admin@logbook.local');

    const verify = await supervisor.agent
      .post(`/v1/entries/${SEED_ENTRY_WORKER}/verify`)
      .set(authHeaders(supervisor.csrf))
      .expect(201);
    expect(verify.body.verified_at).toEqual(expect.any(String));

    const unverify = await supervisor.agent
      .post(`/v1/entries/${SEED_ENTRY_WORKER}/unverify`)
      .set(authHeaders(supervisor.csrf))
      .send({ comment: 'Нужно уточнение' })
      .expect(201);
    expect(unverify.body.verified_at).toBeNull();

    const entityId = uuidv7();
    await push(context.app, worker.agent, worker.csrf, [
      entryOp({ entity_id: entityId, hlc: '1795000000400:00001:test0001' }),
    ]);
    await push(context.app, worker.agent, worker.csrf, [
      {
        op_id: uuidv7(),
        entity_type: 'entry',
        entity_id: entityId,
        op_type: 'delete',
        base_version: 1,
        hlc: '1795000000401:00001:test0001',
        client_time: '2026-11-23T12:30:00.000Z',
        payload: {},
      },
    ]);

    const restore = await admin.agent
      .post(`/v1/entries/${entityId}/restore`)
      .set(authHeaders(admin.csrf))
      .expect(201);
    expect(restore.body.status).toBe('active');

    await worker.agent
      .post(`/v1/entries/${SEED_ENTRY_WORKER}/verify`)
      .set(authHeaders(worker.csrf))
      .expect(403);
  });
});

describe('dictionaries, audit and admin', () => {
  it('returns snapshot, patches dictionary, reads audit and manages users', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const admin = await login(context.app, 'admin@logbook.local');

    const snapshot = await worker.agent.get('/v1/dictionaries/snapshot').expect(200);
    expect(snapshot.body.work_types.version).toBe(1);
    expect(snapshot.body.work_types.items.length).toBe(5);

    await admin.agent
      .patch('/v1/admin/dictionaries/work_types')
      .set(authHeaders(admin.csrf))
      .send({
        items: [
          {
            id: '01930000-0000-7000-8000-000000000302',
            name: 'Работы по распоряжению (обновлено)',
          },
        ],
      })
      .expect(200);

    const updated = await worker.agent.get('/v1/dictionaries/snapshot').expect(200);
    expect(updated.body.work_types.version).toBe(2);
    expect(
      updated.body.work_types.items.find(
        (item: { id: string }) => item.id === '01930000-0000-7000-8000-000000000302',
      ).name,
    ).toContain('обновлено');

    const op = entryOp({ hlc: '1795000000500:00001:test0001' });
    await push(context.app, worker.agent, worker.csrf, [op]);

    const audit = await admin.agent
      .get('/v1/audit?action=entry.create&limit=10')
      .expect(200);
    expect(audit.body.items.length).toBeGreaterThan(0);
    expect(audit.body.items[0]).toMatchObject({
      action: 'entry.create',
      stream: expect.stringMatching(/^logbook:/),
      hash: expect.any(String),
      prev_hash: expect.any(String),
    });

    const created = await admin.agent
      .post('/v1/admin/users')
      .set(authHeaders(admin.csrf))
      .send({
        email: 'new.worker@logbook.local',
        full_name: 'Новый Сотрудник',
        role: 'worker',
        department_id: '01930000-0000-7000-8000-000000000001',
        password: 'DemoPass!2026',
      })
      .expect(201);
    expect(created.body.id).toEqual(expect.any(String));

    await admin.agent
      .post(`/v1/admin/users/${created.body.id}/revoke-sessions`)
      .set(authHeaders(admin.csrf))
      .expect(201);

    await worker.agent
      .post('/v1/admin/users')
      .set(authHeaders(worker.csrf))
      .send({})
      .expect(403);

    const exportJob = await admin.agent
      .post('/v1/exports')
      .set(authHeaders(admin.csrf))
      .send({ type: 'audit' })
      .expect(201);
    const exportStatus = await admin.agent
      .get(`/v1/exports/${exportJob.body.id}`)
      .expect(200);
    expect(exportStatus.body.status).toBe('queued');
  });
});
