#!/usr/bin/env node
// Writes poc/results/devices.csv (actual environment) and artifacts.csv (SHA-256).
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const RESULTS = path.join(ROOT, 'poc/results');

const devices = [
  ['device_id', 'model', 'class', 'os', 'browser', 'browser_version', 'screen', 'notes'],
  ['D6', 'Windows 11 desktop (headless CI workstation)', 'A', 'Windows 11', 'Edge', '158.0.4370.33', '1920x1080', 'Actual PoC host; not an approved G1 device; no iOS/Android devices available'],
];
fs.writeFileSync(
  path.join(RESULTS, 'devices.csv'),
  devices.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n',
  'utf8',
);

const files = [
  'poc/g1/harness.html',
  'poc/g1/g1.js',
  'poc/g2/harness.html',
  'poc/g2/g2.js',
  'poc/g3/hlc.mjs',
  'poc/g3/merge.mjs',
  'poc/g3/change-log.mjs',
  'poc/g3/idempotency.mjs',
  'poc/g3/store.mjs',
  'poc/g3/server.mjs',
  'poc/g3/scenarios.mjs',
  'poc/g3/run.mjs',
  'poc/tools/serve.mjs',
  'poc/tools/cdp.mjs',
  'poc/tools/run-g1.mjs',
  'poc/tools/run-g2.mjs',
  'poc/tools/validate-results.mjs',
  'poc/results/g1_measurements.csv',
  'poc/results/g2_measurements.csv',
  'poc/results/g3_runs.csv',
  'poc/report.md',
];

const lines = ['artifact_id,path,sha256,size_bytes,created_at'];
files.forEach((relative, index) => {
  const absolute = path.join(ROOT, relative);
  const content = fs.readFileSync(absolute);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const artifactId = `POC-${String(index + 1).padStart(3, '0')}`;
  const createdAt = fs.statSync(absolute).mtime.toISOString();
  lines.push([artifactId, relative, hash, content.length, createdAt].map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','));
});
fs.writeFileSync(path.join(RESULTS, 'artifacts.csv'), `${lines.join('\n')}\n`, 'utf8');
console.log(`devices.csv + artifacts.csv: ${files.length} artifacts`);
