// HTTP load test for Logbook API on PostgreSQL 15 (QA-06 smoke load).
//
//   BASE_URL=http://127.0.0.1:3101/v1 DURATION_MS=60000 CONCURRENCY=20 \
//     node scripts/pg/loadtest.mjs
//
// Mix: reads (GET /entries), changes (GET /sync/changes?limit=200),
// push (POST /sync/push with 50 ops), snapshot (GET /dictionaries/snapshot).
// Prints p50/p95/p99 per scenario and applies QA-06 thresholds:
//   entries p95 <= 300 ms, changes p95 <= 500 ms, push 50 ops p95 <= 400 ms,
//   error rate < 0.1 %, total RPS target >= 50 (informational).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:3101/v1').replace(/\/+$/, '');
const PASSWORD = process.env.DEV_SEED_PASSWORD ?? 'Logbook!2026';
const DURATION_MS = Number(process.env.DURATION_MS ?? 60_000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 20);
const RAMP_MS = Number(process.env.RAMP_MS ?? 5_000);
const WARMUP_MS = Number(process.env.WARMUP_MS ?? 0);
const SIMPLE_WORK_TYPE = '01930000-0000-7000-8000-000000000302';
const FIELD_SITE = '01930000-0000-7000-8000-000000000402';
const MIX = Object.fromEntries(
  (process.env.MIX ?? 'read:50,changes:15,push:30,snapshot:5')
    .split(',')
    .map((entry) => {
      const [name, weight] = entry.split(':');
      return [name.trim(), Number(weight ?? 0)];
    })
    .filter(([name, weight]) => name && weight > 0),
);
const THRESHOLDS = { read: 300, changes: 500, push: 400 };

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const resultsDir = join(root, '.data', 'pg15', 'results');
mkdirSync(resultsDir, { recursive: true });

class Client {
  constructor(email) {
    this.email = email;
    this.cookies = new Map();
    this.csrf = '';
    this.deviceId = null;
    this.deviceKey = null;
    this.hlcCounter = 0;
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
  }

  storeCookies(response) {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const index = pair.indexOf('=');
      if (index > 0) this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }

  async call(method, path, body, token, extraHeaders = {}) {
    const headers = { accept: 'application/json', ...extraHeaders };
    if (this.cookies.size > 0) headers.cookie = this.cookieHeader();
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const started = performance.now();
    let status = 0;
    try {
      const response = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      status = response.status;
      this.storeCookies(response);
      await response.text();
      return { status, latency: performance.now() - started };
    } catch (error) {
      return { status: 0, latency: performance.now() - started, error };
    }
  }

