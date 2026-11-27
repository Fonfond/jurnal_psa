import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv, resetEnvCache } from '../src/config/env';

/**
 * Fail-closed production gate: the API must never fall back to PGlite/in-memory
 * when NODE_ENV=production. `parseEnv` is covered in auth-platform.spec.ts;
 * this spec exercises `loadEnv` end-to-end with a controlled ENV_FILE.
 */
describe('loadEnv production database gate', () => {
  const keys = [
    'ENV_FILE',
    'NODE_ENV',
    'DATABASE_URL',
    'PGLITE_DIR',
    'DATABASE_SSL_MODE',
    'DATABASE_SSL_CA_PATH',
    'AUTH_PROVIDER',
    'DEV_LOGIN_ENABLED',
    'COOKIE_SECRET',
    'CORS_ORIGIN',
    'ADMIN_ORIGIN',
    'OIDC_ISSUER',
    'OIDC_CLIENT_ID',
    'OIDC_CLIENT_SECRET',
    'OIDC_REDIRECT_URI',
    'SIGNATURE_PROVIDER',
    'RUN_MIGRATIONS_ON_START',
  ] as const;

  const original: Record<string, string | undefined> = {};
  let dir = '';
  let envFile = '';

  beforeEach(() => {
    for (const key of keys) {
      original[key] = process.env[key];
    }
    dir = mkdtempSync(join(tmpdir(), 'logbook-env-'));
    envFile = join(dir, 'empty.env');
    writeFileSync(envFile, '', 'utf8');

    for (const key of keys) {
      delete process.env[key];
    }
    Object.assign(process.env, {
      ENV_FILE: envFile,
      NODE_ENV: 'production',
      AUTH_PROVIDER: 'oidc',
      DEV_LOGIN_ENABLED: 'false',
      COOKIE_SECRET: 's'.repeat(48),
      CORS_ORIGIN: 'https://logbook.test',
      OIDC_ISSUER: 'https://idp.test',
      OIDC_CLIENT_ID: 'logbook',
      OIDC_REDIRECT_URI: 'https://logbook.test/v1/auth/callback',
      SIGNATURE_PROVIDER: 'none',
      DATABASE_SSL_MODE: 'disable',
    });
    resetEnvCache();
  });

  afterEach(() => {
    for (const key of keys) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
    resetEnvCache();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to start production without DATABASE_URL', () => {
    expect(() => loadEnv(true)).toThrow(/DATABASE_URL/);
    expect(() => loadEnv(true)).toThrow(/production/i);
  });

  it('refuses production PGLITE_DIR instead of DATABASE_URL', () => {
    process.env.PGLITE_DIR = '.data/pglite';
    expect(() => loadEnv(true)).toThrow(/DATABASE_URL/);
  });

  it('loads production with DATABASE_URL and keeps TLS defaults intact', () => {
    process.env.DATABASE_URL = 'postgres://logbook:logbook@localhost:5432/logbook';
    const env = loadEnv(true);
    expect(env.NODE_ENV).toBe('production');
    expect(env.DATABASE_URL).toBe(
      'postgres://logbook:logbook@localhost:5432/logbook',
    );
    expect(env.DATABASE_SSL_MODE).toBe('disable');
  });

  it('keeps development PGlite fallback unchanged', () => {
    process.env.NODE_ENV = 'development';
    process.env.AUTH_PROVIDER = 'dev';
    process.env.DEV_LOGIN_ENABLED = 'true';
    process.env.PGLITE_DIR = '.data/pglite';
    const env = loadEnv(true);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.PGLITE_DIR).toBe('.data/pglite');
  });
});
