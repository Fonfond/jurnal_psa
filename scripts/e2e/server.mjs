// Static SPA server + /v1 reverse proxy for the E2E smoke. Node built-ins only.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DIST = path.join(ROOT, 'apps/web/dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function serveFile(response, file) {
  try {
    const stat = statSync(file);
    response.writeHead(200, {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end('not found');
  }
}

function proxy(request, response, apiTarget) {
  const target = new URL(apiTarget);
  const upstream = httpRequest(
    {
      hostname: target.hostname,
      port: target.port,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, host: target.host },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on('error', (error) => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(502, { 'content-type': 'application/json' }).end(
      JSON.stringify({ error: { code: 'E-NET-01', message: error.message } }),
    );
  });
  request.pipe(upstream);
}

export function createE2eServer({ apiTarget = 'http://127.0.0.1:3121', port = 4173, host = '127.0.0.1' } = {}) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) {
      proxy(request, response, apiTarget);
      return;
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const candidate = path.resolve(DIST, relative || 'index.html');
    if (!candidate.startsWith(DIST)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    try {
      if (statSync(candidate).isFile()) {
        serveFile(response, candidate);
        return;
      }
    } catch {
      // SPA fallback below
    }
    serveFile(response, path.join(DIST, 'index.html'));
  });

  return {
    server,
    listen() {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve({ port, url: `http://${host}:${port}` }));
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
