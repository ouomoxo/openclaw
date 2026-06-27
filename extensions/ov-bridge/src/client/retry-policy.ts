/**
 * Retry policy for OV API calls.
 *
 * maxRetries = N means N additional attempts after the first, i.e. up to (1 + N) total attempts.
 * All retries reuse the SAME idempotencyKey, request payload, request fingerprint, and correlationId
 * (one logical request). Backoff is exponential with jitter and a bounded total budget.
 */

/** Retryable HTTP status codes (transient server/throttle conditions). */
export const RETRYABLE_HTTP_STATUS: readonly number[] = [429, 502, 503, 504];

/** Never-retry HTTP status codes (deterministic client/contract failures). */
export const NON_RETRYABLE_HTTP_STATUS: readonly number[] = [400, 401, 403, 404, 409, 422];

export function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUS.includes(status);
}

/** Network-level transient failures (connection reset/refused, DNS, abort-from-timeout). */
export function isRetryableNetworkKind(kind: "network" | "timeout"): boolean {
  return kind === "network" || kind === "timeout";
}

/** Base delay (ms) before a given attempt. attempt is 1-based; attempt 1 has no delay. */
export function backoffBaseMs(attempt: number): number {
  if (attempt <= 1) {
    return 0;
  }
  return 250 * (2 ** (attempt - 1) - 1); // attempt 2 -> 250, attempt 3 -> 750, ...
}

/**
 * Delay (ms) before `attempt` (1-based), with jitter in [base, 2*base), capped at maxDelayMs.
 * rng() returns a value in [0, 1); inject for deterministic tests.
 */
export function nextBackoffMs(attempt: number, rng: () => number, maxDelayMs = 4_000): number {
  const base = backoffBaseMs(attempt);
  if (base === 0) {
    return 0;
  }
  const jittered = base + Math.floor(rng() * base);
  return Math.min(jittered, maxDelayMs);
}
