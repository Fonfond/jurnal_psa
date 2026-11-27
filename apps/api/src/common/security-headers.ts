import type { RequestHandler, Response } from 'express';
import type { Env } from '../config/env';

/**
 * API responses are JSON/CSV/PDF downloads and must never be framed, sniffed or
 * cached. CSP is intentionally strict: the API does not serve HTML; the SPA's
 * CSP is set by nginx (deploy/nginx/security-headers.conf).
 */
export const API_CONTENT_SECURITY_POLICY =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * The API also serves the pilot PWA.  The SPA needs its own script/style/
 * worker policy; nginx applies the equivalent policy for the production
 * split-origin setup.  Keep `connect-src 'self'` and no third-party origins.
 */
export const SPA_CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; " +
  "worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; " +
  "base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

export function applySecurityHeaders(
  response: Response,
  env: Pick<Env, 'NODE_ENV' | 'HSTS_MAX_AGE_SECONDS'>,
  isSpa = false,
): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader(
    'Permissions-Policy',
    'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
  );
  response.setHeader(
    'Content-Security-Policy',
    isSpa ? SPA_CONTENT_SECURITY_POLICY : API_CONTENT_SECURITY_POLICY,
  );
  response.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  response.setHeader('Cache-Control', 'no-store');
  if (env.NODE_ENV === 'production' && env.HSTS_MAX_AGE_SECONDS > 0) {
    response.setHeader(
      'Strict-Transport-Security',
      `max-age=${env.HSTS_MAX_AGE_SECONDS}; includeSubDomains`,
    );
  }
}

export function securityHeaders(env: Env): RequestHandler {
  return (request, response, next) => {
    // API responses stay JSON/CSV/PDF; only the SPA shell/assets get a
    // script-capable CSP.
    applySecurityHeaders(response, env, !request.path.startsWith('/v1'));
    next();
  };
}
