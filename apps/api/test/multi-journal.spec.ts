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

const PASSWORD = 'Logbook!2026';
const WORKER_DEVICE = SEED_UUIDS.deviceWorker;
const ADMIN_DEVICE = SEED_UUIDS.deviceAdmin;
const SIMPLE_WORK_TYPE = SEED_UUIDS.workTypeSimple;
const FIELD_SITE = SEED_UUIDS.siteField;
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

function entryPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    performed_at: '2026-11-24T12:00:00.000Z',
    performed_tz_offset_min: 180,
    work_type_id: SIMPLE_WORK_TYPE,
    site_id: FIELD_SITE,
    text: 'Работа в выбранном журнале выполнена',
    input_method: 'manual',
    ...overrides,
  };
}

function entryOp(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const id = (overrides.entity_id as string | undefined) ?? uuidv7();
  return {
    op_id: uuidv7(),
    entity_type: 'entry',
    entity_id: id,
    op_type: 'create',
    base_version: null,
    hlc: '1795000000200:00001:mjtest01',
    client_time: '2026-11-24T12:00:00.000Z',
    payload: entryPayload(),
    ...overrides,
  };
}

async function push(
  app: INestApplication,
  agent: SuperAgentTest,
  csrf: string,
  deviceId: string,
  ops: Array<Record<string, unknown>>,
): Promise<request.Response> {
  return agent
    .post('/v1/sync/push')
    .set(authHeaders(csrf))
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

describe('multi-journal catalogue and access (JRN-03)', () => {
  it('lists only accessible journals and keeps admin endpoints protected', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const admin = await login(context.app, 'admin@logbook.local');

    const workerJournals = await worker.agent.get('/v1/journals').expect(200);
    expect(workerJournals.body.items).toHaveLength(1);
    expect(workerJournals.body.items[0]).toMatchObject({
      journal_key: 'main',
      access_level: 'write',
    });

    const adminJournals = await admin.agent.get('/v1/journals').expect(200);
    expect(
      adminJournals.body.items.map((journal: { journal_key: string }) =>
        journal.journal_key,
      ),
    ).toEqual(['main', 'substation']);

    await worker.agent.get(`/v1/journals/${SUBSTATION_JOURNAL}`).expect(403);

    await worker.agent
      .post('/v1/admin/journals')
      .set(authHeaders(worker.csrf))
      .send({ journal_key: 'workshop', name: 'Ремонтный журнал' })
      .expect(403);

    const created = await admin.agent
      .post('/v1/admin/journals')
      .set(authHeaders(admin.csrf))
      .send({
        journal_key: 'workshop',
        name: 'Ремонтный журнал',
        description: 'Журнал ремонтной службы',
        sort_order: 30,
      })
      .expect(201);
    expect(created.body).toMatchObject({ journal_key: 'workshop', active: true });

    const renamed = await admin.agent
      .patch(`/v1/admin/journals/${created.body.id}`)
      .set(authHeaders(admin.csrf))
      .send({ name: 'Ремонтный журнал (обновлён)' })
      .expect(200);
    expect(renamed.body.name).toContain('обновлён');

    const afterCreate = await admin.agent.get('/v1/journals').expect(200);
    expect(afterCreate.body.items).toHaveLength(3);

    // The snapshot carries the journal catalogue for offline filtering.
    const workerSnapshot = await worker.agent
      .get('/v1/dictionaries/snapshot')
      .expect(200);
    expect(workerSnapshot.body.journals.version).toBeGreaterThanOrEqual(2);
    expect(workerSnapshot.body.journals.items).toHaveLength(1);
    const adminSnapshot = await admin.agent
      .get('/v1/dictionaries/snapshot')
      .expect(200);
    expect(adminSnapshot.body.journals.items).toHaveLength(3);
  });

  it('numbers entries independently per journal and blocks foreign journals', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const admin = await login(context.app, 'admin@logbook.local');

    const mainOp = entryOp();
    const mainResult = await push(
      context.app,
      worker.agent,
      worker.csrf,
      WORKER_DEVICE,
      [mainOp],
    );
    expect(mainResult.body.results[0].status).toBe('applied');
    expect(mainResult.body.results[0].merged_entry.journal_id).toBe(
      DEFAULT_JOURNAL_ID,
    );
    const mainSeq = mainResult.body.results[0].merged_entry.journal_seq;
    expect(typeof mainSeq).toBe('number');

    // The second journal starts its own numbering at 1.
    const substationOp = entryOp({
      hlc: '1795000000201:00001:mjtest01',
      payload: entryPayload({
        text: 'Запись в журнале подстанции',
        journal_id: SUBSTATION_JOURNAL,
      }),
    });
    const substationResult = await push(
      context.app,
      admin.agent,
      admin.csrf,
      ADMIN_DEVICE,
      [substationOp],
    );
    expect(substationResult.body.results[0].status).toBe('applied');
    expect(substationResult.body.results[0].merged_entry.journal_id).toBe(
      SUBSTATION_JOURNAL,
    );
    expect(substationResult.body.results[0].merged_entry.journal_seq).toBe(1);

    const substationList = await admin.agent
      .get(`/v1/entries?journal_id=${SUBSTATION_JOURNAL}`)
      .expect(200);
    expect(substationList.body.items).toHaveLength(1);
    expect(substationList.body.items[0].journal_seq).toBe(1);
    const mainList = await admin.agent
      .get(`/v1/entries?journal_id=${DEFAULT_JOURNAL_ID}`)
      .expect(200);
    expect(
      mainList.body.items.some(
        (entry: { journal_seq: number }) => entry.journal_seq === mainSeq,
      ),
    ).toBe(true);

    // A worker without membership cannot write to or read that journal.
    const forbidden = await push(
      context.app,
      worker.agent,
      worker.csrf,
      WORKER_DEVICE,
      [
        entryOp({
          hlc: '1795000000202:00001:mjtest01',
          payload: entryPayload({
            text: 'Попытка записи в чужой журнал',
            journal_id: SUBSTATION_JOURNAL,
          }),
        }),
      ],
    );
    expect(forbidden.body.results[0].status).toBe('rejected');
    expect(forbidden.body.results[0].error.code).toBe('E-AUTH-02');
    await worker.agent
      .get(`/v1/entries?journal_id=${SUBSTATION_JOURNAL}`)
      .expect(403);

    // An explicit grant opens exactly that journal.
    await admin.agent
      .put(
        `/v1/admin/journals/${SUBSTATION_JOURNAL}/members/${SEED_UUIDS.worker}`,
      )
      .set(authHeaders(admin.csrf))
      .send({ access_level: 'write' })
      .expect(200);

    const members = await admin.agent
      .get(`/v1/admin/journals/${SUBSTATION_JOURNAL}/members`)
      .expect(200);
    expect(members.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          user_id: SEED_UUIDS.worker,
          access_level: 'write',
        }),
      ]),
    );

    const ownSubstation = await push(
      context.app,
      worker.agent,
      worker.csrf,
      WORKER_DEVICE,
      [
        entryOp({
          hlc: '1795000000203:00001:mjtest01',
          payload: entryPayload({
            text: 'Запись работника в журнале подстанции',
            journal_id: SUBSTATION_JOURNAL,
          }),
        }),
      ],
    );
    expect(ownSubstation.body.results[0].status).toBe('applied');
    expect(ownSubstation.body.results[0].merged_entry.journal_seq).toBe(2);
    const workerList = await worker.agent
      .get(`/v1/entries?journal_id=${SUBSTATION_JOURNAL}`)
      .expect(200);
    expect(workerList.body.items).toHaveLength(1);

    // The journal is immutable once the entry exists.
    const moved = await push(
      context.app,
      worker.agent,
      worker.csrf,
      WORKER_DEVICE,
      [
        {
          op_id: uuidv7(),
          entity_type: 'entry',
          entity_id: ownSubstation.body.results[0].merged_entry.id,
          op_type: 'update',
          base_version: 1,
          hlc: '1795000000204:00001:mjtest01',
          client_time: '2026-11-24T12:05:00.000Z',
          payload: { journal_id: DEFAULT_JOURNAL_ID },
        },
      ],
    );
    expect(moved.body.results[0].status).toBe('rejected');
    expect(moved.body.results[0].error.code).toBe('E-VAL-01');
  });

  it('scopes reviews, signatures and CSV export to one journal', async () => {
    const supervisor = await login(context.app, 'supervisor@logbook.local');
    const admin = await login(context.app, 'admin@logbook.local');

    const substationOp = entryOp({
      hlc: '1795000000205:00001:mjtest01',
      payload: entryPayload({
        text: 'Уникальный текст журнала подстанции',
        journal_id: SUBSTATION_JOURNAL,
      }),
    });
    await push(context.app, admin.agent, admin.csrf, ADMIN_DEVICE, [
      substationOp,
    ]);

    const mainReview = await supervisor.agent
      .post('/v1/journal/reviews')
      .set(authHeaders(supervisor.csrf))
      .send({ period_start: '2026-11-01', period_end: '2026-11-30' })
      .expect(201);
    expect(mainReview.body).toMatchObject({
      journal_id: DEFAULT_JOURNAL_ID,
      journal_key: 'main',
    });
    expect(mainReview.body.entries_count).toBeGreaterThan(0);

    const substationReview = await admin.agent
      .post('/v1/journal/reviews')
      .set(authHeaders(admin.csrf))
      .send({
        journal_id: SUBSTATION_JOURNAL,
        period_start: '2026-11-01',
        period_end: '2026-11-30',
      })
      .expect(201);
    expect(substationReview.body).toMatchObject({
      journal_id: SUBSTATION_JOURNAL,
      journal_key: 'substation',
      entries_count: 1,
    });
    expect(substationReview.body.content_hash).toHaveLength(64);

    await supervisor.agent
      .get(`/v1/journal/reviews?journal_id=${SUBSTATION_JOURNAL}`)
      .expect(403);

    const filtered = await admin.agent
      .get(`/v1/journal/export?journal_id=${SUBSTATION_JOURNAL}`)
      .expect(200);
    expect(filtered.headers['content-type']).toContain('text/csv');
    expect(filtered.text).toContain('Уникальный текст журнала подстанции');
    expect(filtered.text).not.toContain('Заменён участок трубопровода');
    expect(filtered.text).toContain('journal_key');

    // Without a filter the export keeps the old behaviour and all journals.
    const all = await admin.agent.get('/v1/journal/export').expect(200);
    expect(all.text).toContain('Заменён участок трубопровода');
    expect(all.text).toContain('Уникальный текст журнала подстанции');
  });

  it('keeps legacy payloads on main and does not stream foreign changes', async () => {
    const worker = await login(context.app, 'worker@logbook.local');
    const admin = await login(context.app, 'admin@logbook.local');

    const legacy = await push(context.app, worker.agent, worker.csrf, WORKER_DEVICE, [
      entryOp({ hlc: '1795000000206:00001:mjtest01' }),
    ]);
    expect(legacy.body.results[0].status).toBe('applied');
    expect(legacy.body.results[0].merged_entry.journal_id).toBe(
      DEFAULT_JOURNAL_ID,
    );
    expect(legacy.body.results[0].merged_entry.journal_seq).toEqual(expect.any(Number));

    const foreign = await push(
      context.app,
      admin.agent,
      admin.csrf,
      ADMIN_DEVICE,
      [
        entryOp({
          hlc: '1795000000207:00001:mjtest01',
          payload: entryPayload({
            text: 'Запись администратора в журнале подстанции',
            journal_id: SUBSTATION_JOURNAL,
          }),
        }),
      ],
    );
    const foreignId = foreign.body.results[0].merged_entry.id as string;

    const workerChanges = await worker.agent
      .get('/v1/sync/changes?since_seq=0&limit=200')
      .expect(200);
    expect(
      workerChanges.body.changes.some(
        (item: { entity?: { id: string } }) => item.entity?.id === foreignId,
      ),
    ).toBe(false);

    const adminChanges = await admin.agent
      .get('/v1/sync/changes?since_seq=0&limit=200')
      .expect(200);
    expect(
      adminChanges.body.changes.some(
        (item: { entity?: { id: string } }) => item.entity?.id === foreignId,
      ),
    ).toBe(true);
  });
});
