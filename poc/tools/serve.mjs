// Minimal static server for PoC harnesses. Node built-ins only.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function createStaticServer({ root = ROOT, port = 8080, host = '127.0.0.1' } = {}) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const resolved = path.resolve(root, relative);
    if (!resolved.startsWith(root)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    let target = resolved;
    try {
      if (statSync(target).isDirectory()) target = path.join(target, 'index.html');
    } catch {
      response.writeHead(404).end('not found');
      return;
    }
    try {
      const stat = statSync(target);
      response.writeHead(200, {
        'content-type': TYPES[path.extname(target)] ?? 'application/octet-stream',
        'content-length': stat.size,
        'cache-control': 'no-store',
      });
      createReadStream(target).pipe(response);
    } catch {
      response.writeHead(404).end('not found');
    }
  });

  return {
    server,
    listen() {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const address = server.address();
          resolve({ port: address.port, url: `http://${host}:${address.port}` });
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(HERE, 'serve.mjs')) {
  const port = Number(process.env.POC_HTTP_PORT ?? 8080);
  createStaticServer({ port }).listen().then(({ url }) => {
    console.log(`PoC static server: ${url}/`);
  });
}
