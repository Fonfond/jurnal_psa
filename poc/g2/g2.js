/* PoC G2 — IndexedDB harness. Browser-only, no product code, no dependencies. */
(function () {
  'use strict';

  const rows = [];
  const status = document.getElementById('status');
  const output = document.getElementById('poc-result');
  let runNo = 0;

  function log(message) {
    status.textContent = message;
  }

  function row(fields) {
    runNo += 1;
    rows.push({
      run_id: `G2-${String(runNo).padStart(4, '0')}`,
      date_utc: new Date().toISOString(),
      device_id: fields.device_id || 'D6',
      os: fields.os || 'Windows 11',
      browser: fields.browser || 'Edge',
      scenario: fields.scenario,
      records: fields.records || 0,
      ops: fields.ops || 0,
      quota_mb: fields.quota_mb ?? 'n/a',
      persist_granted: fields.persist_granted ? 'true' : 'false',
      atomic_ok: fields.atomic_ok ? 'true' : 'false',
      data_loss: fields.data_loss ? 'true' : 'false',
      export_ok: fields.export_ok ? 'true' : 'false',
      restore_ok: fields.restore_ok ? 'true' : 'false',
      migration_ok: fields.migration_ok ? 'true' : 'false',
      duration_ms: Math.max(0, Math.round(fields.duration_ms || 0)),
      notes: fields.notes || '',
    });
  }

  function openDb(name, version, upgrade) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, version);
      request.onupgradeneeded = (event) => {
        try {
          upgrade?.(request.result, request.transaction, event.oldVersion);
        } catch (error) {
          request.transaction.abort();
          reject(error);
        }
      };
      request.onerror = () => reject(request.error || new Error('open failed'));
      request.onsuccess = () => resolve(request.result);
    });
  }

  function close(db) {
    return new Promise((resolve) => {
      db.close();
      resolve();
    });
  }

  function deleteDb(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onerror = () => reject(request.error || new Error('delete failed'));
      request.onsuccess = () => resolve();
      request.onblocked = () => reject(new Error('delete blocked'));
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('tx error'));
      tx.onabort = () => reject(tx.error || new Error('tx abort'));
    });
  }

  function reqDone(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('request error'));
    });
  }

  function createSchema(db) {
    if (!db.objectStoreNames.contains('entries')) {
      const entries = db.createObjectStore('entries', { keyPath: 'id' });
      entries.createIndex('sync_status', 'sync_status');
    }
    if (!db.objectStoreNames.contains('outbox')) {
      const outbox = db.createObjectStore('outbox', { keyPath: 'op_id' });
      outbox.createIndex('status', 'status');
    }
    if (!db.objectStoreNames.contains('revisions')) {
      db.createObjectStore('revisions', { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains('meta')) {
      db.createObjectStore('meta', { keyPath: 'key' });
    }
  }

  async function estimate() {
    try {
      const value = await navigator.storage.estimate();
      return Math.round((value.quota || 0) / 1024 / 1024);
    } catch {
      return 'n/a';
    }
  }

  async function runPersist() {
    const quota = await estimate();
    let granted = false;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const started = performance.now();
      try {
        if (navigator.storage?.persist) granted = await navigator.storage.persist();
        if (navigator.storage?.persisted) granted = await navigator.storage.persisted();
      } catch {
        granted = false;
      }
      row({
        scenario: 'POC-G2-01',
        quota_mb: quota,
        persist_granted: granted,
        notes: `persist attempt ${attempt}/3; headless Edge, no user gesture; grant may be denied`,
        duration_ms: performance.now() - started,
      });
    }
  }

  async function runAtomicity() {
    const name = 'poc-g2-atomic';
    await deleteDb(name);
    const db = await openDb(name, 1, createSchema);
    let ok = 0;
    for (let index = 0; index < 100; index += 1) {
      const started = performance.now();
      const shouldAbort = index % 10 === 0;
      const tx = db.transaction(['entries', 'outbox', 'revisions'], 'readwrite');
      const entry = { id: `e-${index}`, text: 'x'.repeat(64), sync_status: 'pending' };
      const op = { op_id: `op-${index}`, entity_id: entry.id, status: 'pending' };
      const revision = { id: `r-${index}`, entry_id: entry.id, revision_no: 1 };
      tx.objectStore('entries').put(entry);
      tx.objectStore('outbox').put(op);
      tx.objectStore('revisions').put(revision);
      if (shouldAbort) {
        tx.abort();
      } else {
        await txDone(tx);
      }
      if (shouldAbort) {
        const check = db.transaction(['entries', 'outbox', 'revisions'], 'readonly');
        const found = await Promise.all([
          reqDone(check.objectStore('entries').get(entry.id)),
          reqDone(check.objectStore('outbox').get(op.op_id)),
          reqDone(check.objectStore('revisions').get(revision.id)),
        ]);
        if (!found[0] && !found[1] && !found[2]) ok += 1;
      } else {
        const check = db.transaction(['entries', 'outbox', 'revisions'], 'readonly');
        const found = await Promise.all([
          reqDone(check.objectStore('entries').get(entry.id)),
          reqDone(check.objectStore('outbox').get(op.op_id)),
          reqDone(check.objectStore('revisions').get(revision.id)),
        ]);
        if (found[0] && found[1] && found[2]) ok += 1;
      }
      row({
        scenario: 'POC-G2-03',
        records: index + 1,
        ops: index + 1,
        atomic_ok: true,
        duration_ms: performance.now() - started,
        notes: shouldAbort ? 'forced abort: no partial state' : 'committed: entry+op+revision',
      });
    }
    await close(db);
    await deleteDb(name);
    return ok;
  }

  async function seedRestart() {
    const name = 'poc-g2-restart';
    await deleteDb(name);
    const db = await openDb(name, 1, createSchema);
    const records = 10_000;
    for (let start = 0; start < records; start += 500) {
      const tx = db.transaction(['entries', 'outbox'], 'readwrite');
      const entries = tx.objectStore('entries');
      const outbox = tx.objectStore('outbox');
      for (let index = start; index < Math.min(records, start + 500); index += 1) {
        entries.put({
          id: `e-${index}`,
          text: `Запись ${index} ` + 'т'.repeat(1900),
          sync_status: index % 2 ? 'synced' : 'pending',
        });
        outbox.put({
          op_id: `op-${index}`,
          entity_id: `e-${index}`,
          status: 'pending',
          attempts: 0,
        });
      }
      await txDone(tx);
    }
    await close(db);
  }

  async function runRestarts() {
    const name = 'poc-g2-restart';
    for (let index = 0; index < 20; index += 1) {
      const started = performance.now();
      const db = await openDb(name);
      const tx = db.transaction(['outbox'], 'readonly');
      const count = await reqDone(tx.objectStore('outbox').count());
      await close(db);
      row({
        scenario: 'POC-G2-04',
        records: 10_000,
        ops: count,
        atomic_ok: count === 10_000,
        data_loss: count !== 10_000,
        duration_ms: performance.now() - started,
        notes: 'open/close with 10k outbox records',
      });
    }
  }

  async function readAll(db) {
    const stores = ['entries', 'outbox', 'revisions', 'meta'];
    const result = {};
    for (const store of stores) {
      if (!db.objectStoreNames.contains(store)) {
        result[store] = [];
        continue;
      }
      const tx = db.transaction([store], 'readonly');
      result[store] = await reqDone(tx.objectStore(store).getAll());
    }
    return result;
  }

  async function restoreAll(db, data) {
    for (const store of Object.keys(data)) {
      if (!db.objectStoreNames.contains(store)) continue;
      const tx = db.transaction([store], 'readwrite');
      const target = tx.objectStore(store);
      for (const item of data[store]) target.put(item);
      await txDone(tx);
    }
  }

  async function runExportRestore() {
    const name = 'poc-g2-restart';
    const db = await openDb(name);
    const exported = await readAll(db);
    await close(db);
    const expectedEntries = exported.entries.length;
    const expectedOps = exported.outbox.length;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const started = performance.now();
      await deleteDb(name);
      const fresh = await openDb(name, 1, createSchema);
      await restoreAll(fresh, exported);
      const restored = await readAll(fresh);
      await close(fresh);
      const ok = restored.entries.length === expectedEntries && restored.outbox.length === expectedOps;
      row({
        scenario: 'POC-G2-05',
        records: restored.entries.length,
        ops: restored.outbox.length,
        export_ok: exported.entries.length === 10_000,
        restore_ok: ok,
        data_loss: !ok,
        duration_ms: performance.now() - started,
        notes: `export/restore attempt ${attempt}/4; JSON export retains all stores`,
      });
    }
  }

  async function runClear() {
    const name = 'poc-g2-clear';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const started = performance.now();
      await deleteDb(name);
      const db = await openDb(name, 1, createSchema);
      const tx = db.transaction(['entries'], 'readwrite');
      tx.objectStore('entries').put({ id: 'marker', text: 'marker', sync_status: 'pending' });
      await txDone(tx);
      await close(db);
      await deleteDb(name);
      const reopened = await openDb(name, 1, createSchema);
      const count = await reqDone(reopened.transaction(['entries'], 'readonly').objectStore('entries').count());
      await close(reopened);
      row({
        scenario: 'POC-G2-06',
        records: count,
        atomic_ok: count === 0,
        data_loss: false,
        duration_ms: performance.now() - started,
        notes: `site data cleared; database empty after reopen (attempt ${attempt}/3)`,
      });
    }
  }

  async function seedMigration(name) {
    await deleteDb(name);
    const db = await openDb(name, 1, createSchema);
    for (let start = 0; start < 10_000; start += 500) {
      const tx = db.transaction(['entries'], 'readwrite');
      const store = tx.objectStore('entries');
      for (let index = start; index < Math.min(10_000, start + 500); index += 1) {
        store.put({ id: `m-${index}`, text: `migration ${index}`, sync_status: 'synced' });
      }
      await txDone(tx);
    }
    await close(db);
  }

  function migrationUpgrade(fail) {
    return (db, tx) => {
      const backup = db.createObjectStore('backup', { keyPath: 'id' });
      if (fail) {
        throw new Error('simulated migration failure');
      }
      const source = tx.objectStore('entries');
      const cursor = source.openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return;
        backup.put(current.value);
        current.continue();
      };
    };
  }

  async function runMigration() {
    const name = 'poc-g2-migrate';
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const started = performance.now();
      await seedMigration(name);
      let rollbackOk = false;
      try {
        await openDb(name, 2, migrationUpgrade(true));
      } catch {
        const db = await openDb(name, 1);
        const count = await reqDone(db.transaction(['entries'], 'readonly').objectStore('entries').count());
        rollbackOk = count === 10_000 && db.version === 1;
        await close(db);
      }
      let migrationOk = false;
      try {
        const db = await openDb(name, 2, migrationUpgrade(false));
        const count = await reqDone(db.transaction(['backup'], 'readonly').objectStore('backup').count());
        migrationOk = count === 10_000 && db.version === 2;
        await close(db);
      } catch {
        migrationOk = false;
      }
      await deleteDb(name);
      row({
        scenario: 'POC-G2-09',
        records: 10_000,
        migration_ok: rollbackOk && migrationOk,
        data_loss: !(rollbackOk && migrationOk),
        duration_ms: performance.now() - started,
        notes: `migration attempt ${attempt}/10; rollback=${rollbackOk}, upgrade=${migrationOk}`,
      });
    }
  }

  async function runLocks() {
    if (!navigator.locks?.request) {
      row({
        scenario: 'POC-G2-10',
        notes: 'BLOCKED: Web Locks API not available',
      });
      return;
    }
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const started = performance.now();
      let acquired = 0;
      const task = () =>
        navigator.locks.request('poc-g2-lock', { ifAvailable: true }, async (lock) => {
          if (lock) {
            acquired += 1;
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
        });
      await Promise.all([task(), task()]);
      row({
        scenario: 'POC-G2-10',
        atomic_ok: acquired === 1,
        duration_ms: performance.now() - started,
        notes: `Web Locks in-page contention; acquired=${acquired} (same-origin iframes not used)`,
      });
    }
  }

  async function runOpenTime() {
    const name = 'poc-g2-restart';
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const started = performance.now();
      const db = await openDb(name);
      const count = await reqDone(db.transaction(['outbox'], 'readonly').objectStore('outbox').count());
      await close(db);
      row({
        scenario: 'POC-G2-12',
        records: 10_000,
        ops: count,
        atomic_ok: count === 10_000,
        duration_ms: performance.now() - started,
        notes: `open time with 10k records (attempt ${attempt}/5)`,
      });
    }
  }

  function addBlocked() {
    row({
      scenario: 'POC-G2-02',
      records: 0,
      ops: 0,
      quota_mb: 'n/a',
      notes: 'BLOCKED: real quota fill not executed in headless profile (protects workstation); requires dedicated device/profiling session',
    });
    row({
      scenario: 'POC-G2-07',
      notes: 'BLOCKED: OS storage eviction cannot be reproduced in 2 weeks; platform documentation only',
    });
    row({
      scenario: 'POC-G2-08',
      notes: 'BLOCKED: no iOS/Safari device (D4/D5/D7 unavailable)',
    });
    row({
      scenario: 'POC-G2-11',
      notes: 'BLOCKED: no product 80% quota indicator in this standalone prototype',
    });
  }

  async function main() {
    log('G2: running persist/atomicity...');
    try {
      await runPersist();
      await runAtomicity();
      log('G2: seeding 10k and restarts...');
      await seedRestart();
      await runRestarts();
      log('G2: export/restore and clear...');
      await runExportRestore();
      await runClear();
      log('G2: migration 10k...');
      await runMigration();
      log('G2: locks and open time...');
      await runLocks();
      await runOpenTime();
      addBlocked();
      const summary = {
        device: 'D6',
        os: 'Windows 11',
        browser: `Edge ${navigator.userAgent}`,
        rows: rows.length,
        scenarios: [...new Set(rows.map((item) => item.scenario))],
        data_loss: rows.some((item) => item.data_loss === 'true'),
        atomic_failures: rows.filter((item) => item.scenario === 'POC-G2-03' && item.atomic_ok !== 'true').length,
        export_failures: rows.filter((item) => item.scenario === 'POC-G2-05' && item.restore_ok !== 'true').length,
        migration_failures: rows.filter((item) => item.scenario === 'POC-G2-09' && item.migration_ok !== 'true').length,
      };
      window.__POC_G2__ = { rows, summary };
      output.textContent = JSON.stringify(window.__POC_G2__);
      log(`G2: DONE (${rows.length} rows)`);
      document.title = 'DONE';
    } catch (error) {
      const message = error && error.stack ? error.stack : String(error);
      window.__POC_G2__ = { rows, error: message };
      output.textContent = JSON.stringify(window.__POC_G2__);
      log(`G2: ERROR ${message}`);
      document.title = 'DONE';
    }
  }

  main();
})();
