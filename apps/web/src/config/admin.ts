/**
 * Admin contour configuration (ADR-14).
 *
 * The admin SPA is the same build, served from a dedicated origin
 * (`https://admin.example.com`). The origin is configured at build/run time
 * with `VITE_ADMIN_ORIGIN`; on that origin `/` redirects to `/admin`, and the
 * API returns the CSRF token in `/v1/me` because the API cookie is not
 * readable across origins.
 */
export const ADMIN_ORIGIN = (import.meta.env.VITE_ADMIN_ORIGIN ?? '').replace(
  /\/$/,
  '',
);

export const ADMIN_BASE_PATH = '/admin';

export function isAdminOrigin(): boolean {
  if (!ADMIN_ORIGIN || typeof window === 'undefined') {
    return false;
  }
  return window.location.origin === ADMIN_ORIGIN;
}

/** Absolute URL of the operational SPA from the admin origin. */
export function operationsUrl(path = '/'): string {
  return ADMIN_ORIGIN ? path : path;
}
