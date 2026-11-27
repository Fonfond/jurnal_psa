#!/usr/bin/env node
// Logbook browser E2E + basic a11y smoke.
// Uses Edge/Chromium via CDP (no Playwright dependency). Reads apps/web/dist.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser, connectPage, delay } from './cdp.mjs';
import { createE2eServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const ARTIFACTS = path.join(ROOT, 'scripts/e2e/results');
fs.mkdirSync(ARTIFACTS, { recursive: true });

const API_PORT = Number(process.env.E2E_API_PORT ?? 3121);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4173);
const CDP_PORT = Number(process.env.E2E_CDP_PORT ?? 9444);
const API_URL = `http://127.0.0.1:${API_PORT}/v1`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://logbook:logbook@127.0.0.1:55432/logbook_release_t15';
const CA = process.env.E2E_SSL_CA ?? '.data/pg15/certs/server.crt';
const AXE_PATH = path.join(HERE, 'vendor/axe.min.js');
const AXE_SOURCE = fs.existsSync(AXE_PATH) ? fs.readFileSync(AXE_PATH, 'utf8') : '';

const scenarios = [];
const consoleErrors = [];
let api;

function record(name, status, details = '', data = {}) {
  scenarios.push({ name, status, details, ...data });
  console.log(`[${status === 'passed' ? 'ok  ' : 'FAIL'}] ${name}${details ? ` — ${details}` : ''}`);
}

async function waitHttp(url, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // retry
    }
    await delay(300);
  }
  throw new Error(`timeout waiting for ${url}`);
}

