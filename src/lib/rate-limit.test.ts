import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit";

describe("createRateLimiter", () => {
  it("allows up to capacity takes, then rejects", () => {
    const now = 0;
    const limiter = createRateLimiter({ capacity: 3, refillPerMs: 0, clock: () => now });

    expect(limiter.take("user-1")).toBe(true);
    expect(limiter.take("user-1")).toBe(true);
    expect(limiter.take("user-1")).toBe(true);
    expect(limiter.take("user-1")).toBe(false);
  });

  it("tracks buckets independently per key", () => {
    const now = 0;
    const limiter = createRateLimiter({ capacity: 1, refillPerMs: 0, clock: () => now });

    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
    // Un-related key is unaffected — своя ёмкость на пользователя.
    expect(limiter.take("b")).toBe(true);
  });

  it("refills tokens over time, capped at capacity", () => {
    let now = 0;
    // 1 token per 1000ms.
    const limiter = createRateLimiter({ capacity: 2, refillPerMs: 1 / 1000, clock: () => now });

    expect(limiter.take("user-1")).toBe(true);
    expect(limiter.take("user-1")).toBe(true);
    expect(limiter.take("user-1")).toBe(false);

    now += 1000; // +1 token
    expect(limiter.take("user-1")).toBe(true);
    expect(limiter.take("user-1")).toBe(false);

    now += 1_000_000; // huge gap — refill caps at capacity, doesn't overflow
    expect(limiter.take("user-1")).toBe(true);
    expect(limiter.take("user-1")).toBe(true);
    expect(limiter.take("user-1")).toBe(false);
  });

  it("a partial refill below one token is not enough to take", () => {
    let now = 0;
    const limiter = createRateLimiter({ capacity: 1, refillPerMs: 1 / 1000, clock: () => now });

    expect(limiter.take("user-1")).toBe(true);
    now += 500; // half a token
    expect(limiter.take("user-1")).toBe(false);
    now += 500; // now a full token accrued
    expect(limiter.take("user-1")).toBe(true);
  });

  it("matches the /api/tests budget shape: capacity 5 refilling over 10 minutes", () => {
    let now = 0;
    const limiter = createRateLimiter({ capacity: 5, refillPerMs: 5 / (10 * 60_000), clock: () => now });

    for (let i = 0; i < 5; i++) {
      expect(limiter.take("user-1")).toBe(true);
    }
    expect(limiter.take("user-1")).toBe(false);

    now += 10 * 60_000; // full window later — fully refilled
    for (let i = 0; i < 5; i++) {
      expect(limiter.take("user-1")).toBe(true);
    }
    expect(limiter.take("user-1")).toBe(false);
  });

  it("defaults to a real clock when none is injected (smoke test, no fake timers)", () => {
    const limiter = createRateLimiter({ capacity: 1, refillPerMs: 0 });
    expect(limiter.take("user-1")).toBe(true);
    expect(limiter.take("user-1")).toBe(false);
  });
});
