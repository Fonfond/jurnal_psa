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
const FIELD_SITE = '01930000-0000-7000-8000-000000000402';

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

function entryOp(opId = uuidv7(), text = 'Батчевая запись'): Record<string, unknown> {
  return {
    op_id: opId,
    entity_type: 'entry',
    entity_id: uuidv7(),
    op_type: 'create',
    base_version: null,
    hlc: `1795000000${String(Math.floor(Math.random() * 900) + 100)}:00001:batch001`,
    client_time: '2026-11-23T12:00:00.000Z',
    payload: {
      performed_at: '2026-11-23T11:55:00.000Z',
      performed_tz_offset_min: 180,
      work_type_id: SIMPLE_WORK_TYPE,
      site_id: FIELD_SITE,
      text,
      input_method: 'manual',
    },
  };
}

async function push(
  agent: SuperAgentTest,
  csrf: string,
  ops: Array<Record<string, unknown>>,
): Promise<request.Response> {
  return agent
    .post('/v1/sync/push')
    .set('X-CSRF-Token', csrf)
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

describe('batch sync push (t17)', () => {
  it('applies 50 creates in one batch with a block of journal_seq', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const admin = await login(context.app, 'admin@logbook.local');

    const before = await context.client.query<{ last_value: string }>(
      `select last_value::text from journal_seq_01930000_0000_7000_8000_000000001001`,
    );

    const ops = Array.from({ length: 50 }, (_, index) =>
      entryOp(undefined, `Батчевая запись ${index + 1}`),
    );
    const response = await push(worker.agent, worker.csrf, ops);
    expect(response.body.results).toHaveLength(50);
    for (const result of response.body.results) {
      expect(result).toMatchObject({ status: 'applied', duplicate: false });
      expect(result.merged_entry.journal_seq).toEqual(expect.any(Number));
    }
    const seqs = response.body.results.map(
      (result: { merged_entry: { journal_seq: number } }) =>
        result.merged_entry.journal_seq,
    );
    expect(new Set(seqs).size).toBe(50);
    expect(Math.max(...seqs) - Math.min(...seqs)).toBe(49);

    const after = await context.client.query<{ last_value: string }>(
      `select last_value::text from journal_seq_01930000_0000_7000_8000_000000001001`,
    );
    // Sequence block advanced by the batch size.
    expect(Number(after.rows[0]?.last_value)).toBe(Number(before.rows[0]?.last_value) + 50);

    const chain = await admin.agent.get('/v1/admin/audit/verify').expect(200);
    expect(chain.body.ok).toBe(true);

    const created = await context.client.query<{ count: string }>(
      `select count(*)::text as count from journal_entries
        where last_op_id = any($1::uuid[])`,
      [ops.map((op) => op.op_id)],
    );
    expect(Number(created.rows[0]?.count)).toBe(50);
  });

  it('replays a batch idempotently without new sequence numbers', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const ops = Array.from({ length: 10 }, () => entryOp());
    const first = await push(worker.agent, worker.csrf, ops);
    expect(first.body.results.every((result: { status: string }) => result.status === 'applied')).toBe(
      true,
    );

    const counterBefore = await context.client.query<{ last_value: string }>(
      `select last_value::text from journal_seq_01930000_0000_7000_8000_000000001001`,
    );
    const replay = await push(worker.agent, worker.csrf, ops);
    expect(replay.body.results).toHaveLength(10);
    for (const result of replay.body.results) {
      expect(result).toMatchObject({ status: 'applied', duplicate: true });
    }
    const counterAfter = await context.client.query<{ last_value: string }>(
      `select last_value::text from journal_seq_01930000_0000_7000_8000_000000001001`,
    );
    expect(counterAfter.rows[0]?.last_value).toBe(counterBefore.rows[0]?.last_value);
  });

  it('isolates a rejected op with a savepoint and keeps audit/chain clean', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const admin = await login(context.app, 'admin@logbook.local');
    const bad = entryOp();
    bad.payload = { text: 'нет обязательных полей' };
    const validA = entryOp();
    const validB = entryOp();
    const missing = entryOp();
    missing.op_type = 'update';
    missing.base_version = 1;
    missing.payload = { text: 'обновление несуществующей записи' };

    const response = await push(worker.agent, worker.csrf, [
      validA,
      bad,
      validB,
      missing,
    ]);
    expect(response.body.results).toHaveLength(4);
    expect(response.body.results[0]).toMatchObject({ status: 'applied' });
    expect(response.body.results[1]).toMatchObject({ status: 'rejected' });
    expect(response.body.results[2]).toMatchObject({ status: 'applied' });
    expect(response.body.results[3]).toMatchObject({ status: 'rejected' });

    const entries = await context.client.query<{ count: string }>(
      `select count(*)::text as count from journal_entries
        where id = any($1::uuid[])`,
      [[validA.entity_id, validB.entity_id, bad.entity_id]],
    );
    expect(Number(entries.rows[0]?.count)).toBe(2);

    const chain = await admin.agent.get('/v1/admin/audit/verify').expect(200);
    expect(chain.body.ok).toBe(true);

    const audits = await context.client.query<{ count: string }>(
      `select count(*)::text as count from audit_events
        where action = 'entry.create' and entity_id = any($1::uuid[])`,
      [[validA.entity_id, validB.entity_id, bad.entity_id]],
    );
    expect(Number(audits.rows[0]?.count)).toBe(2);
  });

  it('delivers a committed audit_outbox row (crash window) with a valid chain', async () => {
    const admin = await login(context.app, 'admin@logbook.local');
    const entityId = uuidv7();
    await context.client.query(
      `insert into audit_outbox
         (id, occurred_at, actor_id, actor_role, action, entity_type, entity_id, after)
       values ($1, now(), $2, 'worker'::user_role_enum, 'entry.create', 'entry', $3, $4::jsonb)`,
      [uuidv7(), '01930000-0000-7000-8000-000000000101', entityId, '{"text":"outbox"}'],
    );

    // Audit read flushes the outbox: the event survives a crash after commit.
    const chain = await admin.agent.get('/v1/admin/audit/verify').expect(200);
    expect(chain.body.ok).toBe(true);
    const audit = await admin.agent
      .get(`/v1/audit?action=entry.create&entity_id=${entityId}`)
      .expect(200);
    expect(audit.body.items).toHaveLength(1);
    const outbox = await context.client.query<{ count: string }>(
      'select count(*)::text as count from audit_outbox',
    );
    expect(outbox.rows[0]?.count).toBe('0');
  });

  it('keeps journal_seq positive and unique when a transaction rolls back (gap policy)', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const before = await context.client.query<{ last_value: string }>(
      `select last_value::text from journal_seq_01930000_0000_7000_8000_000000001001`,
    );
    const beforeSeq = Number(before.rows[0]?.last_value);

    const rolledBackId = uuidv7();
    await expect(
      context.client.transaction(async (tx) => {
        await tx.query(
          `insert into journal_entries
             (id, author_id, performed_at, performed_tz_offset_min,
              performed_at_source, work_type_id, site_id, "text", input_method,
              hlc, created_at_client, updated_at_client, journal_id, journal_seq)
           values ($1, $2, '2026-11-23T11:55:00.000Z', 180,
                   'device_auto'::performed_source_enum, $3, $4, 'Запись для проверки отката транзакции', 'manual',
                   '1795000000999:00001:rollback', '2026-11-23T12:00:00.000Z',
                   '2026-11-23T12:00:00.000Z',
                   (select id from journals where journal_key = 'main'),
                   (select coalesce(max(journal_seq), 0) + 1 from journal_entries))`,
          [rolledBackId, '01930000-0000-7000-8000-000000000101', SIMPLE_WORK_TYPE, FIELD_SITE],
        );
        await tx.query(
          `insert into audit_outbox
             (id, occurred_at, actor_id, actor_role, action, entity_type, entity_id)
           values ($1, now(), $2, 'worker'::user_role_enum, 'entry.create', 'entry', $3)`,
          [uuidv7(), '01930000-0000-7000-8000-000000000101', rolledBackId],
        );
        throw new Error('simulated crash before commit');
      }),
    ).rejects.toThrow('simulated crash');

    const rolledBack = await context.client.query<{ count: string }>(
      'select count(*)::text as count from journal_entries where id = $1',
      [rolledBackId],
    );
    expect(rolledBack.rows[0]?.count).toBe('0');

    // Sequence-based policy: after a rolled-back batch the next push is still
    // positive and unique; gaps are allowed and documented (0016).
    const op = entryOp();
    const response = await push(worker.agent, worker.csrf, [op]);
    const seq = response.body.results[0].merged_entry.journal_seq as number;
    expect(seq).toBeGreaterThan(0);
    expect(seq).toBeGreaterThanOrEqual(beforeSeq + 1);
    const invalid = await context.client.query<{ count: string }>(
      `select count(*)::text as count from (
         select journal_id, journal_seq from journal_entries
          where journal_seq is not null
          group by journal_id, journal_seq having count(*) > 1
       ) d`,
    );
    expect(invalid.rows[0]?.count).toBe('0');
    const negative = await context.client.query<{ count: string }>(
      'select count(*)::text as count from journal_entries where journal_seq < 0',
    );
    expect(negative.rows[0]?.count).toBe('0');
  });
});

