import type { AuthProviderKind } from '@logbook/shared';

export interface AuthorizeInput {
  redirectAfter?: string;
  deviceId?: string;
  userAgent?: string;
  ip?: string;
}

export interface AuthorizeResult {
  /** Full IdP authorization URL (browser redirect target). */
  url: string;
  /** Value of the short-lived HttpOnly state cookie. */
  stateCookieValue: string;
  maxAgeSeconds: number;
}

export interface CallbackInput {
  code?: string;
  state?: string;
  stateCookie?: string;
  error?: string;
  errorDescription?: string;
}

export interface OidcIdentity {
  issuer: string;
  subject: string;
  email: string | null;
  fullName: string | null;
  preferredUsername: string | null;
  claims: Record<string, unknown>;
}

export interface CallbackResult {
  identity: OidcIdentity;
  redirectAfter: string;
  deviceId: string | null;
}

/**
 * Authentication provider seam (ADR-22/ADR-23):
 * `dev` keeps email/password for local runs, `oidc` replaces it in production.
 */
export interface IdentityProvider {
  readonly kind: AuthProviderKind;
  /** true when the provider establishes a session through a browser redirect. */
  readonly redirectLogin: boolean;
}

export interface RedirectIdentityProvider extends IdentityProvider {
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>;
  complete(input: CallbackInput): Promise<CallbackResult>;
}
