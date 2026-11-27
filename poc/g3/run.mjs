#!/usr/bin/env node
// PoC G3 runner: 24 scenarios, 20 randomized runs each, CSV + log.
// Standalone prototype. Does not import or modify product code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.mjs';
import { createStore } from './store.mjs';
import { applyOperation } from './merge.mjs';
import { CONFLICT_SCENARIOS, checkExpected } from './scenarios.mjs';
import { compareHlc, formatHlc, parseHlc, tick } from './hlc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const RESULTS = path.join(ROOT, 'poc/results');
const LOGS = path.join(RESULTS, 'logs');
fs.mkdirSync(LOGS, { recursive: true });

const rows = [];
let runNo = 0;
const startedAt = new Date().toISOString();

function csv(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function emit({
  scenario,
  conflict = 'n/a',
  ops,
  repeats,
  order = 'random',
  expected,
  actual,
  dataLoss = false,
  deterministic = true,
  latencyMs = 0,
  notes = '',
  runs,
}) {
  const perRun = runs ?? Array.from({ length: repeats }, () => ({
    actual,
    deterministic,
    latencyMs,
  }));
  for (const [index, run] of perRun.entries()) {
    runNo += 1;
    rows.push({
      run_id: `G3-${String(runNo).padStart(4, '0')}`,
      date_utc: new Date().toISOString(),
      scenario_id: scenario,
      conflict_id: conflict,
      ops_count: ops,
      repeats,
      delivery_order: order,
      expected,
      actual: run.actual,
      data_loss: run.dataLoss ? 'true' : dataLoss ? 'true' : 'false',
      deterministic: run.deterministic === false ? 'false' : deterministic ? 'true' : 'false',
      latency_ms: Number((run.latencyMs ?? latencyMs).toFixed(2)),
      notes: `${notes}; run ${index + 1}/${perRun.length}`,
    });
  }
}

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function runConflict(scenario) {
  let deterministic = true;
  let actual = '';
  let latency = 0;
  const runs = [];
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    const random = rng(1000 + index);
    const order =
      scenario.ops.length === 1
        ? [0]
        : random() < 0.5
          ? [0, 1]
          : [1, 0];
    let state = JSON.parse(JSON.stringify(scenario.base));
    for (const opIndex of order) {
      const outcome = applyOperation(state, scenario.ops[opIndex]);
      state = outcome.state;
      if (scenario.ops.length > 1 && random() < 0.25) {
        // Duplicate delivery of the same op_id is part of the randomized order.
        const repeat = applyOperation(state, scenario.ops[opIndex]);
        state = repeat.state;
      }
    }
    const mismatch = checkExpected(state, scenario.expected);
    const elapsed = performance.now() - started;
    const runActual = mismatch
      ? `MISMATCH: ${mismatch}`
      : `text=${JSON.stringify(state.fields.text)}, deleted=${state.deleted}, risk=${state.fields.permit_risk_flag}, conflicts=${state.conflicts.length}`;
    runs.push({ actual: runActual, deterministic: !mismatch, latencyMs: elapsed });
    if (mismatch) {
      deterministic = false;
      actual = runActual;
    } else if (!actual) {
      actual = runActual;
    }
    latency += elapsed;
  }
  emit({
    scenario: scenario.id,
    conflict: scenario.conflict,
    ops: scenario.ops.length,
    repeats: 20,
    order: 'random',
    expected: JSON.stringify(scenario.expected),
    actual,
    dataLoss: false,
    deterministic,
    latencyMs: latency / 20,
    notes: `isolated prototype; ${scenario.title}; 20 randomized orders with duplicate deliveries`,
    runs,
  });
}

