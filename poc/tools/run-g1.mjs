#!/usr/bin/env node
// Runs the G1 harness and records the blocked/available status as CSV.
// G1 cannot be measured here: no model, corpus, or approved devices.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from './serve.mjs';
import { DEFAULT_EDGE } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const RESULTS = path.join(ROOT, 'poc/results');
const LOGS = path.join(RESULTS, 'logs');
fs.mkdirSync(LOGS, { recursive: true });

const HEADERS = [
  'run_id',
  'date_utc',
  'device_id',
  'device_class',
  'os',
  'browser',
  'browser_version',
  'model_id',
  'model_size_mb',
  'scenario',
  'audio_file',
  'audio_duration_s',
  'latency_s',
  'rtf',
  'peak_mem_mb',
  'wer',
  'crashed',
  'notes',
];

function csv(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function runEdge(url) {
  return new Promise((resolve) => {
    const child = spawn(
      DEFAULT_EDGE,
      [
        '--headless=new',
        '--disable-gpu',
        '--incognito',
        '--no-first-run',
        '--virtual-time-budget=15000',
        '--dump-dom',
        url,
      ],
      { windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

const server = createStaticServer({ port: 8088 });
const { url } = await server.listen();
try {
  const result = await runEdge(`${url}/g1/harness.html?autorun=1`);
  const match = /<pre id="poc-result">([\s\S]*?)<\/pre>/.exec(result.stdout);
  if (!match) {
    throw new Error(`G1 harness result not found (exit ${result.code})`);
  }
  const harness = JSON.parse(match[1]);
  fs.writeFileSync(
    path.join(LOGS, 'g1-run.json'),
    `${JSON.stringify({ harness, edge: { exit: result.code, stderr: result.stderr.slice(-2000) } }, null, 2)}\n`,
    'utf8',
  );
  const lines = [HEADERS.join(',')];
  const stamp = new Date().toISOString();
  for (let index = 1; index <= 12; index += 1) {
    const scenario = `POC-G1-${String(index).padStart(2, '0')}`;
    const row = {
      run_id: `G1-${String(index).padStart(4, '0')}`,
      date_utc: stamp,
      device_id: 'D6',
      device_class: 'A',
      os: 'Windows 11',
      browser: 'Edge',
      browser_version: '158.0.4370.33',
      model_id: 'none',
      model_size_mb: 'n/a',
      scenario,
      audio_file: 'n/a',
      audio_duration_s: 'n/a',
      latency_s: 'n/a',
      rtf: 'n/a',
      peak_mem_mb: 'n/a',
      wer: 'n/a',
      crashed: 'false',
      notes: `BLOCKED: not executed — ${harness.reason} Harness: ${harness.status}; D6 is not an approved G1 device.`,
    };
    lines.push(HEADERS.map((key) => csv(row[key])).join(','));
  }
  fs.writeFileSync(path.join(RESULTS, 'g1_measurements.csv'), `${lines.join('\n')}\n`, 'utf8');
  console.log(JSON.stringify({ status: harness.status, reason: harness.reason, rows: 12 }, null, 2));
} finally {
  await server.close();
}
