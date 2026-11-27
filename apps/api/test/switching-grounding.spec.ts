import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { SuperAgentTest } from 'supertest';
import { SEED_UUIDS, uuidv7 } from '@logbook/shared';
import { seedDatabase } from '../../../db/seed/seed';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { runMigrations } from '../src/db/migrator';
import { PgliteSqlClient } from '../src/db/pglite-client';
import { DB } from '../src/db/tokens';

const PASSWORD = 'Logbook!2026';
const WORKER_DEVICE = SEED_UUIDS.deviceWorker;
const SIMPLE_WORK_TYPE = SEED_UUIDS.workTypeSimple;
const FIELD_SITE = SEED_UUIDS.siteField;
const WORKSHOP_SITE = SEED_UUIDS.siteWorkshop;
const SUBSTATION_JOURNAL = SEED_UUIDS.journalSubstation;

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

function entryOp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    op_id: uuidv7(),
    entity_type: 'entry',
    entity_id: uuidv7(),
    op_type: 'create',
    base_version: null,
    hlc: '1795000000400:00001:sw000001',
    client_time: '2026-11-25T08:00:00.000Z',
    payload: {
      performed_at: '2026-11-25T07:55:00.000Z',
      performed_tz_offset_min: 180,
      work_type_id: SIMPLE_WORK_TYPE,
      site_id: FIELD_SITE,
      text: 'Выполнены оперативные переключения по бланку',
      input_method: 'manual',
    },
    ...overrides,
  };
}

async function push(
  agent: SuperAgentTest,
  csrf: string,
  ops: Array<Record<string, unknown>>,
): Promise<request.Response> {
  return agent
    .post('/v1/sync/push')
    .set(auth(csrf))
    .send({ device_id: WORKER_DEVICE, app_version: '0.1.0', ops })
    .expect(200);
}

function switchingPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_type: 'switching',
    event_data: {
      order_no: 'БЛ-757/2026-14',
      order_date: '2026-11-25',
      responsible: 'Петров П.П.',
      operations: [
        {
          operation: 'open',
          device: 'Выключатель Q1',
          from_state: 'включено',
          to_state: 'отключено',
          note: 'Проверено по бланку',
        },
        {
          operation: 'close',
          device: 'Разъединитель QS2',
          from_state: 'включено',
          to_state: 'отключено',
        },
      ],
      checks: [
        { check: 'Проверено отсутствие напряжения', passed: true },
        { check: 'Заземляющие ножи включены', passed: true },
      ],
      executed_at: '2026-11-25T07:50:00.000Z',
      points: 'РУ-10 кВ, яч. 5',
    },
    ...overrides,
  };
}

