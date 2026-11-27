import { readFileSync } from 'node:fs';

const base = process.env.DEMO_API ?? 'http://localhost:3000/v1';
const source = process.env.DEMO_SOURCE ?? 'csv';
const csv =
  source === 'csv'
    ? readFileSync(new URL('./permits.csv', import.meta.url), 'utf8')
    : undefined;
const records =
  source === 'json'
    ? JSON.parse(readFileSync(new URL('./permits.json', import.meta.url), 'utf8'))
    : undefined;

const loginResponse = await fetch(`${base}/auth/dev-login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({
    email: 'admin@logbook.local',
    password: 'Logbook!2026',
  }),
});

if (!loginResponse.ok) {
  console.error(`Login failed: ${loginResponse.status}`);
  process.exitCode = 1;
} else {
  const login = await loginResponse.json();
  const rawCookies =
    typeof loginResponse.headers.getSetCookie === 'function'
      ? loginResponse.headers.getSetCookie()
      : [loginResponse.headers.get('set-cookie') ?? ''];
  const cookies = rawCookies
    .map((cookie) => cookie.split(';')[0])
    .filter(Boolean)
    .join('; ');

  const response = await fetch(`${base}/admin/permits/import`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      cookie: cookies,
      'x-csrf-token': login.csrf_token,
    },
    body: JSON.stringify({ source_id: 'demo', csv, records }),
  });
  const result = await response.json();
  if (!response.ok) {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(result, null, 2));
    console.log(
      `Import: imported=${result.imported}, updated=${result.updated}, skipped=${result.skipped}`,
    );
  }
}
