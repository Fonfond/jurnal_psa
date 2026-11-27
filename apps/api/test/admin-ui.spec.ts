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

process.env.AUTH_PROVIDER = 'dev';
process.env.DEV_LOGIN_ENABLED = 'true';
process.env.SIGNATURE_PROVIDER = 'none';
process.env.ADMIN_ORIGIN = 'http://localhost:5174';

const PASSWORD = 'Logbook!2026';

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
  email: string,
  password: string = PASSWORD,
): Promise<{ agent: SuperAgentTest; csrf: string }> {
  const agent = request.agent(context.app.getHttpServer());
  const response = await agent
    .post('/v1/auth/dev-login')
    .send({ email, password })
    .expect(200);
  return {
    agent: agent as unknown as SuperAgentTest,
    csrf: response.body.csrf_token as string,
  };
}

function authHeaders(csrf: string): Record<string, string> {
  return { 'X-CSRF-Token': csrf };
}

beforeEach(async () => {
  context = await createContext();
});

afterEach(async () => {
  await context.app.close();
  await context.client.close();
});

describe('admin contour (ADR-14, ADM-01/ADM-02/ADM-04)', () => {
  it('lists users with filters for the admin and hides them from other roles', async () => {
    const admin = await login('admin@logbook.local');
    const all = await admin.agent.get('/v1/admin/users').expect(200);
    expect(all.body.total).toBe(3);
    expect(all.body.items).toHaveLength(3);
    const workerRow = all.body.items.find(
      (row: Record<string, unknown>) => row.role === 'worker',
    );
    expect(workerRow).toMatchObject({
      email: 'worker@logbook.local',
      department_name: 'Участок №3',
    });

    const workers = await admin.agent
      .get('/v1/admin/users?role=worker')
      .expect(200);
    expect(workers.body.items).toHaveLength(1);

    const search = await admin.agent
      .get('/v1/admin/users?search=' + encodeURIComponent('Иванов'))
      .expect(200);
    expect(search.body.items).toHaveLength(1);
    expect(search.body.items[0].email).toBe('worker@logbook.local');

    const invalidRole = await admin.agent.get('/v1/admin/users?role=root');
    expect(invalidRole.status).toBe(400);

    const worker = await login('worker@logbook.local');
    await worker.agent.get('/v1/admin/users').expect(403);
    const supervisor = await login('supervisor@logbook.local');
    await supervisor.agent.get('/v1/admin/users').expect(403);
  });

  it('creates a user, changes role/status and revokes sessions', async () => {
    const admin = await login('admin@logbook.local');
    const email = `new.admin.${Date.now()}@logbook.local`;
    const created = await admin.agent
      .post('/v1/admin/users')
      .set(authHeaders(admin.csrf))
      .send({
        email,
        full_name: 'Новый Сотрудник',
        role: 'worker',
        department_id: SEED_UUIDS.departmentMain,
        position: 'Электромонтёр',
        password: 'DemoPass!2026',
      })
      .expect(201);
    const id = created.body.id as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    // A2: local account created by the administrator must be able to log in
    // with the password set in the admin form (not only the seed password).
    const createdLogin = await login(email, 'DemoPass!2026');
    const me = await createdLogin.agent.get('/v1/me').expect(200);
    expect(me.body.user.email).toBe(email);

    const patched = await admin.agent
      .patch(`/v1/admin/users/${id}`)
      .set(authHeaders(admin.csrf))
      .send({ role: 'supervisor', status: 'blocked' })
      .expect(200);
    expect(patched.body).toMatchObject({ role: 'supervisor', status: 'blocked' });

    const revoked = await admin.agent
      .post(`/v1/admin/users/${id}/revoke-sessions`)
      .set(authHeaders(admin.csrf))
      .expect(201);
    expect(revoked.body.ok).toBe(true);

    const list = await admin.agent
      .get(`/v1/admin/users?search=${encodeURIComponent(email)}`)
      .expect(200);
    expect(list.body.items[0]).toMatchObject({
      role: 'supervisor',
      status: 'blocked',
      position: 'Электромонтёр',
    });

    const audit = await admin.agent
      .get('/v1/audit?action=user.update')
      .expect(200);
    expect(
      audit.body.items.some(
        (row: Record<string, unknown>) => row.entity_id === id,
      ),
    ).toBe(true);

    const worker = await login('worker@logbook.local');
    await worker.agent
      .post('/v1/admin/users')
      .set(authHeaders(worker.csrf))
      .send({
        email: 'x@logbook.local',
        full_name: 'X X',
        role: 'admin',
        department_id: SEED_UUIDS.departmentMain,
      })
      .expect(403);
  });

  it('returns departments for the user forms', async () => {
    const admin = await login('admin@logbook.local');
    const response = await admin.agent.get('/v1/admin/departments').expect(200);
    expect(response.body.items.length).toBeGreaterThanOrEqual(2);
    expect(response.body.items[0]).toEqual(
      expect.objectContaining({ id: expect.any(String), name: expect.any(String) }),
    );
  });

  it('lists all devices and revokes any device as admin', async () => {
    const worker = await login('worker@logbook.local');
    const installId = `install-admin-test-${Date.now()}`;
    const registered = await worker.agent
      .post('/v1/devices')
      .set(authHeaders(worker.csrf))
      .send({ install_id: installId, name: 'Admin test device', platform: 'test' })
      .expect(201);
    expect(registered.body.device_key).toEqual(expect.any(String));
    // A worker cannot use the admin device inventory (403 before the revoke
    // below invalidates this very session).
    await worker.agent.get('/v1/admin/devices').expect(403);

    const admin = await login('admin@logbook.local');
    const devices = await admin.agent
      .get(`/v1/admin/devices?search=${installId}`)
      .expect(200);
    expect(devices.body.total).toBeGreaterThanOrEqual(1);
    const device = devices.body.items.find(
      (row: Record<string, unknown>) => row.install_id === installId,
    );
    expect(device).toMatchObject({
      status: 'active',
      user_name: 'Иванов Иван Иванович',
    });

    await admin.agent
      .delete(`/v1/admin/devices/${device.id}`)
      .set(authHeaders(admin.csrf))
      .expect(200);
    const revoked = await admin.agent
      .get(`/v1/admin/devices?search=${installId}&status=revoked`)
      .expect(200);
    expect(revoked.body.items[0]).toMatchObject({ status: 'revoked' });
  });

  it('exposes journals, members and grants for the admin SPA', async () => {
    const admin = await login('admin@logbook.local');
    const key = `admin-journal-${Date.now()}`;
    const created = await admin.agent
      .post('/v1/admin/journals')
      .set(authHeaders(admin.csrf))
      .send({ journal_key: key, name: 'Журнал админ-теста', sort_order: 90 })
      .expect(201);
    const journalId = created.body.id as string;

    const members = await admin.agent
      .get(`/v1/admin/journals/${journalId}/members`)
      .expect(200);
    expect(members.body.items).toEqual([]);

    await admin.agent
      .put(`/v1/admin/journals/${journalId}/members/${SEED_UUIDS.worker}`)
      .set(authHeaders(admin.csrf))
      .send({ access_level: 'read' })
      .expect(200);
    const granted = await admin.agent
      .get(`/v1/admin/journals/${journalId}/members`)
      .expect(200);
    expect(granted.body.items[0]).toMatchObject({
      user_id: SEED_UUIDS.worker,
      access_level: 'read',
    });

    await admin.agent
      .delete(`/v1/admin/journals/${journalId}/members/${SEED_UUIDS.worker}`)
      .set(authHeaders(admin.csrf))
      .expect(200);
    const removed = await admin.agent
      .get(`/v1/admin/journals/${journalId}/members`)
      .expect(200);
    expect(removed.body.items).toEqual([]);

    const patched = await admin.agent
      .patch(`/v1/admin/journals/${journalId}`)
      .set(authHeaders(admin.csrf))
      .send({ active: false })
      .expect(200);
    expect(patched.body.active).toBe(false);
  });

  it('shows permit import history for the admin', async () => {
    const admin = await login('admin@logbook.local');
    const response = await admin.agent.get('/v1/admin/imports').expect(200);
    expect(Array.isArray(response.body.items)).toBe(true);

    const worker = await login('worker@logbook.local');
    await worker.agent.get('/v1/admin/imports').expect(403);
  });

  it('returns the CSRF token in /me and allows the admin origin in CORS', async () => {
    const admin = await login('admin@logbook.local');
    const me = await admin.agent.get('/v1/me').expect(200);
    expect(me.body.csrf_token).toEqual(expect.any(String));

    const preflight = await request(context.app.getHttpServer())
      .options('/v1/admin/users')
      .set('Origin', 'http://localhost:5174')
      .set('Access-Control-Request-Method', 'GET');
    expect(preflight.headers['access-control-allow-origin']).toBe(
      'http://localhost:5174',
    );
    expect(preflight.headers['access-control-allow-credentials']).toBe('true');
  });

  it('keeps a unique audit stream for retention and user changes', async () => {
    const admin = await login('admin@logbook.local');
    const userId = uuidv7();
    await context.client.query(
      `insert into users (id, external_id, full_name, email, role, department_id, status)
       values ($1, $2, 'Аудит Тест', 'audit-test@logbook.local',
               'worker'::user_role_enum, $3, 'active'::user_status_enum)`,
      [userId, `ext-${userId}`, SEED_UUIDS.departmentMain],
    );
    await admin.agent
      .patch(`/v1/admin/users/${userId}`)
      .set(authHeaders(admin.csrf))
      .send({ status: 'deactivated' })
      .expect(200);
    const response = await admin.agent
      .get('/v1/audit?entity_type=user&limit=20')
      .expect(200);
    const actions = response.body.items.map(
      (row: Record<string, unknown>) => row.action,
    );
    expect(actions).toContain('user.update');
    for (const row of response.body.items) {
      expect(String(row.hash)).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