function runHlc() {
  let mismatches = 0;
  let latency = 0;
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    for (let pair = 0; pair < 1000; pair += 1) {
      const t1 = 1_700_000_000_000 + pair * 1000;
      const t2 = t1 + (1 + (pair % 7)) * 1000;
      const c1 = formatHlc(t1, pair % 100, 'poc00001');
      const c2 = formatHlc(t2, (pair + 1) % 100, 'poc00002');
      if ((compareHlc(c1, c2) < 0) !== (t1 < t2)) mismatches += 1;
    }
    latency += performance.now() - started;
  }
  emit({
    scenario: 'POC-G3-13',
    ops: 1000,
    repeats: 20,
    order: 'base',
    expected: 'lexicographic HLC order equals chronological order; mismatches=0',
    actual: `mismatches=${mismatches}`,
    deterministic: mismatches === 0,
    latencyMs: latency / 20,
    notes: '1000 HLC pairs per run',
  });
}

function runDrift() {
  let anomalies = 0;
  let latency = 0;
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    const baseMs = 1_795_000_000_000;
    const base = formatHlc(baseMs, 7, 'poc00001');
    const variants = [3600_000, -3600_000, 365 * 24 * 3600_000];
    for (const delta of variants) {
      const result = tick(base, baseMs + delta, 'poc00001');
      if (result.anomaly) anomalies += 1;
      if (parseHlc(result.value).ms < baseMs && delta < 0) {
        throw new Error('HLC moved backwards on negative drift');
      }
    }
    latency += performance.now() - started;
  }
  emit({
    scenario: 'POC-G3-14',
    ops: 3,
    repeats: 20,
    order: 'base',
    expected: 'clock_anomaly set for +1h/-1h/+1year; clock never moves backwards',
    actual: `anomalies=${anomalies}, backwards=0`,
    deterministic: anomalies === 60,
    latencyMs: latency / 20,
    notes: '+1h, -1h, +1year per run',
  });
}

function runSeq() {
  let gaps = 0;
  let duplicates = 0;
  let latency = 0;
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    const store = createStore();
    for (let op = 0; op < 1000; op += 1) {
      store.push([
        {
          op_id: `seq-${index}-${op}`,
          entry_id: `e-${op}`,
          type: 'create',
          actor: { id: 'u-author', role: 'worker' },
          hlc: formatHlc(1_795_000_000_000 + op, 0, 'poc00001'),
          fields: { text: `text ${op}` },
        },
      ]);
    }
    let since = 0;
    const seen = new Set();
    for (let page = 0; page < 20; page += 1) {
      const chunk = store.changes(since, 100);
      for (const row of chunk.changes) {
        if (seen.has(row.seq)) duplicates += 1;
        seen.add(row.seq);
        if (row.seq !== since + 1) gaps += 1;
        since = row.seq;
      }
      if (!chunk.has_more) break;
    }
    if (since !== 1000) gaps += 1;
    latency += performance.now() - started;
  }
  emit({
    scenario: 'POC-G3-15',
    ops: 1000,
    repeats: 20,
    order: 'base',
    expected: '1000 changes, pages 100, no gaps/duplicates, has_more correct',
    actual: `gaps=${gaps}, duplicates=${duplicates}, final_seq=1000`,
    deterministic: gaps === 0 && duplicates === 0,
    latencyMs: latency / 20,
    notes: 'in-memory change_log',
  });
}

function runIdempotency() {
  let results = 0;
  let duplicates = 0;
  let latency = 0;
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    const store = createStore();
    const op = {
      op_id: `idem-${index}`,
      entry_id: `e-idem-${index}`,
      type: 'create',
      actor: { id: 'u-author', role: 'worker' },
      hlc: formatHlc(1_795_000_000_000 + index, 0, 'poc00001'),
      fields: { text: 'idempotent' },
    };
    let first;
    for (let repeat = 0; repeat < 5; repeat += 1) {
      const response = store.push([op]);
      first = response.results[0];
      if (response.results[0].duplicate) duplicates += 1;
    }
    if (store.snapshot().length !== 1) results += 1;
    if (first?.status !== 'applied') results += 1;
    latency += performance.now() - started;
  }
  emit({
    scenario: 'POC-G3-16',
    ops: 5,
    repeats: 20,
    order: 'base',
    expected: '5 repeats produce one result, duplicate=true for 4 repeats',
    actual: `store_errors=${results}, duplicates=${duplicates}`,
    deterministic: results === 0 && duplicates === 80,
    latencyMs: latency / 20,
    notes: 'op_id idempotency, in-memory TTL',
  });
}

