// PoC G3 — minimal HTTP server for push/changes/health. Not product code.
import { createServer as createHttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createStore } from './store.mjs';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createServer({ store = createStore(), port = 0 } = {}) {
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    if (request.method === 'GET' && url.pathname === '/poc/g3/health') {
      return json(response, 200, { status: 'ok', entries: store.entries.size, seq: store.changeLog.size });
    }

    if (request.method === 'POST' && url.pathname === '/poc/g3/push') {
      try {
        const raw = await readBody(request);
        const body = JSON.parse(raw || '{}');
        if (!Array.isArray(body.ops)) {
          return json(response, 400, { error: { code: 'E-VAL-01', message: 'ops[] required' } });
        }
        const started = performance.now();
        const result = store.push(body.ops);
        return json(response, 200, {
          ...result,
          duration_ms: Math.round((performance.now() - started) * 100) / 100,
        });
      } catch (error) {
        const status = error.status ?? 400;
        return json(response, status, {
          error: { code: status === 413 ? 'E-LIM-01' : 'E-VAL-01', message: error.message },
        });
      }
    }

    if (request.method === 'GET' && url.pathname === '/poc/g3/changes') {
      const since = Number(url.searchParams.get('since_seq') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      return json(response, 200, store.changes(since, limit));
    }

    return json(response, 404, { error: { code: 'E-NOT-01', message: 'not found' } });
  });

  return {
    server,
    store,
    listen() {
      return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
          const address = server.address();
          resolve({ port: address.port, url: `http://127.0.0.1:${address.port}` });
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createServer({ port: Number(process.env.POC_G3_PORT ?? 8081) });
  app.listen().then(({ url }) => {
    console.log(`PoC G3 server: ${url}`);
  });
}
