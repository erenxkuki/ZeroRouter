/**
 * In-memory rate limiting: per-key token bucket + global in-flight cap.
 * State resets on restart, which is acceptable for a personal gateway
 * (documented limitation in docs/security.md).
 */
export interface BucketState {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, BucketState>();
  private inflight = new Map<string, number>();
  private globalInflight = 0;

  constructor(
    private readonly config: {
      burst: number;
      perMinute: number;
      maxInflight: number;
    },
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns null when allowed, or a suggested retry delay in ms. */
  tryConsume(key: string, cost = 1): number | null {
    const t = this.now();
    const refillPerMs = this.config.perMinute / 60_000;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.config.burst, updatedAt: t };
      this.buckets.set(key, bucket);
    }
    // refill
    const elapsed = t - bucket.updatedAt;
    bucket.tokens = Math.min(this.config.burst, bucket.tokens + elapsed * refillPerMs);
    bucket.updatedAt = t;
    if (bucket.tokens < cost) {
      const deficit = cost - bucket.tokens;
      return Math.ceil(deficit / refillPerMs);
    }
    bucket.tokens -= cost;
    return null;
  }

  /** Try to reserve an in-flight slot; releases are explicit. */
  tryAcquireInflight(key: string): number | null {
    const perKey = this.inflight.get(key) ?? 0;
    if (this.globalInflight >= this.config.maxInflight) return 1_000;
    if (perKey >= Math.max(2, Math.ceil(this.config.maxInflight / 4))) return 1_000;
    this.inflight.set(key, perKey + 1);
    this.globalInflight += 1;
    return null;
  }

  releaseInflight(key: string): void {
    const perKey = this.inflight.get(key) ?? 0;
    if (perKey <= 1) this.inflight.delete(key);
    else this.inflight.set(key, perKey - 1);
    this.globalInflight = Math.max(0, this.globalInflight - 1);
  }
}