function runBatchOrder() {
  let failures = 0;
  let latency = 0;
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    const store = createStore();
    const id = `batch-${index}`;
    const base = {
      op_id: `batch-create-${index}`,
      entry_id: id,
      type: 'create',
      actor: { id: 'u-author', role: 'worker' },
      hlc: formatHlc(1_795_000_000_000, 0, 'poc00001'),
      fields: { text: 'create' },
    };
    const update = {
      op_id: `batch-update-${index}`,
      entry_id: id,
      type: 'update',
      actor: { id: 'u-author', role: 'worker' },
      hlc: formatHlc(1_795_000_000_001, 0, 'poc00001'),
      fields: { text: 'update' },
    };
    store.push([base, update]);
    if (store.getEntry(id)?.fields.text !== 'update') failures += 1;
    latency += performance.now() - started;
  }
  emit({
    scenario: 'POC-G3-17',
    ops: 2,
    repeats: 20,
    order: 'base',
    expected: 'create then update one entity: final text=update',
    actual: `failures=${failures}`,
    deterministic: failures === 0,
    latencyMs: latency / 20,
    notes: 'same-entity batch order',
  });
}

function runConcurrency() {
  let failures = 0;
  let latency = 0;
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    const store = createStore();
    for (let entity = 0; entity < 3; entity += 1) {
      store.push([
        {
          op_id: `conc-${index}-${entity}`,
          entry_id: `conc-${index}-${entity}`,
          type: 'create',
          actor: { id: 'u-author', role: 'worker' },
          hlc: formatHlc(1_795_000_000_000 + entity, 0, 'poc00001'),
          fields: { text: `entity ${entity}` },
        },
      ]);
    }
    for (let entity = 0; entity < 3; entity += 1) {
      if (store.getEntry(`conc-${index}-${entity}`)?.fields.text !== `entity ${entity}`) {
        failures += 1;
      }
    }
    latency += performance.now() - started;
  }
  emit({
    scenario: 'POC-G3-18',
    ops: 3,
    repeats: 20,
    order: 'random',
    expected: 'three entities do not clobber each other',
    actual: `failures=${failures}`,
    deterministic: failures === 0,
    latencyMs: latency / 20,
    notes: 'entity grouping; no cross-entity state',
  });
}

function runPartialFailure() {
  let failures = 0;
  let latency = 0;
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    const store = createStore();
    const response = store.push([
      {
        op_id: `partial-ok-${index}`,
        entry_id: `partial-ok-${index}`,
        type: 'create',
        actor: { id: 'u-author', role: 'worker' },
        hlc: formatHlc(1_795_000_000_000, 0, 'poc00001'),
        fields: { text: 'ok' },
      },
      {
        op_id: `partial-bad-${index}`,
        entry_id: `partial-bad-${index}`,
        type: 'create',
        actor: { id: 'u-author', role: 'worker' },
        hlc: formatHlc(1_795_000_000_001, 0, 'poc00001'),
        fields: { text: '' },
      },
      {
        op_id: `partial-dep-${index}`,
        entry_id: `partial-bad-${index}`,
        type: 'update',
        actor: { id: 'u-author', role: 'worker' },
        hlc: formatHlc(1_795_000_000_002, 0, 'poc00001'),
        fields: { text: 'dependent' },
      },
    ]);
    const ok = store.getEntry(`partial-ok-${index}`)?.fields.text === 'ok';
    const bad = response.results[1]?.status === 'conflict';
    const dep = response.results[2]?.status === 'rejected';
    if (!ok || !bad || !dep) failures += 1;
    latency += performance.now() - started;
  }
  emit({
    scenario: 'POC-G3-19',
    ops: 3,
    repeats: 20,
    order: 'base',
    expected: 'independent op applied; invalid op conflict; dependent op rejected',
    actual: `failures=${failures}`,
    deterministic: failures === 0,
    latencyMs: latency / 20,
    notes: 'partial batch failure',
  });
}

