// In-memory token-bucket rate limiter (Task 6).
//
// BEST-EFFORT ONLY:
// - State lives in process memory (a plain Map). It resets on every deploy
//   / cold start / restart.
// - It is NOT shared across serverless instances — Vercel may route
//   concurrent requests from the same user to different lambda instances,
//   each holding its own bucket, so the effective limit under heavy
//   concurrency can exceed `capacity`.
// - This is a soft guard against accidental abuse (e.g. a buggy client
//   retry-looping test assembly, which is the expensive LLM-calling path),
//   not a hard security boundary. A durable/shared limiter (Redis, a DB
//   table) is a deferred item — see docs/superpowers/plans/2026-07-07-stage-2-test-engine.md
//   Deferrals ("durable rate limit (Redis/таблица)").

export type Clock = () => number;

export interface RateLimiter {
  /** Attempts to consume one token for `key`. Returns false if none available. */
  take(key: string): boolean;
}

export interface RateLimiterOptions {
  /** Max tokens a bucket can hold (also the burst size). */
  capacity: number;
  /** Tokens regenerated per millisecond. */
  refillPerMs: number;
  /** Injectable clock for tests; defaults to Date.now. */
  clock?: Clock;
}

type Bucket = { tokens: number; lastRefillAt: number };

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { capacity, refillPerMs, clock = Date.now } = options;
  const buckets = new Map<string, Bucket>();

  return {
    take(key: string): boolean {
      const now = clock();
      let bucket = buckets.get(key);

      if (!bucket) {
        bucket = { tokens: capacity, lastRefillAt: now };
        buckets.set(key, bucket);
      } else {
        const elapsedMs = now - bucket.lastRefillAt;
        if (elapsedMs > 0) {
          bucket.tokens = Math.min(capacity, bucket.tokens + elapsedMs * refillPerMs);
          bucket.lastRefillAt = now;
        }
      }

      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
  };
}
