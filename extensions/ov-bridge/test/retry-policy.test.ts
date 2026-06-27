import { describe, it, expect } from "vitest";
import {
  RETRYABLE_HTTP_STATUS,
  NON_RETRYABLE_HTTP_STATUS,
  isRetryableHttpStatus,
  isRetryableNetworkKind,
  backoffBaseMs,
  nextBackoffMs,
} from "../src/client/retry-policy.js";

describe("retry policy", () => {
  it("treats 429/502/503/504 as retryable", () => {
    for (const s of RETRYABLE_HTTP_STATUS) {
      expect(isRetryableHttpStatus(s)).toBe(true);
    }
  });

  it("treats 400/401/403/404/409/422 as non-retryable", () => {
    for (const s of NON_RETRYABLE_HTTP_STATUS) {
      expect(isRetryableHttpStatus(s)).toBe(false);
    }
  });

  it("treats network and timeout kinds as retryable", () => {
    expect(isRetryableNetworkKind("network")).toBe(true);
    expect(isRetryableNetworkKind("timeout")).toBe(true);
  });

  it("uses exponential base delays (attempt 2 -> 250ms, attempt 3 -> 750ms)", () => {
    expect(backoffBaseMs(1)).toBe(0);
    expect(backoffBaseMs(2)).toBe(250);
    expect(backoffBaseMs(3)).toBe(750);
  });

  it("applies jitter within [base, 2*base)", () => {
    expect(nextBackoffMs(2, () => 0)).toBe(250);
    expect(nextBackoffMs(2, () => 0.999)).toBeGreaterThanOrEqual(250);
    expect(nextBackoffMs(2, () => 0.999)).toBeLessThan(500);
    expect(nextBackoffMs(3, () => 0)).toBe(750);
    expect(nextBackoffMs(3, () => 0.999)).toBeLessThan(1500);
  });

  it("caps the delay at the max budget", () => {
    expect(nextBackoffMs(10, () => 0.999, 4_000)).toBeLessThanOrEqual(4_000);
  });
});
