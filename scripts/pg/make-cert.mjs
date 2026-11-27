// Generates a self-signed TLS certificate for the local PostgreSQL lab.
//
//   node scripts/pg/make-cert.mjs <out-dir>
//
// Prefers openssl from the PostgreSQL bundle (if present), otherwise uses the
// `selfsigned` package (`npm install --no-save selfsigned`). Production uses a
// corporate CA; see db/postgres/README.md.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.data', 'pg15', 'certs'));
mkdirSync(outDir, { recursive: true });
const certPath = join(outDir, 'server.crt');
const keyPath = join(outDir, 'server.key');

const openssl = process.env.OPENSSL_PATH ?? '';
if (openssl && existsSync(openssl)) {
  execFileSync(openssl, [
    'req', '-new', '-x509', '-days', '825', '-nodes', '-text',
    '-out', certPath,
    '-keyout', keyPath,
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'inherit' });
  console.log(`Certificate written with openssl: ${certPath}`);
  process.exit(0);
}

const { generate } = await import('selfsigned');
const pems = await generate([{ name: 'commonName', value: 'localhost' }], {
  days: 825,
  keySize: 2048,
  algorithm: 'sha256',
  extensions: [
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
      ],
    },
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
  ],
});
writeFileSync(certPath, pems.cert, 'utf8');
writeFileSync(keyPath, pems.private, 'utf8');
console.log(`Certificate written with selfsigned: ${certPath}`);
