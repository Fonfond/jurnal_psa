// PostgreSQL 15 acceptance smoke test for Logbook API.
//
//   node scripts/pg/smoke.mjs
//   BASE_URL=http://127.0.0.1:3101/v1 node scripts/pg/smoke.mjs
//
// Exercises: health, dev login (3 roles), /me, dictionaries, entries,
// device registration, sync push (50 ops), visa signature verification,
// journal review signature, audit and CSV export.

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:3101/v1').replace(/\/+$/, '');
const PASSWORD = process.env.DEV_SEED_PASSWORD ?? 'Logbook!2026';
const SIMPLE_WORK_TYPE = '01930000-0000-7000-8000-000000000302';
const FIELD_SITE = '01930000-0000-7000-8000-000000000402';

const checks = [];
function check(name, condition, details = '') {
  checks.push({ name, ok: Boolean(condition), details });
  const mark = condition ? 'ok  ' : 'FAIL';
  console.log(`[${mark}] ${name}${details ? ` вЂ” ${details}` : ''}`);
  if (!condition) {
    throw new Error(`Smoke check failed: ${name}`);
  }
}

class Session {
  constructor(email, role) {
    this.email = email;
    this.role = role;
    this.cookies = new Map();
    this.csrf = '';
    this.deviceId = null;
    this.deviceKey = null;
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  storeCookies(response) {
    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const raw of setCookie) {
      const [pair] = raw.split(';');
      const index = pair.indexOf('=');
      if (index > 0) {
        this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
      }
    }
  }

  async request(method, path, body, extraHeaders = {}) {
    const headers = { accept: 'application/json', ...extraHeaders };
    if (this.cookies.size > 0) headers.cookie = this.cookieHeader();
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.storeCookies(response);
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: response.status, data, text };
  }

  async expect(method, path, status, body, extraHeaders) {
    const response = await this.request(method, path, body, extraHeaders);
    if (response.status !== status) {
      throw new Error(
        `${method} ${path}: expected ${status}, got ${response.status}: ${response.text.slice(0, 300)}`,
      );
    }
    return response.data;
  }

  async login() {
    const data = await this.expect('POST', '/auth/dev-login', 200, {
      email: this.email,
      password: PASSWORD,
    });
    this.csrf = data.csrf_token;
    check(`login ${this.role}`, data.user?.role === this.role, data.user?.email);
    return data;
  }

  async registerDevice(installId) {
    const data = await this.expect('POST', '/devices', 201, {
      install_id: installId,
      name: `smoke-${this.role}`,
      platform: 'node-smoke',
      app_version: '0.3.0',
    });
    this.deviceId = data.device.id;
    this.deviceKey = data.device_key;
    check(
      `device registration ${this.role}`,
      typeof this.deviceId === 'string' && typeof this.deviceKey === 'string',
      `device=${this.deviceId}`,
    );
    return data.device;
  }
}

function op(index, entityId) {
  return {
    op_id: crypto.randomUUID(),
    entity_type: 'entry',
    entity_id: entityId,
    op_type: 'create',
    base_version: null,
    hlc: `${Date.now()}:00001:smoke001`,
    client_time: new Date().toISOString(),
    payload: {
      performed_at: new Date().toISOString(),
      performed_tz_offset_min: 180,
      work_type_id: SIMPLE_WORK_TYPE,
      site_id: FIELD_SITE,
      text: `Smoke-Р·Р°РїРёСЃСЊ ${index} РЅР° PostgreSQL 15: РїСЂРѕРІРµСЂРєР° СЃРёРЅС…СЂРѕРЅРёР·Р°С†РёРё`,
      input_method: 'manual',
    },
  };
}

