export const SESSION_COOKIE = 'lb_session';
export const CSRF_COOKIE = 'lb_csrf';

/** OIDC login transaction binding: HttpOnly, short-lived, scoped to /v1/auth. */
export const OIDC_STATE_COOKIE = 'lb_oidc_state';
export const OIDC_STATE_COOKIE_PATH = '/v1/auth';
