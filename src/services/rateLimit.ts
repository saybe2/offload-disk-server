import type { Request, Response, NextFunction } from "express";

/**
 * Minimal dependency-free fixed-window rate limiter (per-process, in-memory).
 *
 * Intended for brute-force / abuse mitigation on a single-instance deployment.
 * It is not a distributed limiter; if the app is ever scaled horizontally this
 * should be backed by Redis. Good enough to stop password brute force and
 * share-token enumeration on the current single-container setup.
 */

type Bucket = { count: number; resetAt: number };

export type RateLimitOptions = {
  windowMs: number;
  max: number;
  // Build the throttling key (defaults to client IP).
  keyGenerator?: (req: Request) => string;
  // Distinct label so different limiters don't share buckets.
  scope: string;
  message?: string;
};

const buckets = new Map<string, Bucket>();
let lastSweep = 0;

function sweep(now: number) {
  // Periodic cleanup so the map doesn't grow unbounded.
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

function clientIp(req: Request): string {
  // trust proxy is enabled in index.ts, so req.ip reflects X-Forwarded-For.
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function rateLimit(options: RateLimitOptions) {
  const { windowMs, max, scope } = options;
  const keyGenerator = options.keyGenerator || clientIp;
  const message = options.message || "too_many_requests";

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    sweep(now);

    const key = `${scope}:${keyGenerator(req)}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(429).json({ error: message });
    }

    next();
  };
}
