interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Token bucket per key. A limit of N per minute allows a burst of N and refills continuously.
 * State is in memory, so limits are per gateway process.
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Returns 0 when the request may proceed, or the seconds to wait before retrying. */
  take(key: string, perMinute: number): number {
    const t = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: perMinute, updatedAt: t };
    const refill = ((t - bucket.updatedAt) / 60_000) * perMinute;
    bucket.tokens = Math.min(perMinute, bucket.tokens + refill);
    bucket.updatedAt = t;
    this.buckets.set(key, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - bucket.tokens) / perMinute) * 60);
  }
}
