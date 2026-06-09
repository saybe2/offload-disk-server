/**
 * Tiny dependency-free concurrency limiter (semaphore).
 *
 * Used to cap how many expensive operations (full archive restore to disk +
 * ffmpeg remux / image re-render) can run at the same time on behalf of
 * UNAUTHENTICATED public-share viewers. Without this a handful of viewers can
 * pin every CPU core and exhaust the cache disk, even while staying under the
 * request-rate limit.
 *
 * tryAcquire() returns immediately:
 *   - a release function when a slot was free
 *   - null when the limiter (including its bounded wait queue) is full, so the
 *     caller can fail fast with 503 instead of piling up unbounded work.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly max: number;

  constructor(max: number) {
    this.max = Math.max(1, Math.floor(max));
  }

  get inUse(): number {
    return this.active;
  }

  get capacity(): number {
    return this.max;
  }

  /**
   * Acquire a slot if one is immediately available. Returns a single-use
   * release function, or null when all slots are busy.
   */
  tryAcquire(): (() => void) | null {
    if (this.active >= this.max) {
      return null;
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
    };
  }

  /**
   * Run `fn` while holding a slot. Throws ConcurrencyLimitError immediately if
   * no slot is available.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = this.tryAcquire();
    if (!release) {
      throw new ConcurrencyLimitError();
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class ConcurrencyLimitError extends Error {
  constructor() {
    super("concurrency_limit_reached");
    this.name = "ConcurrencyLimitError";
  }
}