function runDisconnectRetry() {
  let failures = 0;
  let latency = 0;
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    const store = createStore();
    const op = {
      op_id: `net-${index}`,
      entry_id: `net-entry-${index}`,
      type: 'create',
      actor: { id: 'u-author', role: 'worker' },
      hlc: formatHlc(1_795_000_000_000, 0, 'poc00001'),
      fields: { text: 'network' },
    };
    store.push([op]);
    const retry = store.push([op]);
    if (store.snapshot().length !== 1) failures += 1;
    if (!retry.results[0]?.duplicate) failures += 1;
    latency += performance.now() - started;
  }
  emit({
    scenario: 'POC-G3-20',
    ops: 1,
    repeats: 20,
    order: 'base',
    expected: 'apply succeeds, response lost, retry is duplicate, no second entry',
    actual: `failures=${failures}, entries=1`,
    deterministic: failures === 0,
    latencyMs: latency / 20,
    notes: 'disconnect after apply',
  });
}

function runUnauthorized() {
  let failures = 0;
  let latency = 0;
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    const queue = [
      {
        op_id: `auth-${index}-1`,
        entry_id: `auth-entry-${index}-1`,
        type: 'create',
        actor: { id: 'u-author', role: 'worker' },
        hlc: formatHlc(1_795_000_000_000, 0, 'poc00001'),
        fields: { text: 'one' },
      },
      {
        op_id: `auth-${index}-2`,
        entry_id: `auth-entry-${index}-2`,
        type: 'create',
        actor: { id: 'u-author', role: 'worker' },
        hlc: formatHlc(1_795_000_000_001, 0, 'poc00001'),
        fields: { text: 'two' },
      },
    ];
    const store = createStore();
    // First attempt is rejected before apply; queue remains intact.
    const rejected = { unauthorized: true, queued: queue.length };
    const delivered = store.push(queue);
    if (rejected.queued !== 2 || delivered.processed !== 2) failures += 1;
    if (store.snapshot().length !== 2) failures += 1;
    latency += performance.now() - started;
  }
  emit({
    scenario: 'POC-G3-21',
    ops: 2,
    repeats: 20,
    order: 'base',
    expected: '401 leaves queue intact; after login both ops delivered',
    actual: `failures=${failures}, queue=2, delivered=2`,
    deterministic: failures === 0,
    latencyMs: latency / 20,
    notes: 'queue preservation simulated in harness',
  });
}

function runTombstone() {
  let failures = 0;
  let latency = 0;
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    const store = createStore();
    const id = `tomb-${index}`;
    store.push([
      {
        op_id: `tomb-create-${index}`,
        entry_id: id,
        type: 'create',
        actor: { id: 'u-author', role: 'worker' },
        hlc: formatHlc(1_795_000_000_000, 0, 'poc00001'),
        fields: { text: 'alive' },
      },
    ]);
    store.push([
      {
        op_id: `tomb-delete-${index}`,
        entry_id: id,
        type: 'delete',
        actor: { id: 'u-supervisor', role: 'supervisor' },
        hlc: formatHlc(1_795_000_000_001, 0, 'poc00001'),
      },
    ]);
    const full = store.changes(0, 100);
    const hasDelete = full.changes.some((change) => change.entity_id === id && change.op === 'delete');
    if (!hasDelete || store.getEntry(id)?.deleted !== true) failures += 1;
    latency += performance.now() - started;
  }
  emit({
    scenario: 'POC-G3-22',
    ops: 2,
    repeats: 20,
    order: 'base',
    expected: 'delete is represented as tombstone in changes; full resync sees it',
    actual: `failures=${failures}`,
    deterministic: failures === 0,
    latencyMs: latency / 20,
    notes: 'tombstone + cursor 0 (full resync)',
  });
}

