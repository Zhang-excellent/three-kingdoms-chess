export interface RateLimitResult {
  ok: boolean;
  retryAfterSeconds: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  hit(key: string, limit: number, windowMs: number): RateLimitResult {
    const current = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= current) {
      bucket = { count: 0, resetAt: current + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count++;
    return {
      ok: bucket.count <= limit,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - current) / 1000)),
    };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  prune(): void {
    const current = this.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= current) this.buckets.delete(key);
    }
  }
}
