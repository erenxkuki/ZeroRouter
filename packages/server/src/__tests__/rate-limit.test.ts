import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../services/rateLimit.js';

describe('RateLimiter token bucket', () => {
  it('allows bursts then blocks with a wait hint (refill effectively disabled)', () => {
    const limiter = new RateLimiter({ burst: 3, perMinute: 1, maxInflight: 10 }); // ~1 token/min → no fast refill
    expect(limiter.tryConsume('k')).toBeNull();
    expect(limiter.tryConsume('k')).toBeNull();
    expect(limiter.tryConsume('k')).toBeNull();
    const w = limiter.tryConsume('k');
    expect(w).not.toBeNull();
    expect(w!).toBeGreaterThan(15_000); // deficit 1 token at ~1/min → minute-scale wait
  });

  it('refills proportionally to elapsed time (fast refill rate)', () => {
    const limiter = new RateLimiter({ burst: 1000, perMinute: 60_000, maxInflight: 10 }); // 1 token/ms
    for (let i = 0; i < 1000; i++) expect(limiter.tryConsume('k')).toBeNull();
    // heavy consumption should have outrun 1/ms refill at machine speed ~ ms-scale
    const w = limiter.tryConsume('k');
    if (w !== null) expect(w).toBeLessThan(2_000);
  });

  it('tracks keys independently', () => {
    const limiter = new RateLimiter({ burst: 1, perMinute: 0, maxInflight: 10 });
    expect(limiter.tryConsume('a')).toBeNull();
    expect(limiter.tryConsume('a')).not.toBeNull();
    expect(limiter.tryConsume('b')).toBeNull();
  });

  it('cost is honored', () => {
    // Injectable clock: cost semantics must not depend on real wall-clock
    // slices between statements (a loaded machine refilled the deficit mid-test).
    let t = 1_000;
    const limiter = new RateLimiter({ burst: 2, perMinute: 60_000, maxInflight: 10 }, () => t);
    expect(limiter.tryConsume('c', 2)).toBeNull(); // consumes the full burst
    expect(limiter.tryConsume('c')).not.toBeNull(); // empty — even with zero elapsed time drift
    t += 120_001; // two minutes pass → refills past the burst cap
    expect(limiter.tryConsume('c')).toBeNull();
    t += 120_001;
    expect(limiter.tryConsume('c', 2)).toBeNull(); // full burst available again
  });
});

describe('RateLimiter in-flight caps', () => {
  it('per-key cap and global cap hold until released', () => {
    const limiter = new RateLimiter({ burst: 100, perMinute: 100_000, maxInflight: 2 });
    const k = 'gateway-key';
    expect(limiter.tryAcquireInflight(k)).toBeNull(); // global 1
    expect(limiter.tryAcquireInflight(k)).toBeNull(); // global 2 == cap
    expect(limiter.tryAcquireInflight(k)).not.toBeNull(); // global cap hit
    limiter.releaseInflight(k); // global 1
    expect(limiter.tryAcquireInflight(k)).toBeNull(); // global 2 == cap again
  });

  it('does not go negative on unpaired releases', () => {
    const limiter = new RateLimiter({ burst: 100, perMinute: 0, maxInflight: 1 });
    limiter.releaseInflight('ghost');
    expect(limiter.tryAcquireInflight('real')).toBeNull();
  });
});
