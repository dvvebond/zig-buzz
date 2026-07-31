import { describe, expect, it } from "vitest";

import { TokenBucketRateLimiter } from "./rate-limit.js";

describe("token bucket rate limiter", () => {
  it("spends capacity and refills deterministically", () => {
    const limiter = new TokenBucketRateLimiter({
      capacity: 2,
      refillPerSecond: 1,
    });
    expect(limiter.consume("owner", 1, 0)).toBe(true);
    expect(limiter.consume("owner", 1, 0)).toBe(true);
    expect(limiter.consume("owner", 1, 0)).toBe(false);
    expect(limiter.consume("owner", 1, 999)).toBe(false);
    expect(limiter.consume("owner", 1, 1_000)).toBe(true);
  });

  it("fails closed when the bounded key map is full", () => {
    const limiter = new TokenBucketRateLimiter({
      capacity: 1,
      refillPerSecond: 1,
      maximumKeys: 1,
    });
    expect(limiter.consume("one", 1, 0)).toBe(true);
    expect(limiter.consume("two", 1, 0)).toBe(false);
    expect(limiter.keyCount()).toBe(1);
  });
});
