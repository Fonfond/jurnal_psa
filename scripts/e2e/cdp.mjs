// Minimal Chrome DevTools Protocol client for the Logbook E2E smoke.
// Node built-ins only; no Playwright dependency. Works with Edge/Chromium.
import { spawn } from 'node:child_process';

export const DEFAULT_EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, { timeoutMs = 30_000, intervalMs = 250, label = 'condition' } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

export async function launchBrowser({ port = 9444, edgePath = process.env.E2E_BROWSER ?? DEFAULT_EDGE } = {}) {
  const child = spawn(
    edgePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--incognito',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--remote-debugging-port=' + String(port),
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  const version = await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      return response.ok ? response.json() : null;
    },
    { label: 'browser DevTools endpoint', timeoutMs: 30_000 },
  );
  return {
    child,
    version,
    async close() {
      try {
        child.kill();
      } catch {
        // ignore
      }
      await delay(500);
    },
  };
}

export async function connectPage({ port = 9444 } = {}) {
  const target = await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (!response.ok) return null;
      const list = await response.json();
      return list.find((item) => item.type === 'page') ?? null;
    },
    { label: 'page target' },
  );

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (payload.id && pending.has(payload.id)) {
      const { resolve, reject } = pending.get(payload.id);
      pending.delete(payload.id);
      if (payload.error) reject(new Error(payload.error.message));
      else resolve(payload.result);
    }
  });

  const send = (method, params = {}) => {
    id += 1;
    const requestId = id;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');

  return {
    socket,
    send,
    async evaluate(expression, { awaitPromise = true, returnByValue = true } = {}) {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise,
        returnByValue,
        userGesture: true,
      });
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text ??
            'evaluate failed',
        );
      }
      return result.result?.value;
    },
    async navigate(url) {
      await send('Page.navigate', { url });
      await waitFor(
        async () => {
          try {
            return await this.evaluate('document.readyState === "complete"');
          } catch {
            return false;
          }
        },
        { label: `load ${url}` },
      );
      await delay(300);
    },
    async waitFor(expression, { timeoutMs = 20_000, label = expression } = {}) {
      return waitFor(
        async () => {
          try {
            return await this.evaluate(`Boolean(${expression})`);
          } catch {
            return false;
          }
        },
        { timeoutMs, label },
      );
    },
    async screenshot(path) {
      const result = await send('Page.captureScreenshot', { format: 'png' });
      return result.data;
    },
    close() {
      try {
        socket.close();
      } catch {
        // ignore
      }
    },
  };
}
