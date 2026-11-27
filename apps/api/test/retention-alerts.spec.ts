import { createServer, type Server } from 'node:http';
import { runMigrations } from '../src/db/migrator';
import { PgliteSqlClient } from '../src/db/pglite-client';
import { RetentionAlertService } from '../src/export/retention-alert.service';

const ORIGINAL_WEBHOOK = process.env.RETENTION_ALERT_WEBHOOK_URL;
const ORIGINAL_TIMEOUT = process.env.RETENTION_ALERT_TIMEOUT_MS;

process.env.RETENTION_ALERT_WEBHOOK_URL = 'http://127.0.0.1:1/replaced-later';
process.env.RETENTION_ALERT_TIMEOUT_MS = '1000';

interface ReceivedAlert {
  source: string;
  alert: { kind: string; severity: string; id: string };
  context: Record<string, unknown>;
}

describe('retention alerts (REP-05)', () => {
  let client: PgliteSqlClient;
  let service: RetentionAlertService;
  let server: Server | null = null;
  let received: ReceivedAlert[] = [];
  let webhookStatus = 200;

  beforeEach(async () => {
    client = new PgliteSqlClient();
    await runMigrations(client);
    received = [];
    webhookStatus = 200;
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.statusCode = webhookStatus;
        response.end('{}');
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('webhook server failed to bind');
    }
    process.env.RETENTION_ALERT_WEBHOOK_URL = `http://127.0.0.1:${address.port}/alerts`;
    // The AlertService reads loadEnv() lazily; force a fresh parse with the URL.
    const { loadEnv } = await import('../src/config/env');
    loadEnv(true);
    service = new RetentionAlertService(client);
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server = null;
    await client.close();
  });

  afterAll(async () => {
    if (ORIGINAL_WEBHOOK === undefined) {
      delete process.env.RETENTION_ALERT_WEBHOOK_URL;
    } else {
      process.env.RETENTION_ALERT_WEBHOOK_URL = ORIGINAL_WEBHOOK;
    }
    if (ORIGINAL_TIMEOUT === undefined) {
      delete process.env.RETENTION_ALERT_TIMEOUT_MS;
    } else {
      process.env.RETENTION_ALERT_TIMEOUT_MS = ORIGINAL_TIMEOUT;
    }
    const { resetEnvCache } = await import('../src/config/env');
    resetEnvCache();
  });

  it('persists and delivers an alert to the webhook', async () => {
    const alert = await service.raise('run_failed', 'critical', 'test failure', {
      run_id: 'run-1',
    });
    expect(alert.kind).toBe('run_failed');
    expect(alert.delivered_at).not.toBeNull();
    expect(alert.delivery_error).toBeNull();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      source: 'logbook',
      alert: { kind: 'run_failed', severity: 'critical', id: alert.id },
      context: { run_id: 'run-1' },
    });

    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(await service.countSince(24)).toBe(1);
  });

  it('keeps the alert when webhook delivery fails', async () => {
    webhookStatus = 503;
    const alert = await service.raise('run_overdue', 'critical', 'overdue', {});
    expect(alert.delivered_at).toBeNull();
    expect(alert.delivery_error).toContain('HTTP 503');
    const list = await service.list();
    expect(list[0]).toMatchObject({ kind: 'run_overdue', delivery_error: expect.stringContaining('503') });
  });
});
