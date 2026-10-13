// Fixed-window rate limiter. Redis holds only rate-limit counters (Section 5); when Redis is unavailable the
// limiter falls back to per-instance memory so ingest keeps working (API-001 degraded mode).
import type { Redis } from './redis.ts';
import { AppError } from '@leadguard/contracts';

export interface RateLimiter {
  /** Count one hit (or with peek only read the current count) in the current fixed window. */
  hit(key: string, limit: number, windowSeconds: number, opts?: { peek?: boolean }): Promise<{ allowed: boolean; retryAfter: number }>;
}

export function createRateLimiter(redis: Redis | null): RateLimiter {
  const mem = new Map<string, { n: number; reset: number }>();
  return {
    async hit(key, limit, windowSeconds, opts = {}) {
      const now = Date.now();
      const bucket = Math.floor(now / 1000 / windowSeconds);
      const retryAfter = (bucket + 1) * windowSeconds - Math.floor(now / 1000);
      if (redis?.available()) {
        try {
          const k = `rl:${key}:${bucket}`;
          if (opts.peek) return { allowed: Number((await redis.client.get(k)) ?? 0) < limit, retryAfter };
          const n = await redis.client.incr(k);
          if (n === 1) await redis.client.expire(k, windowSeconds + 1);
          return { allowed: n <= limit, retryAfter };
        } catch { /* fall back to memory */ }
      }
      const k = `${key}:${bucket}`;
      const e = mem.get(k) ?? { n: 0, reset: now + windowSeconds * 1000 };
      if (opts.peek) return { allowed: e.n < limit, retryAfter };
      e.n++;
      mem.set(k, e);
      if (mem.size > 10_000) for (const [mk, mv] of mem) if (mv.reset < now) mem.delete(mk);
      return { allowed: e.n <= limit, retryAfter };
    },
  };
}

export async function enforce(limiter: RateLimiter, key: string, limit: number, windowSeconds: number): Promise<void> {
  const r = await limiter.hit(key, limit, windowSeconds);
  if (!r.allowed) {
    throw new AppError('RATE_LIMITED', 'Too many requests. Try again shortly.', { retry_after_seconds: r.retryAfter }, { headers: { 'Retry-After': String(r.retryAfter) } });
  }
}
