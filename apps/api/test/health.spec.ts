import { Test } from '@nestjs/testing';
import request from 'supertest';
import { seedDatabase } from '../../../db/seed/seed';
import { DbModule } from '../src/db/db.module';
import { runMigrations } from '../src/db/migrator';
import { PgliteSqlClient } from '../src/db/pglite-client';
import { DB } from '../src/db/tokens';
import { HealthModule } from '../src/health/health.module';

describe('GET /v1/health', () => {
  let client: PgliteSqlClient;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;

  async function createApp() {
    const moduleRef = await Test.createTestingModule({
      imports: [DbModule, HealthModule],
    })
      .overrideProvider(DB)
      .useValue(client)
      .compile();

    const application = moduleRef.createNestApplication();
    application.setGlobalPrefix('v1');
    await application.init();
    return application;
  }

  beforeAll(async () => {
    client = new PgliteSqlClient();
    await runMigrations(client);
    await seedDatabase(client, 'Logbook!2026');
    app = await createApp();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    await client.close();
  });

  it('returns ok with database latency', async () => {
    const response = await request(app!.getHttpServer()).get('/v1/health').expect(200);

    expect(response.body).toMatchObject({
      status: 'ok',
      db: 'ok',
      version: expect.any(String),
      server_time: expect.any(String),
    });
    expect(typeof response.body.latency_ms).toBe('number');
  });
});
