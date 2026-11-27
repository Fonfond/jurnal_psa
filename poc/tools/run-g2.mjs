#!/usr/bin/env node
// Runs the G2 browser harness in headless Edge and writes poc/results/g2_measurements.csv.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchEdge, connectToPage } from './cdp.mjs';
import { createStaticServer } from './serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const RESULTS = path.join(ROOT, 'poc/results');
const LOGS = path.join(RESULTS, 'logs');
fs.mkdirSync(LOGS, { recursive: true });

const HEADERS = [
  'run_id',
  'date_utc',
  'device_id',
  'os',
  'browser',
  'scenario',
  'records',
  'ops',
  'quota_mb',
  'persist_granted',
  'atomic_ok',
  'data_loss',
  'export_ok',
  'restore_ok',
  'migration_ok',
  'duration_ms',
  'notes',
];

function csv(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

const server = createStaticServer({ port: 8087 });
const { url } = await server.listen();
const edge = await launchEdge({ port: 9333 });

try {
  const page = await connectToPage({ port: 9333, url: `${url}/g2/harness.html` });
  const resultText = await page.evaluate(
    `new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (window.__POC_G2__) {
          resolve(JSON.stringify(window.__POC_G2__));
          return;
        }
        if (Date.now() - started > 600000) {
          reject(new Error('G2 harness timeout'));
          return;
        }
        setTimeout(tick, 250);
      };
      tick();
    })`,
    { awaitPromise: true, returnByValue: true },
  );
  const result = JSON.parse(resultText);
  if (result.error) throw new Error(result.error);
  const rows = result.rows ?? [];
  const lines = [HEADERS.join(',')];
  for (const row of rows) {
    lines.push(HEADERS.map((key) => csv(row[key])).join(','));
  }
  fs.writeFileSync(path.join(RESULTS, 'g2_measurements.csv'), `${lines.join('\n')}\n`, 'utf8');
  fs.writeFileSync(
    path.join(LOGS, 'g2-run.json'),
    `${JSON.stringify(result.summary ?? {}, null, 2)}\n`,
    'utf8',
  );
  console.log(JSON.stringify({ ...result.summary, rows: rows.length }, null, 2));
  await page.close();
} finally {
  await edge.close();
  await server.close();
}