function startApi() {
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(API_PORT),
    DATABASE_URL: DB_URL,
    DATABASE_SSL_MODE: 'verify-full',
    DATABASE_SSL_CA_PATH: CA,
    DATABASE_POOL_MAX: '8',
    AUTH_PROVIDER: 'dev',
    DEV_LOGIN_ENABLED: 'true',
    COOKIE_SECRET: 'e2e-cookie-secret-32-characters-min',
    CORS_ORIGIN: WEB_URL,
    SIGNATURE_PROVIDER: 'simple',
    SIGNATURE_SECRET: 'e2e-signature-secret-32-characters-min',
    SIGNATURE_AUTO_SIGN: 'true',
    RUN_MIGRATIONS_ON_START: 'false',
  };
  const child = spawn('node', ['apps/api/dist/main.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}

async function evalValue(page, expression) {
  return page.evaluate(expression, { awaitPromise: true, returnByValue: true });
}

async function setField(page, labelText, value) {
  return evalValue(
    page,
    `(() => {
      const labels = [...document.querySelectorAll('label')];
      const label = labels.find((item) => item.textContent.includes(${JSON.stringify(labelText)}));
      const field = label?.querySelector('input, select, textarea');
      if (!field) return false;
      const proto = field.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : field.tagName === 'SELECT'
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(field, String(${JSON.stringify(value)}));
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
  );
}

async function clickText(page, text) {
  return evalValue(
    page,
    `(() => {
      const el = [...document.querySelectorAll('button, a, [role="button"]')]
        .find((item) => item.textContent.trim().includes(${JSON.stringify(text)}));
      if (!el) return false;
      el.click();
      return true;
    })()`,
  );
}

async function spaNavigate(page, pathname) {
  return evalValue(
    page,
    `(() => {
      history.pushState({}, '', ${JSON.stringify(pathname)});
      window.dispatchEvent(new PopStateEvent('popstate'));
      return location.pathname;
    })()`,
  );
}

async function loginAs(page, label) {
  await page.navigate(`${WEB_URL}/login`);
  await page.waitFor(`document.body.innerText.includes('Logbook')`);
  const clicked = await clickText(page, label);
  if (!clicked) throw new Error(`login button not found: ${label}`);
  await page.waitFor(`location.pathname === '/'`, { timeoutMs: 25_000, label: `login ${label}` });
  await page.waitFor(`document.body.innerText.includes('Журнал')`, { timeoutMs: 25_000, label: 'journal shell' });
}

async function createEntry(page, text) {
  await spaNavigate(page, '/entries/new');
  await page.waitFor(`document.querySelector('textarea') !== null`, { timeoutMs: 15_000 });
  await page.waitFor(
    `(() => {
      const labels = [...document.querySelectorAll('label')];
      const field = labels.find((item) => item.textContent.includes('Тип работ'))?.querySelector('select');
      return Boolean(field && field.options.length > 1);
    })()`,
    { timeoutMs: 20_000, label: 'work type dictionary' },
  );
  await setField(page, 'Текст записи', text);
  // Pick a work type; the first active option is after the empty option.
  await evalValue(
    page,
    `(() => {
      const labels = [...document.querySelectorAll('label')];
      const field = labels.find((item) => item.textContent.includes('Тип работ'))
        ?.querySelector('select');
      if (!field) return false;
      const options = [...field.options].filter((item) => item.value);
      // Prefer a work type without a permit; the first seeded type requires one.
      const option = options.find((item) => item.textContent.includes('Осмотр'))
        ?? options.find((item, index) => index === 1)
        ?? options[0];
      if (!option) return false;
      field.value = option.value;
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
  );
  // Fill required site if the selected work type requires it.
  await evalValue(
    page,
    `(() => {
      const labels = [...document.querySelectorAll('label')];
      const field = labels.find((item) => item.textContent.includes('Объект'))
        ?.querySelector('select');
      if (!field || field.value) return false;
      const option = [...field.options].find((item) => item.value);
      if (!option) return false;
      field.value = option.value;
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
  );
  await clickText(page, 'Сохранить запись');
  try {
    await page.waitFor(`location.pathname.startsWith('/entries/') && !location.pathname.endsWith('/new')`, {
      timeoutMs: 25_000,
      label: 'entry card after save',
    });
  } catch (error) {
    const debug = await evalValue(
      page,
      `JSON.stringify({
        path: location.pathname,
        text: document.body.innerText.slice(0, 4000),
        errors: [...document.querySelectorAll('.field__error, .alert--danger')].map((el) => el.textContent),
        values: [...document.querySelectorAll('input, select, textarea')].map((el) => [el.name || el.id || el.tagName, el.value]).slice(0, 20)
      })`,
    );
    throw new Error(`${error.message}; debug=${debug}`);
  }
  await page.waitFor(`document.body.innerText.includes(${JSON.stringify(text)})`, {
    timeoutMs: 20_000,
    label: 'saved entry text',
  });
}

async function a11yAudit(page) {
  try {
    const loaded = await page.evaluate('Boolean(window.axe)');
    if (!loaded) await installAxe(page);
  } catch {
    // audit falls back to the basic checks and records axe as not loaded
  }
  return evalValue(
    page,
    `(async () => {
      const issues = [];
      const warnings = [];
      if (document.documentElement.lang !== 'ru') issues.push('html lang is not ru');
      if (!document.title.trim()) issues.push('empty document title');
      const controls = [...document.querySelectorAll('input, select, textarea')];
      for (const control of controls) {
        if (control.type === 'hidden') continue;
        const labelled = control.labels?.length > 0 || control.getAttribute('aria-label')
          || control.getAttribute('aria-labelledby') || control.getAttribute('title');
        if (!labelled) issues.push('unlabelled control: ' + (control.name || control.id || control.tagName));
      }
      for (const el of [...document.querySelectorAll('button, a, [role="button"]')]) {
        const name = (el.getAttribute('aria-label') || el.textContent || '').trim();
        if (!name) issues.push('unnamed interactive element: ' + el.tagName);
      }
      for (const img of [...document.querySelectorAll('img')]) {
        if (!img.hasAttribute('alt')) issues.push('image without alt: ' + (img.src || ''));
      }
      const h1 = [...document.querySelectorAll('h1')];
      if (h1.length !== 1) warnings.push('h1 count=' + h1.length);
      if (!document.querySelector('main')) warnings.push('no main landmark');
      if (!document.querySelector('nav')) warnings.push('no nav landmark');

      function rgb(value) {
        const m = value.match(/rgba?\\(([^)]+)\\)/);
        if (!m) return null;
        const parts = m[1].split(',').map(Number);
        return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
      }
      function luminance({ r, g, b }) {
        const c = [r, g, b].map((v) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      }
      function background(el) {
        let node = el;
        while (node && node !== document.documentElement) {
          const value = getComputedStyle(node).backgroundColor;
          const parsed = rgb(value);
          if (parsed && parsed.a > 0.05) return parsed;
          node = node.parentElement;
        }
        return { r: 255, g: 255, b: 255, a: 1 };
      }
      const textEls = [...document.querySelectorAll('p, span, a, button, h1, h2, h3, label, td, th, li')]
        .filter((el) => el.offsetParent !== null && el.textContent.trim().length > 0);
      let lowContrast = 0;
      for (const el of textEls.slice(0, 200)) {
        const style = getComputedStyle(el);
        const fg = rgb(style.color);
        if (!fg) continue;
        const bg = background(el);
        const l1 = luminance(fg);
        const l2 = luminance(bg);
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        const size = parseFloat(style.fontSize);
        const bold = Number(style.fontWeight) >= 700;
        const threshold = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
        if (ratio + 0.05 < threshold) lowContrast += 1;
      }
      if (lowContrast > 0) warnings.push('possible low-contrast text nodes: ' + lowContrast);

      let axe = [];
      if (window.axe) {
        try {
          const result = await window.axe.run(document, {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
          });
          axe = result.violations.map((item) => ({
            id: item.id,
            impact: item.impact,
            nodes: item.nodes.length,
            help: item.help,
            targets: item.nodes.slice(0, 8).map((node) => ({
              target: node.target,
              summary: node.failureSummary,
            })),
          }));
          for (const item of axe) {
            const text = 'axe:' + item.id + ' (' + item.impact + ', nodes=' + item.nodes + ')';
            if (item.impact === 'serious' || item.impact === 'critical') issues.push(text);
            else warnings.push(text);
          }
        } catch (error) {
          warnings.push('axe error: ' + String(error));
        }
      } else {
        warnings.push('axe not loaded');
      }
      return { issues: [...new Set(issues)], warnings: [...new Set(warnings)], controls: controls.length, axe };
    })()`,
  );
}

async function saveScreenshot(page, name) {
  const data = await page.screenshot();
  fs.writeFileSync(path.join(ARTIFACTS, name), Buffer.from(data, 'base64'));
}

async function installAxe(page) {
  if (!AXE_SOURCE) return false;
  await page.evaluate(`${AXE_SOURCE}\n;true`);
  return page.evaluate('Boolean(window.axe)');
}

async function main() {
  api = startApi();
  try {
    await waitHttp(`${API_URL}/health`);
    record('API health', 'passed', 'db=ok');

    const web = createE2eServer({ apiTarget: `http://127.0.0.1:${API_PORT}`, port: WEB_PORT });
    const webInfo = await web.listen();
    const browser = await launchBrowser({ port: CDP_PORT });
    const page = await connectPage({ port: CDP_PORT });
    page.socket.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.method === 'Runtime.exceptionThrown') {
          consoleErrors.push(payload.params.exceptionDetails?.text ?? 'runtime exception');
        }
      } catch {
        // ignore
      }
    });

    try {
      await page.navigate(`${WEB_URL}/login`);
      const axeLoaded = await installAxe(page);
      const loginA11y = await a11yAudit(page);
      await saveScreenshot(page, 'e2e-s01-login.png');
      record('login page a11y smoke', loginA11y.issues.length === 0 ? 'passed' : 'failed',
        loginA11y.issues.length ? loginA11y.issues.join('; ') : `axe=${axeLoaded}; controls=${loginA11y.controls}; warnings=${loginA11y.warnings.join('; ') || 'none'}`, { a11y: loginA11y });

      await loginAs(page, 'Сотрудник');
      record('login worker + journal', 'passed', 'quick dev login');
      await saveScreenshot(page, 'e2e-s02-journal.png');

      const journalA11y = await a11yAudit(page);
      record('journal a11y smoke', journalA11y.issues.length === 0 ? 'passed' : 'failed',
        journalA11y.issues.join('; ') || `warnings=${journalA11y.warnings.join('; ') || 'none'}`, { a11y: journalA11y });

      const text = `E2E browser ${Date.now()}`;
      await createEntry(page, text);
      record('create entry via UI', 'passed', text);
      await saveScreenshot(page, 'e2e-s03-entry-card.png');

      const editorA11y = await a11yAudit(page);
      record('entry card a11y smoke', editorA11y.issues.length === 0 ? 'passed' : 'failed',
        editorA11y.issues.join('; ') || `warnings=${editorA11y.warnings.join('; ') || 'none'}`, { a11y: editorA11y });

      await page.send('Network.emulateNetworkConditions', {
        offline: true,
        latency: 0,
        downloadThroughput: 0,
        uploadThroughput: 0,
      });
      const offlineText = `E2E offline ${Date.now()}`;
      await createEntry(page, offlineText);
      const offlinePending = await evalValue(
        page,
        `document.body.innerText.includes('Ожидает') || document.body.innerText.includes('не синхронизирован')`,
      );
      record('create entry offline', offlinePending ? 'passed' : 'failed', offlineText);
      await page.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await evalValue(page, `window.dispatchEvent(new Event('online'))`);
      await delay(3000);
      await spaNavigate(page, '/sync');
      await page.waitFor(`document.body.innerText.includes('Синхронизация')`, { timeoutMs: 15_000 });
      await clickText(page, 'Синхронизировать');
      await delay(3000);
      const synced = await evalValue(
        page,
        `document.body.innerText.includes('Все операции отправлены')`,
      );
      record('offline entry syncs after online', synced ? 'passed' : 'failed', 'sync screen');
      await saveScreenshot(page, 'e2e-s10-sync.png');

      await clickText(page, 'Выйти');
      await page.waitFor(`location.pathname === '/login'`, { timeoutMs: 15_000, label: 'logout' });
      await loginAs(page, 'Администратор');
      await spaNavigate(page, '/admin/users');
      await page.waitFor(`document.body.innerText.includes('Пользователи')`, { timeoutMs: 20_000, label: 'admin users' });
      const adminText = await evalValue(page, `document.body.innerText`);
      record('admin users screen', adminText.includes('учётных записей') ? 'passed' : 'failed', 'admin contour');
      const adminA11y = await a11yAudit(page);
      record('admin a11y smoke', adminA11y.issues.length === 0 ? 'passed' : 'failed',
        adminA11y.issues.join('; ') || `warnings=${adminA11y.warnings.join('; ') || 'none'}`, { a11y: adminA11y });
      await saveScreenshot(page, 'e2e-admin-users.png');

      const sw = await evalValue(
        page,
        `(async () => {
          if (!('serviceWorker' in navigator)) return { supported: false };
          const registration = await navigator.serviceWorker.getRegistration();
          return { supported: true, active: Boolean(registration?.active), scope: registration?.scope ?? null };
        })()`,
      );
      record('PWA service worker', sw.supported && (sw.active || sw.scope) ? 'passed' : 'failed', JSON.stringify(sw));

      if (consoleErrors.length > 0) {
        record('no runtime exceptions', 'failed', consoleErrors.slice(0, 3).join('; '));
      } else {
        record('no runtime exceptions', 'passed', '0 exceptions');
      }
    } finally {
      page.close();
      await browser.close();
      await web.close();
    }

    const failed = scenarios.filter((item) => item.status !== 'passed');
    const result = {
      generated_at: new Date().toISOString(),
      web_url: webInfo.url,
      api_url: API_URL,
      scenarios,
      failed: failed.map((item) => item.name),
      runtime_exceptions: consoleErrors,
    };
    fs.writeFileSync(path.join(ARTIFACTS, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ total: scenarios.length, failed: result.failed }, null, 2));
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    try {
      api.kill();
    } catch {
      // ignore
    }
  }
}

main().catch((error) => {
  console.error(error);
  fs.writeFileSync(
    path.join(ARTIFACTS, 'latest-error.json'),
    `${JSON.stringify({ error: error.stack ?? String(error), scenarios }, null, 2)}\n`,
    'utf8',
  );
  process.exitCode = 1;
});
