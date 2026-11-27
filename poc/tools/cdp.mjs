// Minimal Chrome DevTools Protocol client for PoC harnesses. Node built-ins only.
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
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

export async function launchEdge({ port = 9333, edgePath = DEFAULT_EDGE } = {}) {
  const process = spawn(
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
      if (!response.ok) return null;
      return response.json();
    },
    { label: 'Edge DevTools endpoint' },
  );

  return {
    process,
    port,
    version,
    async close() {
      try {
        process.kill();
      } catch {
        // ignore
      }
      await delay(500);
    },
  };
}

export async function connectToPage({ port = 9333, url = 'about:blank' } = {}) {
  const target = await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (!response.ok) return null;
      const targets = await response.json();
      return targets.find((item) => item.type === 'page') ?? null;
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

  function send(method, params = {}) {
    id += 1;
    const requestId = id;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
  }

  await send('Page.enable');
  await send('Runtime.enable');
  if (url !== 'about:blank') {
    await send('Page.navigate', { url });
    await delay(500);
  }

  return {
    socket,
    send,
    async evaluate(expression, { awaitPromise = false, returnByValue = true } = {}) {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise,
        returnByValue,
        userGesture: false,
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
    close() {
      try {
        socket.close();
      } catch {
        // ignore
      }
    },
  };
}
