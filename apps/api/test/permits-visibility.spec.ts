import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { seedDatabase } from '../../../db/seed/seed';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { loadEnv } from '../src/config/env';
import { runMigrations } from '../src/db/migrator';
import { PgliteSqlClient } from '../src/db/pglite-client';
import { DB } from '../src/db/tokens';

const PASSWORD = 'Logbook!2026';
const ACTIVE_PERMIT = '01930000-0000-7000-8000-000000000701';
const ANNULLED_PERMIT = '01930000-0000-7000-8000-000000000703';

let app: INestApplication;
let client: PgliteSqlClient;

async function login(email: string) {
  const agent = request.agent(app.getHttpServer());
  const response = await agent
    .post('/v1/auth/dev-login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return {
    agent,
    csrf: response.body.csrf_token as string,
  };
}

beforeAll(async () => {
  process.env.PERMIT_VISIBILITY_MODE = 'participant';
  loadEnv(true);
  client = new PgliteSqlClient();
  await runMigrations(client);
  await seedDatabase(client, PASSWORD);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB)
    .useValue(client)
    .compile();
  app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
});

afterAll(async () => {
  await app.close();
  await client.close();
  delete process.env.PERMIT_VISIBILITY_MODE;
  loadEnv(true);
});

describe('FR-PRM-11 permit visibility mode', () => {
  it('filters worker permits by participation but keeps admin access', async () => {
    const worker = await login('worker@logbook.local');
    const admin = await login('admin@logbook.local');

    const workerList = await worker.agent.get('/v1/permits').expect(200);
    expect(workerList.body.items).toHaveLength(2);
    expect(
      workerList.body.items.some(
        (item: { id: string }) => item.id === ANNULLED_PERMIT,
      ),
    ).toBe(false);

    const adminList = await admin.agent.get('/v1/permits').expect(200);
    expect(adminList.body.items).toHaveLength(3);

    await worker.agent.get(`/v1/permits/${ACTIVE_PERMIT}`).expect(200);
    await worker.agent.get(`/v1/permits/${ANNULLED_PERMIT}`).expect(404);
    await admin.agent.get(`/v1/permits/${ANNULLED_PERMIT}`).expect(200);
  });
});
