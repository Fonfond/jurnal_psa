const MIN_DELAY_MS = 2 * 60 * 1000;
const MAX_DELAY_MS = 15 * 60 * 1000;

/**
 * Exponential backoff for outbox operations: 2, 4, 8, 15… minutes.
 * Attempts are 1-based (the first failure schedules the first delay).
 */
export function backoffDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(MIN_DELAY_MS * 2 ** exponent, MAX_DELAY_MS);
}
