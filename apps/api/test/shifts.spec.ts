import { hashSync } from 'bcryptjs';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { SuperAgentTest } from 'supertest';
import {
  DEFAULT_JOURNAL_ID,
  SEED_UUIDS,
  uuidv7,
} from '@logbook/shared';
import { seedDatabase } from '../../../db/seed/seed';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { runMigrations } from '../src/db/migrator';
import { PgliteSqlClient } from '../src/db/pglite-client';
import { DB } from '../src/db/tokens';

// Two-sided acceptance is signed by the configured adapter in these tests.
process.env.SIGNATURE_PROVIDER = 'simple';
process.env.SIGNATURE_SECRET = 'test-signature-secret-0123456789abcdef';
process.env.SIGNATURE_KEY_ID = 'test-key-v1';
process.env.SIGNATURE_AUTO_SIGN = 'true';
process.env.AUTH_PROVIDER = 'dev';
process.env.DEV_LOGIN_ENABLED = 'true';

const PASSWORD = 'Logbook!2026';
const INCOMING_SUPERVISOR = '01930000-0000-7000-8000-000000000104';
const INCOMING_DEVICE = '01930000-0000-7000-8000-000000000204';
const SUPERVISOR_DEVICE = SEED_UUIDS.deviceSupervisor;
const SUBSTATION_JOURNAL = SEED_UUIDS.journalSubstation;

interface TestContext {
  app: INestApplication;
  client: PgliteSqlClient;
}

let context: TestContext;

async function addIncomingSupervisor(client: PgliteSqlClient): Promise<void> {
  await client.query(
    `insert into users
       (id, external_id, full_name, email, role, department_id, position, status)
     values ($1, 'ext-supervisor-2', 'Смирнов Пётр Ильич', 'supervisor2@logbook.local',
             'supervisor'::user_role_enum, $2, 'Старший мастер', 'active'::user_status_enum)`,
    [INCOMING_SUPERVISOR, SEED_UUIDS.departmentMain],
  );
  await client.query(
    'insert into user_credentials (user_id, password_hash) values ($1, $2)',
    [INCOMING_SUPERVISOR, hashSync(PASSWORD, 10)],
  );
  await client.query(
    `insert into devices (id, user_id, name, platform, app_version)
     values ($1, $2, 'Android D7', 'Android 14', '0.1.0')`,
    [INCOMING_DEVICE, INCOMING_SUPERVISOR],
  );
}

async function createContext(): Promise<TestContext> {
  const client = new PgliteSqlClient();
  await runMigrations(client);
  await seedDatabase(client, PASSWORD);
  await addIncomingSupervisor(client);

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

function auth(csrf: string): Record<string, string> {
  return { 'X-CSRF-Token': csrf };
}

function handoverBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    journal_id: DEFAULT_JOURNAL_ID,
    shift_date: '2026-11-20',
    period_start: '2026-11-20T00:00:00.000Z',
    period_end: '2026-11-23T00:00:00.000Z',
    handover_comment: 'Смена сдана без замечаний, журнал проверен',
    ...overrides,
  };
}

function shiftOp(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    op_id: uuidv7(),
    entity_type: 'shift',
    entity_id: uuidv7(),
    op_type: 'create',
    base_version: null,
    hlc: '1795000000300:00001:shift001',
    client_time: '2026-11-20T18:00:00.000Z',
    payload: handoverBody(),
    ...overrides,
  };
}

async function push(
  agent: SuperAgentTest,
  csrf: string,
  deviceId: string,
  ops: Array<Record<string, unknown>>,
): Promise<request.Response> {
  return agent
    .post('/v1/sync/push')
    .set(auth(csrf))
    .send({ device_id: deviceId, app_version: '0.1.0', ops })
    .expect(200);
}

beforeEach(async () => {
  context = await createContext();
});

afterEach(async () => {
  await context.app.close();
  await context.client.close();
});

