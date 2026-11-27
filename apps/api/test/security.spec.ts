import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { SuperAgentTest } from 'supertest';
import { seedDatabase } from '../../../db/seed/seed';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import {
  API_CONTENT_SECURITY_POLICY,
  applySecurityHeaders,
} from '../src/common/security-headers';
import { FixedWindowRateLimiter } from '../src/common/rate-limit';
import { runMigrations } from '../src/db/migrator';
import { PgliteSqlClient } from '../src/db/pglite-client';
import { DB } from '../src/db/tokens';

process.env.RATE_LIMIT_ENABLED = 'true';
process.env.RATE_LIMIT_WINDOW_SECONDS = '60';
process.env.RATE_LIMIT_MAX = '3';
process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS = '60';
process.env.AUTH_RATE_LIMIT_MAX = '2';
process.env.SESSION_IDLE_MINUTES = '30';

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
  app: INestApplication,
  email = 'worker@logbook.local',
): Promise<{ agent: SuperAgentTest; csrf: string }> {
  const agent = request.agent(app.getHttpServer());
  const response = await agent
    .post('/v1/auth/dev-login')
    .send({ email, password: PASSWORD });
  return { agent: agent as unknown as SuperAgentTest, csrf: response.body?.csrf_token };
}

beforeEach(async () => {
  context = await createContext();
});

afterEach(async () => {
  await context.app.close();
  await context.client.close();
});

describe('security headers', () => {
  it('sets strict headers on API responses', async () => {
    const response = await request(context.app.getHttpServer())
      .get('/v1/health')
      .expect(200);

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['content-security-policy']).toBe(
      API_CONTENT_SECURITY_POLICY,
    );
    expect(response.headers['permissions-policy']).toContain('microphone=()');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-permitted-cross-domain-policies']).toBe('none');
    // HSTS is production-only; tests run with NODE_ENV=test.
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });

  it('adds HSTS only for production with a positive max-age', () => {
    const production: Record<string, string> = {};
    const response = {
      setHeader: (name: string, value: string) => {
        production[name] = value;
      },
    } as unknown as Parameters<typeof applySecurityHeaders>[0];
    applySecurityHeaders(response, {
      NODE_ENV: 'production',
      HSTS_MAX_AGE_SECONDS: 31536000,
    });
    expect(production['Strict-Transport-Security']).toBe(
      'max-age=31536000; includeSubDomains',
    );

    const development: Record<string, string> = {};
    applySecurityHeaders(
      {
        setHeader: (name: string, value: string) => {
          development[name] = value;
        },
      } as unknown as Parameters<typeof applySecurityHeaders>[0],
      { NODE_ENV: 'development', HSTS_MAX_AGE_SECONDS: 31536000 },
    );
    expect(development['Strict-Transport-Security']).toBeUndefined();
  });
});

describe('rate limiting', () => {
  it('limits auth attempts per IP and returns Retry-After', async () => {
    await request(context.app.getHttpServer())
      .post('/v1/auth/dev-login')
      .send({ email: 'worker@logbook.local', password: PASSWORD })
      .expect(200);

    await request(context.app.getHttpServer())
      .post('/v1/auth/dev-login')
      .send({ email: 'worker@logbook.local', password: 'wrong-password' })
      .expect(401);

    const limited = await request(context.app.getHttpServer())
      .post('/v1/auth/dev-login')
      .send({ email: 'worker@logbook.local', password: PASSWORD })
      .expect(429);
    expect(limited.body.error.code).toBe('E-RATE-01');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.headers['x-ratelimit-limit']).toBe('2');
    expect(limited.headers['x-content-type-options']).toBe('nosniff');
  });

  it('limits general API requests without limiting the login bucket', async () => {
    const worker = await login(context.app);
    expect(worker.csrf).toEqual(expect.any(String));

    await worker.agent.get('/v1/me').expect(200);
    await worker.agent.get('/v1/me').expect(200);
    await worker.agent.get('/v1/me').expect(200);
    const limited = await worker.agent.get('/v1/me').expect(429);
    expect(limited.body.error.code).toBe('E-RATE-01');
  });

  it('computes fixed windows deterministically', () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter(2, 1_000, () => now);
    expect(limiter.consume('ip').allowed).toBe(true);
    expect(limiter.consume('ip').allowed).toBe(true);
    const blocked = limiter.consume('ip');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(1);
    now += 1_001;
    expect(limiter.consume('ip').allowed).toBe(true);
  });
});

describe('session idle timeout (AUTH-04)', () => {
  it('rejects and revokes a session idle longer than SESSION_IDLE_MINUTES', async () => {
    const worker = await login(context.app);
    await worker.agent.get('/v1/me').expect(200);

    await context.client.query(
      `update sessions set last_seen_at = now() - interval '31 minutes'
        where user_id = (select id from users where email = 'worker@logbook.local')`,
    );

    await worker.agent.get('/v1/me').expect(401);
    const sessions = await context.client.query<{ revoked_at: string | null }>(
      `select revoked_at from sessions
        where user_id = (select id from users where email = 'worker@logbook.local')`,
    );
    expect(sessions.rows[0]?.revoked_at).not.toBeNull();
  });

  it('keeps a session active within the idle window', async () => {
    const worker = await login(context.app);
    await context.client.query(
      `update sessions set last_seen_at = now() - interval '5 minutes'
        where user_id = (select id from users where email = 'worker@logbook.local')`,
    );
    await worker.agent.get('/v1/me').expect(200);
  });
});
