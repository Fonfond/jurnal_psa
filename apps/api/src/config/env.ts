import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { findRepoRoot } from '../db/paths';

function booleanString(defaultValue: 'true' | 'false' = 'true') {
  return z
    .enum(['true', 'false'])
    .default(defaultValue)
    .transform((value) => value === 'true');
}

const optionalString = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  });

const DEV_COOKIE_SECRET = 'dev-only-change-me';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3001),
    DATABASE_URL: optionalString,
    /** pg pool size; the API is stateless, so size per instance is small. */
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
    /** TLS to PostgreSQL: disable for localhost, require/verify-full in production. */
    DATABASE_SSL_MODE: z
      .enum(['disable', 'require', 'verify-full'])
      .default('disable'),
    DATABASE_SSL_CA_PATH: optionalString,
    PGLITE_DIR: optionalString,
    RUN_MIGRATIONS_ON_START: booleanString(),
    DEV_SEED_PASSWORD: z.string().min(8).default('Logbook!2026'),
    COOKIE_SECRET: z.string().min(8).default(DEV_COOKIE_SECRET),
    SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
    /** Sliding idle timeout: a session unused longer than this is revoked. */
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
    CORS_ORIGIN: z.string().default('http://localhost:5173'),
    /** Behind nginx/reverse proxy: trust X-Forwarded-* for client IP/TLS. */
    TRUST_PROXY: booleanString('false'),

    // --- AUTH-04/05: edge/API rate limiting and security headers ---
    RATE_LIMIT_ENABLED: booleanString(),
    /** Load-test only: bypass rate limiting (forbidden in production). */
    LOADTEST_RATE_LIMIT_DISABLED: booleanString('false'),
    RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100000).default(300),
    AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(86400)
      .default(900),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10000).default(20),
    HSTS_MAX_AGE_SECONDS: z.coerce.number().int().min(0).max(63072000).default(31536000),
    /**
     * ADR-14: separate admin origin (`https://admin.example.com`). The SPA is
     * served from this origin, the API allows it in CORS and the admin session
     * therefore lives in its own cookie jar.
     */
    ADMIN_ORIGIN: optionalString,
    /**
     * FR-PRM-11 is explicitly configurable until the customer approves the
     * final permit-visibility policy. Default keeps the current demo behaviour.
     */
    PERMIT_VISIBILITY_MODE: z.enum(['all', 'participant']).default('all'),

    // --- Authentication (ADR-22 dev provider, ADR-23 OIDC provider) ---
    /** dev = email/password for local runs; oidc = corporate Authorization Code + PKCE. */
    AUTH_PROVIDER: z.enum(['dev', 'oidc']).default('dev'),
    /** Explicit kill-switch for the dev provider; forced off in production. */
    DEV_LOGIN_ENABLED: booleanString(),
    OIDC_ISSUER: optionalString,
    OIDC_CLIENT_ID: optionalString,
    OIDC_CLIENT_SECRET: optionalString,
    OIDC_REDIRECT_URI: optionalString,
    /** Same-origin SPA path after successful login. */
    OIDC_POST_LOGIN_REDIRECT: z.string().default('/'),
    OIDC_DISPLAY_NAME: z.string().default('Корпоративный IdP'),
    OIDC_SCOPES: z.string().default('openid profile email'),
    OIDC_ALLOWED_ALGORITHMS: z.string().default('RS256'),
    OIDC_CLOCK_SKEW_SECONDS: z.coerce.number().int().min(0).max(300).default(60),
    OIDC_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).default(5000),
    /** Just-in-time provisioning is off by default: self-registration is forbidden. */
    OIDC_JIT_PROVISION: booleanString('false'),
    OIDC_JIT_DEPARTMENT_ID: optionalString,
    OIDC_JIT_ROLE: z
      .enum(['worker', 'supervisor', 'admin', 'auditor'])
      .default('worker'),
    OIDC_LOGIN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
    /** NFR-SEC-02: MFA is mandatory for admins; require `acr`/`amr` from the IdP. */
    OIDC_REQUIRE_MFA_FOR_ADMIN: booleanString(),
    /** Accepted acr values (comma-separated); sent as acr_values to the IdP. */
    OIDC_MFA_ACR_VALUES: z.string().default('mfa'),

    // --- Electronic signature abstraction (OQ-04) ---
    /** none = no signing; simple = server HMAC; qualified = external КЭП adapter. */
    SIGNATURE_PROVIDER: z.enum(['none', 'simple', 'qualified']).default('none'),
    SIGNATURE_SECRET: optionalString,
    SIGNATURE_KEY_ID: z.string().default('logbook-simple-v1'),
    /** Signed permit PDF URLs (OQ-03). Falls back to COOKIE_SECRET. */
    PERMIT_PDF_SECRET: optionalString,
    PERMIT_PDF_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(900),
    /** Optional absolute base for generated signed links. */
    PERMIT_PDF_PUBLIC_BASE_URL: optionalString,
    /** WORM journal exports and retention (JRN-04/JRN-07). */
    EXPORT_SIGNING_SECRET: optionalString,
    EXPORT_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(900),
    EXPORT_PUBLIC_BASE_URL: optionalString,
    RETENTION_YEARS: z.coerce.number().int().min(1).max(10).default(3),
    /** REP-05: daily retention scheduler (in-process; external cron may disable). */
    RETENTION_SCHEDULER_ENABLED: booleanString(),
    RETENTION_SCHEDULE_UTC: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Ожидается HH:MM в UTC')
      .default('02:00'),
    /** Overdue alert when the last successful run is older than this. */
    RETENTION_OVERDUE_HOURS: z.coerce.number().int().min(6).max(168).default(26),
    /** TTL: change_log older than N days is deleted (ADR-07, cursor guard). */
    CHANGE_LOG_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(90),
    /** TTL: expired non-WORM export jobs are removed. */
    EXPORT_JOB_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
    /** Optional webhook for retention alerts (JSON POST); logs/DB always kept. */
    RETENTION_ALERT_WEBHOOK_URL: z.string().url().optional(),
    RETENTION_ALERT_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).default(5000),
    SIGNATURE_AUTO_SIGN: booleanString(),
    SIGNATURE_LEGAL_NOTE: optionalString,
    SIGNATURE_QUALIFIED_ENDPOINT: optionalString,
    SIGNATURE_QUALIFIED_TOKEN: optionalString,
    SIGNATURE_QUALIFIED_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(30000)
      .default(5000),
  })
  .superRefine((value, ctx) => {
    const issue = (path: string, message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };

    if (value.AUTH_PROVIDER === 'oidc') {
      if (!value.OIDC_ISSUER) {
        issue('OIDC_ISSUER', 'обязателен при AUTH_PROVIDER=oidc');
      }
      if (!value.OIDC_CLIENT_ID) {
        issue('OIDC_CLIENT_ID', 'обязателен при AUTH_PROVIDER=oidc');
      }
      if (!value.OIDC_REDIRECT_URI) {
        issue('OIDC_REDIRECT_URI', 'обязателен при AUTH_PROVIDER=oidc');
      }
      if (value.OIDC_ISSUER && !isHttpsUrl(value.OIDC_ISSUER)) {
        issue('OIDC_ISSUER', 'должен быть https-URL (http допускается для localhost)');
      }
      if (value.OIDC_REDIRECT_URI && !isHttpsUrl(value.OIDC_REDIRECT_URI)) {
        issue(
          'OIDC_REDIRECT_URI',
          'должен быть https-URL (http допускается для localhost)',
        );
      }
      if (value.OIDC_JIT_PROVISION && !value.OIDC_JIT_DEPARTMENT_ID) {
        issue(
          'OIDC_JIT_DEPARTMENT_ID',
          'обязателен при OIDC_JIT_PROVISION=true (иначе некуда создавать пользователя)',
        );
      }
    }

    if (value.SIGNATURE_PROVIDER === 'simple') {
      if (!value.SIGNATURE_SECRET) {
        issue('SIGNATURE_SECRET', 'обязателен при SIGNATURE_PROVIDER=simple');
      } else if (value.SIGNATURE_SECRET.length < 32) {
        issue('SIGNATURE_SECRET', 'должен быть не короче 32 символов');
      }
    }
    if (value.SIGNATURE_PROVIDER === 'qualified') {
      if (!value.SIGNATURE_QUALIFIED_ENDPOINT) {
        issue(
          'SIGNATURE_QUALIFIED_ENDPOINT',
          'обязателен при SIGNATURE_PROVIDER=qualified',
        );
      }
      if (!value.SIGNATURE_QUALIFIED_TOKEN) {
        issue(
          'SIGNATURE_QUALIFIED_TOKEN',
          'обязателен при SIGNATURE_PROVIDER=qualified',
        );
      }
    }

    if (value.NODE_ENV === 'production') {
      if (!value.DATABASE_URL) {
        issue(
          'DATABASE_URL',
          'production требует DATABASE_URL: PGlite/память допустимы только локально',
        );
      }
      if (value.AUTH_PROVIDER !== 'oidc') {
        issue('AUTH_PROVIDER', 'production требует AUTH_PROVIDER=oidc (ADR-22)');
      }
      if (!value.OIDC_REQUIRE_MFA_FOR_ADMIN) {
        issue(
          'OIDC_REQUIRE_MFA_FOR_ADMIN',
          'production требует MFA для администратора (NFR-SEC-02)',
        );
      }
      if (value.DEV_LOGIN_ENABLED) {
        issue('DEV_LOGIN_ENABLED', 'production требует DEV_LOGIN_ENABLED=false');
      }
      if (value.COOKIE_SECRET === DEV_COOKIE_SECRET || value.COOKIE_SECRET.length < 32) {
        issue(
          'COOKIE_SECRET',
          'production требует собственный секрет не короче 32 символов',
        );
      }
      if (value.CORS_ORIGIN.startsWith('http://') && !isLocalhostOrigin(value.CORS_ORIGIN)) {
        issue('CORS_ORIGIN', 'production требует https-origin');
      }
      if (value.SESSION_IDLE_MINUTES > 120) {
        issue(
          'SESSION_IDLE_MINUTES',
          'production требует idle timeout не более 120 минут (AUTH-04)',
        );
      }
      if (!value.RATE_LIMIT_ENABLED) {
        issue('RATE_LIMIT_ENABLED', 'production требует включённый rate limit (AUTH-04)');
      }
      if (value.LOADTEST_RATE_LIMIT_DISABLED) {
        issue(
          'LOADTEST_RATE_LIMIT_DISABLED',
          'production запрещает обход rate limit (только loadtest-стенд)',
        );
      }
      if (value.AUTH_RATE_LIMIT_MAX > 100) {
        issue(
          'AUTH_RATE_LIMIT_MAX',
          'production: не более 100 попыток входа за окно (AUTH-04)',
        );
      }
      if (value.HSTS_MAX_AGE_SECONDS < 86400) {
        issue('HSTS_MAX_AGE_SECONDS', 'production требует HSTS max-age не менее 1 дня');
      }
      if (value.ADMIN_ORIGIN) {
        if (
          value.ADMIN_ORIGIN.startsWith('http://') &&
          !isLocalhostOrigin(value.ADMIN_ORIGIN)
        ) {
          issue('ADMIN_ORIGIN', 'production требует https-origin для админки');
        }
        if (value.ADMIN_ORIGIN === value.CORS_ORIGIN) {
          issue('ADMIN_ORIGIN', 'админка должна быть на отдельном origin (ADR-14)');
        }
      }
      if (
        value.DATABASE_URL &&
        !isLocalhostDatabaseUrl(value.DATABASE_URL) &&
        value.DATABASE_SSL_MODE === 'disable'
      ) {
        issue(
          'DATABASE_SSL_MODE',
          'production с внешней БД требует TLS (require/verify-full)',
        );
      }
      if (value.DATABASE_SSL_MODE === 'verify-full' && !value.DATABASE_SSL_CA_PATH) {
        issue(
          'DATABASE_SSL_CA_PATH',
          'обязателен при DATABASE_SSL_MODE=verify-full',
        );
      }
    }
  });

function isLocalhostDatabaseUrl(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  } catch {
    return false;
  }
}

function isLocalhostOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') {
      return true;
    }
    return url.protocol === 'http:' && isLocalhostOrigin(value);
  } catch {
    return false;
  }
}

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/** Pure parser used by tests and by `loadEnv`. */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.map((part) => String(part)).join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return parsed.data;
}

export function loadEnv(force = false): Env {
  if (cached && !force) {
    return cached;
  }

  const envFile = process.env.ENV_FILE ?? path.join(findRepoRoot(), '.env');
  loadDotenv({ path: envFile, quiet: true });

  cached = parseEnv(process.env);
  return cached;
}

/** Test helper: drop the cached env so a spec can load a different profile. */
export function resetEnvCache(): void {
  cached = null;
}