describe('shift handover (JRN-02)', () => {
  it('handovers, rejects and re-handovers with a two-sided signature', async () => {
    const outgoing = await login(context.app, 'supervisor@logbook.local');
    const incoming = await login(context.app, 'supervisor2@logbook.local');

    const handover = await outgoing.agent
      .post('/v1/shifts')
      .set(auth(outgoing.csrf))
      .send(handoverBody())
      .expect(201);
    expect(handover.body).toMatchObject({
      status: 'handed_over',
      journal_id: DEFAULT_JOURNAL_ID,
      handed_over_by: SEED_UUIDS.supervisor,
      version: 1,
    });
    expect(handover.body.entries_count).toBe(4);
    expect(handover.body.content_hash).toHaveLength(64);
    expect(handover.body.entries_hash).toHaveLength(64);

    const detail = await outgoing.agent
      .get(`/v1/shifts/${handover.body.id}`)
      .expect(200);
    expect(detail.body.signatures).toHaveLength(1);
    const handoverSignature = detail.body.signatures[0] as { id: string };
    const verifiedHandover = await outgoing.agent
      .post(`/v1/signature/${handoverSignature.id}/verify`)
      .set(auth(outgoing.csrf))
      .expect(200);
    expect(verifiedHandover.body.valid).toBe(true);

    // The handing-over supervisor cannot accept their own shift.
    await outgoing.agent
      .post(`/v1/shifts/${handover.body.id}/accept`)
      .set(auth(outgoing.csrf))
      .send({ action: 'accept' })
      .expect(403);

    const reject = await incoming.agent
      .post(`/v1/shifts/${handover.body.id}/reject`)
      .set(auth(incoming.csrf))
      .send({ action: 'reject', rejection_reason: 'Не приложены ведомости замеров' })
      .expect(201);
    expect(reject.body).toMatchObject({
      status: 'rejected',
      rejected_by: INCOMING_SUPERVISOR,
      rejection_reason: 'Не приложены ведомости замеров',
      version: 2,
    });

    await incoming.agent
      .post(`/v1/shifts/${handover.body.id}/accept`)
      .set(auth(incoming.csrf))
      .send({ action: 'accept' })
      .expect(409);

    // Re-handover for the same window is allowed after a rejection.
    const rehandover = await outgoing.agent
      .post('/v1/shifts')
      .set(auth(outgoing.csrf))
      .send(handoverBody({ handover_comment: 'Повторная сдача с ведомостями' }))
      .expect(201);
    expect(rehandover.body.id).not.toBe(handover.body.id);

    const accepted = await incoming.agent
      .post(`/v1/shifts/${rehandover.body.id}/accept`)
      .set(auth(incoming.csrf))
      .send({ action: 'accept', comment: 'Смена принята, замечаний нет' })
      .expect(201);
    expect(accepted.body).toMatchObject({
      status: 'accepted',
      accepted_by: INCOMING_SUPERVISOR,
      acceptance_comment: 'Смена принята, замечаний нет',
      version: 2,
    });
    expect(accepted.body.signatures).toHaveLength(2);
    for (const signature of accepted.body.signatures as Array<{ id: string }>) {
      const verified = await incoming.agent
        .post(`/v1/signature/${signature.id}/verify`)
        .set(auth(incoming.csrf))
        .expect(200);
      expect(verified.body.valid).toBe(true);
    }

    // A shift cannot be accepted twice.
    await incoming.agent
      .post(`/v1/shifts/${rehandover.body.id}/accept`)
      .set(auth(incoming.csrf))
      .send({ action: 'accept' })
      .expect(409);

    const list = await incoming.agent
      .get('/v1/shifts?status=accepted')
      .expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].id).toBe(rehandover.body.id);

    // Both sides are in the audit trail.
    const admin = await login(context.app, 'admin@logbook.local');
    const audit = await admin.agent
      .get('/v1/audit?action=shift.accept&limit=10')
      .expect(200);
    expect(audit.body.items.some((item: { action: string }) => item.action === 'shift.accept')).toBe(
      true,
    );
  });

  it('validates handover input and journal access', async () => {
    const supervisor = await login(context.app, 'supervisor@logbook.local');
    const worker = await login(context.app, 'worker@logbook.local');
    const admin = await login(context.app, 'admin@logbook.local');

    await worker.agent
      .post('/v1/shifts')
      .set(auth(worker.csrf))
      .send(handoverBody())
      .expect(403);

    const badPeriod = await supervisor.agent
      .post('/v1/shifts')
      .set(auth(supervisor.csrf))
      .send(
        handoverBody({
          period_start: '2026-11-23T00:00:00.000Z',
          period_end: '2026-11-22T00:00:00.000Z',
        }),
      )
      .expect(400);
    expect(badPeriod.body.error.code).toBe('E-VAL-01');

    await supervisor.agent
      .post('/v1/shifts')
      .set(auth(supervisor.csrf))
      .send(handoverBody({ handover_comment: 'мало' }))
      .expect(400);

    // The default journal is open; a non-member journal is not.
    await supervisor.agent
      .post('/v1/shifts')
      .set(auth(supervisor.csrf))
      .send(
        handoverBody({
          journal_id: SUBSTATION_JOURNAL,
          shift_date: '2026-11-24',
          period_start: '2026-11-24T06:00:00.000Z',
          period_end: '2026-11-24T18:00:00.000Z',
        }),
      )
      .expect(403);

    const substation = await admin.agent
      .post('/v1/shifts')
      .set(auth(admin.csrf))
      .send(
        handoverBody({
          journal_id: SUBSTATION_JOURNAL,
          shift_date: '2026-11-24',
          period_start: '2026-11-24T06:00:00.000Z',
          period_end: '2026-11-24T18:00:00.000Z',
          handover_comment: 'Смена подстанции сдана администратором',
        }),
      )
      .expect(201);
    expect(substation.body.entries_count).toBe(0);

    // The same window cannot be handed over twice while active.
    await admin.agent
      .post('/v1/shifts')
      .set(auth(admin.csrf))
      .send(
        handoverBody({
          journal_id: SUBSTATION_JOURNAL,
          shift_date: '2026-11-24',
          period_start: '2026-11-24T06:00:00.000Z',
          period_end: '2026-11-24T18:00:00.000Z',
          handover_comment: 'Повторная сдача той же смены',
        }),
      )
      .expect(409);
  });

  it('creates and accepts a shift offline through sync/push and streams changes', async () => {
    const outgoing = await login(context.app, 'supervisor@logbook.local');
    const incoming = await login(context.app, 'supervisor2@logbook.local');

    const createOp = shiftOp();
    const created = await push(outgoing.agent, outgoing.csrf, SUPERVISOR_DEVICE, [
      createOp,
    ]);
    expect(created.body.results[0]).toMatchObject({
      status: 'applied',
      version: 1,
      duplicate: false,
    });
    expect(created.body.results[0].merged_shift).toMatchObject({
      status: 'handed_over',
      handed_over_by: SEED_UUIDS.supervisor,
    });
    const shiftId = created.body.results[0].merged_shift.id as string;

    // Idempotent replay returns the stored result.
    const replay = await push(outgoing.agent, outgoing.csrf, SUPERVISOR_DEVICE, [
      createOp,
    ]);
    expect(replay.body.results[0]).toMatchObject({
      status: 'applied',
      duplicate: true,
      version: 1,
    });

    const acceptOp = {
      op_id: uuidv7(),
      entity_type: 'shift',
      entity_id: shiftId,
      op_type: 'update',
      base_version: 1,
      hlc: '1795000000301:00001:inc00002',
      client_time: '2026-11-20T18:10:00.000Z',
      payload: { action: 'accept', comment: 'Принято офлайн' },
    };
    const accepted = await push(incoming.agent, incoming.csrf, INCOMING_DEVICE, [
      acceptOp,
    ]);
    expect(accepted.body.results[0]).toMatchObject({
      status: 'applied',
      version: 2,
    });
    expect(accepted.body.results[0].merged_shift).toMatchObject({
      status: 'accepted',
      accepted_by: INCOMING_SUPERVISOR,
      acceptance_comment: 'Принято офлайн',
    });

    // A stale acceptance from another device is a conflict with the server state.
    const stale = await push(incoming.agent, incoming.csrf, INCOMING_DEVICE, [
      {
        op_id: uuidv7(),
        entity_type: 'shift',
        entity_id: shiftId,
        op_type: 'update',
        base_version: 1,
        hlc: '1795000000302:00001:inc00002',
        client_time: '2026-11-20T18:11:00.000Z',
        payload: { action: 'accept', comment: 'Повторное принятие' },
      },
    ]);
    expect(stale.body.results[0]).toMatchObject({
      status: 'conflict',
      version: 2,
    });
    expect(stale.body.results[0].merged_shift.status).toBe('accepted');
    expect(stale.body.results[0].conflicts[0].reason).toBe('shift_already_accepted');

    // Both devices receive the shift in the change stream; a worker does not.
    const changes = await incoming.agent
      .get('/v1/sync/changes?since_seq=0&limit=200')
      .expect(200);
    const shiftChange = changes.body.changes.find(
      (item: { entity_type: string; entity?: { id: string } }) =>
        item.entity_type === 'shift' && item.entity?.id === shiftId,
    );
    expect(shiftChange).toBeDefined();
    expect(shiftChange.entity.status).toBe('accepted');

    const worker = await login(context.app, 'worker@logbook.local');
    const workerChanges = await worker.agent
      .get('/v1/sync/changes?since_seq=0&limit=200')
      .expect(200);
    expect(
      workerChanges.body.changes.some(
        (item: { entity_type: string }) => item.entity_type === 'shift',
      ),
    ).toBe(false);
  });
});
