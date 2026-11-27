import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 7636 verifier: 43–128 unreserved characters. */
export function createCodeVerifier(): string {
  return randomBytes(48).toString('base64url');
}

export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** Opaque, high-entropy `state` value (also stored as a hash in the DB). */
export function createState(): string {
  return randomBytes(32).toString('base64url');
}

/** Replay protection for the ID token. */
export function createNonce(): string {
  return randomBytes(24).toString('base64url');
}

/** Constant-time comparison for secrets of equal length (state, device key). */
export function safeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left, 'utf8').digest();
  const rightHash = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftHash, rightHash);
}

/**
 * Only same-origin, absolute-path redirects are allowed: prevents open
 * redirects through `redirect_after`/`OIDC_POST_LOGIN_REDIRECT`.
 */
export function safeRedirectTarget(
  value: string | undefined,
  fallback = '/',
): string {
  if (!value) {
    return fallback;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 512) {
    return fallback;
  }
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) {
    return fallback;
  }
  if (trimmed.includes('\\') || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return fallback;
  }
  return trimmed;
}