  async login() {
    const result = await this.call('POST', '/auth/dev-login', {
      email: this.email,
      password: PASSWORD,
    });
    if (result.status !== 200) throw new Error(`login ${this.email}: ${result.status}`);
    const response = await fetch(`${BASE}/auth/dev-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: this.email, password: PASSWORD }),
    });
    // Second call is unnecessary; re-read CSRF from the first response instead.
    void response;
  }
}

// Reimplement login cleanly: need the response body for csrf_token.
async function login(email, installPrefix) {
  const client = new Client(email);
  const response = await fetch(`${BASE}/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (response.status !== 200) {
    throw new Error(`login ${email} failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  client.csrf = data.csrf_token;
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const index = pair.indexOf('=');
    if (index > 0) client.cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }

  const installId = `${installPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const registration = await client.call('POST', '/devices', {
    install_id: installId,
    name: `load-${email.split('@')[0]}`,
    platform: 'node-loadtest',
    app_version: '0.3.0',
  });
  if (registration.status !== 201) {
    throw new Error(`device registration ${email}: ${registration.status}`);
  }
  const registrationResponse = await fetch(`${BASE}/devices`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: client.cookieHeader(),
      'x-csrf-token': client.csrf,
    },
    body: JSON.stringify({
      install_id: `${installId}-retry`,
      name: 'load-retry',
      platform: 'node-loadtest',
      app_version: '0.3.0',
    }),
  });
  // We need the device key: re-register with rotate_key on the first device.
  const firstRegistration = await fetch(`${BASE}/devices`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: client.cookieHeader(),
      'x-csrf-token': client.csrf,
    },
    body: JSON.stringify({ install_id: installId, rotate_key: true }),
  });
  const registered = await firstRegistration.json();
  void registrationResponse;
  client.deviceId = registered.device.id;
  client.deviceKey = registered.device_key;
  return client;
}

function nextHlc(client) {
  client.hlcCounter += 1;
  const node = `load${String((client.hlcCounter % 9) + 1).padStart(4, '0')}`;
  return `${Date.now()}:${String(client.hlcCounter % 100000).padStart(5, '0')}:${node}`;
}

function pushBody(client) {
  return {
    device_id: client.deviceId,
    app_version: '0.3.0',
    ops: Array.from({ length: 50 }, (_, index) => ({
      op_id: crypto.randomUUID(),
      entity_type: 'entry',
      entity_id: crypto.randomUUID(),
      op_type: 'create',
      base_version: null,
      hlc: nextHlc(client),
      client_time: new Date().toISOString(),
      payload: {
        performed_at: new Date().toISOString(),
        performed_tz_offset_min: 180,
        work_type_id: SIMPLE_WORK_TYPE,
        site_id: FIELD_SITE,
        text: `РќР°РіСЂСѓР·РѕС‡РЅР°СЏ Р·Р°РїРёСЃСЊ ${index} РЅР° PostgreSQL 15: РїСЂРѕРІРµСЂРєР° p95 push`,
        input_method: 'manual',
      },
    })),
  };
}

function pickScenario() {
  const total = Object.values(MIX).reduce((sum, value) => sum + value, 0);
  let roll = Math.random() * total;
  for (const [name, weight] of Object.entries(MIX)) {
    roll -= weight;
    if (roll <= 0) return name;
  }
  return 'read';
}

async function callScenario(client, scenario) {
  switch (scenario) {
    case 'push':
      return client.call(
        'POST',
        '/sync/push',
        pushBody(client),
        undefined,
        { 'x-device-key': client.deviceKey },
      );
    case 'changes':
      return client.call('GET', '/sync/changes?since_seq=0&limit=200');
    case 'snapshot':
      return client.call('GET', '/dictionaries/snapshot');
    default:
      return client.call('GET', '/entries?limit=50');
  }
}

function percentile(sorted, value) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((value / 100) * sorted.length) - 1);
  return sorted[index];
}

/**
 * F-01 residual (t32): statistics must be refreshed after bulk/scale/import
 * data, immediately before measurement. Loadtest owns the dataset in many
 * runs, so it does this itself when DATABASE_URL is available. Set
 * LOADTEST_ANALYZE=0 only for an explicit "no-ANALYZE" finding run.
 */
async function analyzeBeforeLoad() {
  if (process.env.LOADTEST_ANALYZE === '0') {
    console.warn('ANALYZE skipped (LOADTEST_ANALYZE=0): results are not acceptance evidence');
    return;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn('ANALYZE skipped: DATABASE_URL is not set (loadtest still runs)');
    return;
  }
  const pool = new Pool({
    connectionString,
    ssl:
      process.env.DATABASE_SSL_MODE === 'disable'
        ? undefined
        : { rejectUnauthorized: false },
    max: 1,
  });
  const started = Date.now();
  try {
    await pool.query('ANALYZE');
    console.log(`ANALYZE before load: done in ${Date.now() - started} ms`);
  } finally {
    await pool.end();
  }
}