function groundingPayload(
  action: 'applied' | 'removed',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event_type: 'grounding',
    event_data: {
      action,
      grounding_type: 'portable',
      point: 'КЛ-10 кВ, яч. 5',
      tool_number: 'T-1',
      count: 1,
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

describe('structured switching events (JRN-05)', () => {
  it('stores operations, checks and the 757 order', async () => {
    const worker = await login(context.app, 'worker@logbook.local');

    const response = await push(worker.agent, worker.csrf, [
      entryOp({
        payload: {
          performed_at: '2026-11-25T07:55:00.000Z',
          performed_tz_offset_min: 180,
          work_type_id: SIMPLE_WORK_TYPE,
          site_id: WORKSHOP_SITE,
          text: 'Переключения по бланку № БЛ-757/2026-14',
          input_method: 'manual',
          ...switchingPayload(),
        },
      }),
    ]);

    expect(response.body.results[0].status).toBe('applied');
    expect(response.body.results[0].merged_entry.event_type).toBe('switching');
    const detail = await worker.agent
      .get(`/v1/entries/${response.body.results[0].merged_entry.id}`)
      .expect(200);
    expect(detail.body.event_data.order_no).toBe('БЛ-757/2026-14');
    expect(detail.body.event_data.operations).toHaveLength(2);
    expect(detail.body.event_data.operations[0]).toMatchObject({
      operation: 'open',
      device: 'Выключатель Q1',
      from_state: 'включено',
      to_state: 'отключено',
    });
    expect(detail.body.event_data.checks).toHaveLength(2);
    expect(detail.body.event_data.checks[1]).toMatchObject({
      check: 'Заземляющие ножи включены',
      passed: true,
    });
  });

  it('rejects an unknown switching operation and still accepts the legacy form', async () => {
    const worker = await login(context.app, 'worker@logbook.local');

    const invalid = await push(worker.agent, worker.csrf, [
      entryOp({
        payload: {
          performed_at: '2026-11-25T08:00:00.000Z',
          performed_tz_offset_min: 180,
          work_type_id: SIMPLE_WORK_TYPE,
          site_id: FIELD_SITE,
          text: 'Некорректная операция переключения',
          input_method: 'manual',
          event_type: 'switching',
          event_data: {
            operations: [{ operation: 'explode', device: 'Q1' }],
          },
        },
      }),
    ]);
    expect(invalid.body.results[0].status).toBe('rejected');
    expect(invalid.body.results[0].error.code).toBe('E-VAL-01');

    const empty = await push(worker.agent, worker.csrf, [
      entryOp({
        payload: {
          performed_at: '2026-11-25T08:01:00.000Z',
          performed_tz_offset_min: 180,
          work_type_id: SIMPLE_WORK_TYPE,
          site_id: FIELD_SITE,
          text: 'Пустой бланк переключений недопустим',
          input_method: 'manual',
          event_type: 'switching',
          event_data: { order_no: 'БЛ-1' },
        },
      }),
    ]);
    expect(empty.body.results[0].status).toBe('rejected');

    // Old clients still send a free-text sequence.
    const legacy = await push(worker.agent, worker.csrf, [
      entryOp({
        hlc: '1795000000401:00001:sw000001',
        payload: {
          performed_at: '2026-11-25T08:05:00.000Z',
          performed_tz_offset_min: 180,
          work_type_id: SIMPLE_WORK_TYPE,
          site_id: FIELD_SITE,
          text: 'Переключение по старой форме записи',
          input_method: 'manual',
          event_type: 'switching',
          event_data: {
            sequence: 'Отключить Q1, включить заземляющие ножи',
            points: 'РУ-10 кВ',
          },
        },
      }),
    ]);
    expect(legacy.body.results[0].status).toBe('applied');
  });
});

describe('grounding registry (JRN-06)', () => {
  it('applies, conflicts on repeat, removes and re-applies a grounding', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const supervisor = await login(context.app, 'supervisor@logbook.local');
    const admin = await login(context.app, 'admin@logbook.local');

    const applied = await push(worker.agent, worker.csrf, [
      entryOp({
        payload: {
          performed_at: '2026-11-25T08:10:00.000Z',
          performed_tz_offset_min: 180,
          work_type_id: SIMPLE_WORK_TYPE,
          site_id: FIELD_SITE,
          text: 'Установлено переносное заземление на яч. 5',
          input_method: 'manual',
          ...groundingPayload('applied'),
        },
      }),
    ]);
    expect(applied.body.results[0].status).toBe('applied');
    const appliedEntryId = applied.body.results[0].merged_entry.id as string;

    const registry = await worker.agent
      .get('/v1/groundings?state=applied&journal_id=01930000-0000-7000-8000-000000001001')
      .expect(200);
    expect(registry.body.items).toHaveLength(1);
    const grounding = registry.body.items[0] as {
      id: string;
      state: string;
      point: string;
      tool_number: string;
      site_name: string;
      applied_by: string;
    };
    expect(grounding).toMatchObject({
      state: 'applied',
      point: 'КЛ-10 кВ, яч. 5',
      tool_number: 'T-1',
      applied_by: SEED_UUIDS.worker,
    });
    expect(grounding.site_name).toBe('Площадка А');

    // A second "applied" for the same active point is a conflict, not a duplicate.
    const duplicate = await push(worker.agent, worker.csrf, [
      entryOp({
        hlc: '1795000000402:00001:sw000001',
        payload: {
          performed_at: '2026-11-25T08:12:00.000Z',
          performed_tz_offset_min: 180,
          work_type_id: SIMPLE_WORK_TYPE,
          site_id: FIELD_SITE,
          text: 'Повторная установка того же заземления',
          input_method: 'manual',
          ...groundingPayload('applied'),
        },
      }),
    ]);
    expect(duplicate.body.results[0].status).toBe('conflict');
    expect(duplicate.body.results[0].conflicts[0]).toMatchObject({
      field: 'grounding_state',
      reason: 'grounding_already_applied',
    });
    expect(duplicate.body.results[0].merged_entry.id).toBeTruthy();
    const registryAfterDuplicate = await worker.agent
      .get('/v1/groundings?state=applied')
      .expect(200);
    expect(registryAfterDuplicate.body.items).toHaveLength(1);

    const conflicts = await supervisor.agent.get('/v1/conflicts').expect(200);
    expect(
      conflicts.body.items.some(
        (item: { field: string }) => item.field === 'grounding_state',
      ),
    ).toBe(true);

    // Removal closes the active row.
    const removed = await push(worker.agent, worker.csrf, [
      entryOp({
        hlc: '1795000000403:00001:sw000001',
        payload: {
          performed_at: '2026-11-25T09:30:00.000Z',
          performed_tz_offset_min: 180,
          work_type_id: SIMPLE_WORK_TYPE,
          site_id: FIELD_SITE,
          text: 'Снято переносное заземление с яч. 5',
          input_method: 'manual',
          ...groundingPayload('removed'),
        },
      }),
    ]);
    expect(removed.body.results[0].status).toBe('applied');

    const detail = await worker.agent
      .get(`/v1/groundings/${grounding.id}`)
      .expect(200);
    expect(detail.body).toMatchObject({
      state: 'removed',
      removed_by: SEED_UUIDS.worker,
    });
    expect(detail.body.removed_at).toEqual(expect.any(String));

    // Removing an already removed grounding is a conflict.
    const secondRemove = await push(worker.agent, worker.csrf, [
      entryOp({
        hlc: '1795000000404:00001:sw000001',
        payload: {
          performed_at: '2026-11-25T09:32:00.000Z',
          performed_tz_offset_min: 180,
          work_type_id: SIMPLE_WORK_TYPE,
          site_id: FIELD_SITE,
          text: 'Повторное снятие отсутствующего заземления',
          input_method: 'manual',
          ...groundingPayload('removed'),
        },
      }),
    ]);
    expect(secondRemove.body.results[0].status).toBe('conflict');
    expect(secondRemove.body.results[0].conflicts[0].reason).toBe(
      'grounding_not_applied',
    );

    // A new application creates a new active row, history is kept.
    const reapplied = await push(worker.agent, worker.csrf, [
      entryOp({
        hlc: '1795000000405:00001:sw000001',
        payload: {
          performed_at: '2026-11-25T10:00:00.000Z',
          performed_tz_offset_min: 180,
          work_type_id: SIMPLE_WORK_TYPE,
          site_id: FIELD_SITE,
          text: 'Повторно установлено заземление на яч. 5',
          input_method: 'manual',
          ...groundingPayload('applied'),
        },
      }),
    ]);
    expect(reapplied.body.results[0].status).toBe('applied');
    const all = await worker.agent.get('/v1/groundings').expect(200);
    expect(all.body.items).toHaveLength(2);
    expect(
      all.body.items.filter((item: { state: string }) => item.state === 'applied'),
    ).toHaveLength(1);

    // The grounding event itself is immutable; a new event is required.
    const forbiddenEdit = await push(worker.agent, worker.csrf, [
      {
        op_id: uuidv7(),
        entity_type: 'entry',
        entity_id: appliedEntryId,
        op_type: 'update',
        base_version: 1,
        hlc: '1795000000406:00001:sw000001',
        client_time: '2026-11-25T10:05:00.000Z',
        payload: {
          event_data: (groundingPayload('removed') as Record<string, unknown>)
            .event_data,
        },
      },
    ]);
    expect(forbiddenEdit.body.results[0].status).toBe('rejected');
    expect(forbiddenEdit.body.results[0].error.code).toBe('E-VAL-01');

    const audit = await admin.agent
      .get('/v1/audit?action=grounding.applied&limit=10')
      .expect(200);
    expect(audit.body.items.length).toBeGreaterThan(0);

    const changes = await worker.agent
      .get('/v1/sync/changes?since_seq=0&limit=200')
      .expect(200);
    expect(
      changes.body.changes.some(
        (item: { entity_type: string }) => item.entity_type === 'grounding',
      ),
    ).toBe(true);
  });

  it('enforces journal access for the grounding registry', async () => {
    const supervisor = await login(context.app, 'supervisor@logbook.local');
    const admin = await login(context.app, 'admin@logbook.local');

    await supervisor.agent
      .get(`/v1/groundings?journal_id=${SUBSTATION_JOURNAL}`)
      .expect(403);

    const adminList = await admin.agent
      .get(`/v1/groundings?journal_id=${SUBSTATION_JOURNAL}`)
      .expect(200);
    expect(adminList.body.items).toEqual([]);
  });
});