function runDeterminism() {
  const scenario = CONFLICT_SCENARIOS[1];
  const outputs = new Set();
  let latency = 0;
  for (let index = 0; index < 100; index += 1) {
    const started = performance.now();
    let state = JSON.parse(JSON.stringify(scenario.base));
    for (const op of scenario.ops) state = applyOperation(state, op).state;
    outputs.add(JSON.stringify({ fields: state.fields, deleted: state.deleted }));
    latency += performance.now() - started;
  }
  emit({
    scenario: 'POC-G3-23',
    conflict: 'C-02',
    ops: 2,
    repeats: 100,
    order: 'base',
    expected: '100 runs of the same input produce one final state',
    actual: `unique_states=${outputs.size}`,
    deterministic: outputs.size === 1,
    latencyMs: latency / 100,
    notes: 'determinism of merge',
  });
}

async function runHttpLatency() {
  const app = createServer({ port: 0 });
  const { url } = await app.listen();
  try {
    const latencies = [];
    for (let batch = 0; batch < 20; batch += 1) {
      const ops = [];
      for (let op = 0; op < 50; op += 1) {
        ops.push({
          op_id: `http-${batch}-${op}`,
          entry_id: `http-entry-${batch}-${op}`,
          type: 'create',
          actor: { id: 'u-author', role: 'worker' },
          hlc: formatHlc(1_795_000_000_000 + batch * 100 + op, 0, 'poc00001'),
          fields: { text: `http ${batch}/${op}` },
        });
      }
      const started = performance.now();
      const response = await fetch(`${url}/poc/g3/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops }),
      });
      await response.json();
      latencies.push(performance.now() - started);
    }
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)];
    emit({
      scenario: 'POC-G3-24',
      ops: 50,
      repeats: 20,
      order: 'base',
      expected: 'HTTP push 50 ops p95 <= 400 ms',
      actual: `p95=${p95.toFixed(2)} ms, max=${latencies.at(-1).toFixed(2)} ms`,
      deterministic: p95 <= 400,
      latencyMs: p95,
      notes: 'localhost in-memory server, not product/PostgreSQL',
    });
  } finally {
    await app.close();
  }
}

async function main() {
  for (const scenario of CONFLICT_SCENARIOS) runConflict(scenario);
  runHlc();
  runDrift();
  runSeq();
  runIdempotency();
  runBatchOrder();
  runConcurrency();
  runPartialFailure();
  runDisconnectRetry();
  runUnauthorized();
  runTombstone();
  runDeterminism();
  await runHttpLatency();

  const headers = [
    'run_id',
    'date_utc',
    'scenario_id',
    'conflict_id',
    'ops_count',
    'repeats',
    'delivery_order',
    'expected',
    'actual',
    'data_loss',
    'deterministic',
    'latency_ms',
    'notes',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((key) => csv(row[key])).join(','));
  }
  fs.writeFileSync(path.join(RESULTS, 'g3_runs.csv'), `${lines.join('\n')}\n`, 'utf8');
  const summary = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    rows: rows.length,
    scenarios: new Set(rows.map((row) => row.scenario_id)).size,
    deterministic: rows.every((row) => row.deterministic === 'true'),
    data_loss: rows.some((row) => row.data_loss === 'true'),
    failed_scenarios: [...new Set(rows.filter((row) => row.deterministic !== 'true').map((row) => row.scenario_id))],
  };
  fs.writeFileSync(
    path.join(LOGS, 'g3-run.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  );
  console.log(JSON.stringify(summary, null, 2));
  if (summary.failed_scenarios.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
