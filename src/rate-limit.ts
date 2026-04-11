/**
 * Per-key sliding-window failure rate limiter.
 *
 * Used to throttle brute-force attempts against the consent form. Only
 * failures are recorded — successful auth does not count toward the limit,
 * so legitimate users are never punished.
 *
 * In-memory by design: a server restart hands attackers a free reset, but
 * it also drops every in-flight auth code, so net effect is neutral and
 * we avoid DB writes on every failed login.
 */
export class FailureRateLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures: number = 5,
    private readonly windowMs: number = 15 * 60 * 1000,
  ) {}

  /**
   * Returns whether the key is currently over the limit. Self-prunes
   * expired entries as a side effect.
   */
  check(key: string): { blocked: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const pruned = (this.failures.get(key) ?? []).filter(t => t >= windowStart);

    if (pruned.length === 0) {
      this.failures.delete(key);
    } else {
      this.failures.set(key, pruned);
    }

    if (pruned.length >= this.maxFailures) {
      const oldest = pruned[0]!;
      const retryAfterMs = (oldest + this.windowMs) - now;
      return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    return { blocked: false, retryAfterSeconds: 0 };
  }

  recordFailure(key: string): void {
    const entries = this.failures.get(key) ?? [];
    entries.push(Date.now());
    this.failures.set(key, entries);
  }

  /** Drops entries with no fresh failures. Safe to call periodically. */
  sweep(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, entries] of this.failures) {
      const fresh = entries.filter(t => t >= cutoff);
      if (fresh.length === 0) this.failures.delete(key);
      else this.failures.set(key, fresh);
    }
  }

  /** Drops all state. Intended for test isolation between cases. */
  reset(): void {
    this.failures.clear();
  }

  /** Test helper: observable state. */
  size(): number {
    return this.failures.size;
  }
}