async function main() {
  const startedAt = Date.now();

  const anon = new Session('', 'anonymous');
  const health = await anon.expect('GET', '/health', 200);
  check('health', health.status === 'ok' && health.db === 'ok', `latency=${health.latency_ms}ms`);

  const worker = new Session('worker@logbook.local', 'worker');
  const supervisor = new Session('supervisor@logbook.local', 'supervisor');
  const admin = new Session('admin@logbook.local', 'admin');
  await worker.login();
  await supervisor.login();
  await admin.login();

  const me = await worker.expect('GET', '/me', 200);
  check('me', me.user.role === 'worker' && Boolean(me.auth), me.user.full_name);

  const snapshot = await worker.expect('GET', '/dictionaries/snapshot', 200);
  check('dictionaries snapshot', snapshot.work_types.items.length >= 3);

  const entries = await worker.expect('GET', '/entries?limit=10', 200);
  check('entries list', Array.isArray(entries.items) && entries.items.length > 0);

  await worker.registerDevice(`smoke-install-${Date.now()}`);

  const entityIds = Array.from({ length: 50 }, () => crypto.randomUUID());
  const push = await worker.expect(
    'POST',
    '/sync/push',
    200,
    {
      device_id: worker.deviceId,
      app_version: '0.3.0',
      ops: entityIds.map((id, index) => op(index, id)),
    },
    { 'x-device-key': worker.deviceKey },
  );
  const applied = push.results.filter((result) => result.status === 'applied');
  check('sync push 50 ops', applied.length === 50, `applied=${applied.length}/50`);
  const firstEntity = entityIds[0];

  const verified = await supervisor.expect('POST', `/entries/${firstEntity}/verify`, 201);
  check(
    'visa auto-signature',
    verified.signature?.kind === 'simple' && verified.signature.content_hash.length === 64,
    `signature=${verified.signature?.id}`,
  );

  const entry = await worker.expect('GET', `/entries/${firstEntity}`, 200);
  check('entry signatures visible', entry.signatures?.length === 1);

  const signatureCheck = await supervisor.expect(
    'POST',
    `/signature/${entry.signatures[0].id}/verify`,
    200,
  );
  check('signature verify', signatureCheck.valid === true);

  const review = await supervisor.expect('POST', '/journal/reviews', 201, {
    period_start: '2026-01-01',
    period_end: '2026-12-31',
    remarks: 'Smoke on PostgreSQL 15',
  });
  check('journal review', Number(review.entries_count) > 0 && review.content_hash.length === 64);

  const reviewSignatures = await supervisor.expect(
    'GET',
    `/journal/reviews/${review.id}/signatures`,
    200,
  );
  check('review signature', reviewSignatures.items.length === 1);

  const audit = await admin.expect('GET', '/audit?limit=10', 200);
  check('audit hash chain', audit.items.length > 0 && audit.items[0].hash.length === 64);

  // 0009_shifts and 0010_groundings: endpoints must work on PostgreSQL.
  const shifts = await worker.expect('GET', '/shifts?limit=10', 200);
  check('shifts endpoint (0009)', Array.isArray(shifts.items), `items=${shifts.items.length}`);
  const groundings = await worker.expect('GET', '/groundings?limit=10', 200);
  check(
    'groundings endpoint (0010)',
    Array.isArray(groundings.items),
    `items=${groundings.items.length}`,
  );

  const csv = await worker.request('GET', '/journal/export?from=2026-01-01&to=2026-12-31');
  check(
    'CSV export',
    csv.status === 200 && csv.text.includes('journal_seq,date_time,content'),
    `bytes=${csv.text.length}`,
  );

  const logout = await worker.expect('POST', '/auth/logout', 200);
  check('logout', logout.ok === true);
  const afterLogout = await worker.request('GET', '/me');
  check('session revoked', afterLogout.status === 401);

  const durationMs = Date.now() - startedAt;
  const summary = { base: BASE, checks: checks.length, failed: 0, duration_ms: durationMs };
  console.log(`SMOKE OK: ${checks.length} checks in ${durationMs} ms`);
  console.log(JSON.stringify(summary));
}

main().catch((error) => {
  console.error(`SMOKE FAILED: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});