async function main() {
  console.log(
    `Load test: base=${BASE} duration=${DURATION_MS}ms concurrency=${CONCURRENCY} ramp=${RAMP_MS}ms`,
  );
  await analyzeBeforeLoad();
  const clients = [];
  const emails = [
    'worker@logbook.local',
    'supervisor@logbook.local',
    'admin@logbook.local',
  ];
  for (const email of emails) {
    clients.push(await login(email, 'load'));
  }
  console.log(`Sessions ready: ${clients.length}; devices registered`);

  if (WARMUP_MS > 0) {
    // Cold acceptance: push data first, then refresh statistics, and only then
    // measure. The warm-up does not contribute to the reported percentiles.
    console.log(`Warm-up ${WARMUP_MS}ms (not measured) ...`);
    const warmDeadline = Date.now() + WARMUP_MS;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async (_, index) => {
        const client = clients[index % clients.length];
        while (Date.now() < warmDeadline) {
          await callScenario(client, pickScenario());
        }
      }),
    );
    await analyzeBeforeLoad();
    console.log('Warm-up complete; statistics refreshed before measurement');
  }

  const metrics = { read: [], changes: [], push: [], snapshot: [] };
  const statuses = { '2xx': 0, '4xx': 0, '5xx': 0, network: 0 };
  let requests = 0;
  const startedAt = Date.now();
  const deadline = startedAt + DURATION_MS;

  const workers = Array.from({ length: CONCURRENCY }, async (_, index) => {
    await new Promise((resolve) => setTimeout(resolve, (index / CONCURRENCY) * RAMP_MS));
    const client = clients[index % clients.length];
    while (Date.now() < deadline) {
      const scenario = pickScenario();
      const result = await callScenario(client, scenario);
      requests += 1;
      if (result.status === 0) statuses.network += 1;
      else if (result.status >= 500) statuses['5xx'] += 1;
      else if (result.status >= 400) statuses['4xx'] += 1;
      else statuses['2xx'] += 1;
      if (result.status >= 200 && result.status < 300) {
        metrics[scenario].push(result.latency);
      }
    }
  });
  await Promise.all(workers);
  const elapsedMs = Date.now() - startedAt;

  const summary = { started_at: new Date(startedAt).toISOString(), base: BASE, duration_ms: elapsedMs, concurrency: CONCURRENCY, requests, rps: requests / (elapsedMs / 1000), statuses, scenarios: {}, thresholds: THRESHOLDS };
  const failures = [];
  for (const [scenario, values] of Object.entries(metrics)) {
    const sorted = [...values].sort((left, right) => left - right);
    const stats = {
      count: sorted.length,
      p50_ms: Number(percentile(sorted, 50).toFixed(1)),
      p95_ms: Number(percentile(sorted, 95).toFixed(1)),
      p99_ms: Number(percentile(sorted, 99).toFixed(1)),
      max_ms: Number((sorted[sorted.length - 1] ?? 0).toFixed(1)),
    };
    summary.scenarios[scenario] = stats;
    if (THRESHOLDS[scenario] && stats.p95_ms > THRESHOLDS[scenario] && stats.count > 0) {
      failures.push(`${scenario} p95 ${stats.p95_ms}ms > ${THRESHOLDS[scenario]}ms`);
    }
  }
  const errorRate = requests === 0 ? 1 : (statuses['4xx'] + statuses['5xx'] + statuses.network) / requests;
  summary.error_rate = Number(errorRate.toFixed(5));
  if (errorRate >= 0.001) failures.push(`error rate ${(errorRate * 100).toFixed(3)}% >= 0.1%`);
  summary.failures = failures;

  console.log('');
  console.log('scenario   count    p50     p95     p99     max');
  for (const [scenario, stats] of Object.entries(summary.scenarios)) {
    console.log(
      `${scenario.padEnd(10)} ${String(stats.count).padStart(6)} ${String(stats.p50_ms).padStart(7)} ${String(stats.p95_ms).padStart(7)} ${String(stats.p99_ms).padStart(7)} ${String(stats.max_ms).padStart(7)}`,
    );
  }
  console.log(
    `requests=${requests} rps=${summary.rps.toFixed(1)} 2xx=${statuses['2xx']} 4xx=${statuses['4xx']} 5xx=${statuses['5xx']} network=${statuses.network} error_rate=${(errorRate * 100).toFixed(3)}%`,
  );
  if (failures.length > 0) {
    console.log(`THRESHOLD FAILURES: ${failures.join('; ')}`);
  } else {
    console.log('All QA-06 thresholds passed.');
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(resultsDir, `load-${stamp}.json`);
  writeFileSync(file, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`Result JSON: ${file}`);

  if (failures.length > 0 && process.env.STRICT === '1') {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`LOAD TEST FAILED: ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
});

