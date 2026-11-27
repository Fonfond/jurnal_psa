#!/usr/bin/env node
// Structural and logical validation of PoC CSV results.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const RESULTS = path.join(ROOT, 'poc/results');
const errors = [];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') field += char;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((line) => line.some((cell) => cell.trim().length > 0));
}

function load(name, headers) {
  const file = path.join(RESULTS, name);
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  if (rows.length === 0) {
    errors.push(`${name}: empty`);
    return [];
  }
  if (rows[0].join(',') !== headers.join(',')) {
    errors.push(`${name}: header mismatch\n  expected ${headers.join(',')}\n  actual   ${rows[0].join(',')}`);
  }
  return rows.slice(1).map((line, index) => {
    const record = {};
    headers.forEach((header, column) => (record[header] = line[column] ?? ''));
    if (line.length !== headers.length) errors.push(`${name}:${index + 2}: ${line.length} columns, expected ${headers.length}`);
    return record;
  });
}

function checkBool(rows, name, field) {
  for (const [index, row] of rows.entries()) {
    if (!['true', 'false'].includes(row[field])) {
      errors.push(`${name}:${index + 2}: ${field}=${row[field]} is not boolean`);
    }
  }
}

function checkRunIds(rows, name) {
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    if (seen.has(row.run_id)) errors.push(`${name}:${index + 2}: duplicate run_id ${row.run_id}`);
    seen.add(row.run_id);
    if (!/^G[123]-\d{4}$/.test(row.run_id)) errors.push(`${name}:${index + 2}: bad run_id ${row.run_id}`);
  }
}

const G1 = load('g1_measurements.csv', [
  'run_id', 'date_utc', 'device_id', 'device_class', 'os', 'browser', 'browser_version',
  'model_id', 'model_size_mb', 'scenario', 'audio_file', 'audio_duration_s', 'latency_s',
  'rtf', 'peak_mem_mb', 'wer', 'crashed', 'notes',
]);
const G2 = load('g2_measurements.csv', [
  'run_id', 'date_utc', 'device_id', 'os', 'browser', 'scenario', 'records', 'ops',
  'quota_mb', 'persist_granted', 'atomic_ok', 'data_loss', 'export_ok', 'restore_ok',
  'migration_ok', 'duration_ms', 'notes',
]);
const G3 = load('g3_runs.csv', [
  'run_id', 'date_utc', 'scenario_id', 'conflict_id', 'ops_count', 'repeats',
  'delivery_order', 'expected', 'actual', 'data_loss', 'deterministic', 'latency_ms', 'notes',
]);

checkRunIds(G1, 'g1');
checkRunIds(G2, 'g2');
checkRunIds(G3, 'g3');
checkBool(G2, 'g2', 'persist_granted');
checkBool(G2, 'g2', 'atomic_ok');
checkBool(G2, 'g2', 'data_loss');
checkBool(G2, 'g2', 'export_ok');
checkBool(G2, 'g2', 'restore_ok');
checkBool(G2, 'g2', 'migration_ok');
checkBool(G3, 'g3', 'data_loss');
checkBool(G3, 'g3', 'deterministic');
checkBool(G1, 'g1', 'crashed');

for (const [index, row] of [...G1, ...G2, ...G3].entries()) {
  if (!row.date_utc || Number.isNaN(Date.parse(row.date_utc))) {
    errors.push(`CSV:${index + 2}: bad date_utc ${row.date_utc}`);
  }
  if (!row.notes || row.notes.trim().length === 0) errors.push(`CSV:${index + 2}: empty notes`);
}

if (G1.length !== 12) errors.push(`g1: ${G1.length} rows, expected 12 blocked rows`);
if (!G1.every((row) => row.notes.includes('BLOCKED'))) errors.push('g1: all rows must be marked BLOCKED');
if (!G1.every((row) => row.crashed === 'false')) errors.push('g1: crashed must be false for blocked rows');

const g2Scenarios = new Set(G2.map((row) => row.scenario));
for (let index = 1; index <= 12; index += 1) {
  const id = `POC-G2-${String(index).padStart(2, '0')}`;
  if (!g2Scenarios.has(id)) errors.push(`g2: missing ${id}`);
}
if (G2.some((row) => row.data_loss === 'true')) errors.push('g2: data_loss=true found');

const g3Scenarios = new Set(G3.map((row) => row.scenario_id));
for (let index = 1; index <= 24; index += 1) {
  const id = `POC-G3-${String(index).padStart(2, '0')}`;
  if (!g3Scenarios.has(id)) errors.push(`g3: missing ${id}`);
}
if (G3.some((row) => row.data_loss === 'true')) errors.push('g3: data_loss=true found');
if (G3.some((row) => row.deterministic !== 'true')) errors.push('g3: deterministic=false found');
if (G3.length < 300) errors.push(`g3: ${G3.length} rows, expected >= 300`);

const summary = {
  g1_rows: G1.length,
  g2_rows: G2.length,
  g3_rows: G3.length,
  g2_scenarios: g2Scenarios.size,
  g3_scenarios: g3Scenarios.size,
  errors,
};
console.log(JSON.stringify(summary, null, 2));
if (errors.length > 0) process.exitCode = 1;
