import { test, expect, describe } from "bun:test";
import { FailureRateLimiter } from "../rate-limit.ts";

describe("FailureRateLimiter", () => {
  test("fresh key is never blocked", () => {
    const rl = new FailureRateLimiter(5, 1000);
    expect(rl.check("1.2.3.4").blocked).toBe(false);
  });

  test("blocks after exactly maxFailures failures", () => {
    const rl = new FailureRateLimiter(5, 10_000);
    for (let i = 0; i < 4; i++) rl.recordFailure("1.2.3.4");
    expect(rl.check("1.2.3.4").blocked).toBe(false);
    rl.recordFailure("1.2.3.4");
    expect(rl.check("1.2.3.4").blocked).toBe(true);
  });

  test("retryAfter matches the window when failures are back-to-back", () => {
    const rl = new FailureRateLimiter(2, 10_000);
    rl.recordFailure("x");
    rl.recordFailure("x");
    const result = rl.check("x");
    expect(result.blocked).toBe(true);
    // Oldest failure timestamp is ~now, so retry should round to exactly the
    // window size. Allow 1s slack in case the clock tick happens to land on
    // a ms boundary that ceilings down by one.
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(9);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(10);
  });

  test("distinct keys are isolated", () => {
    const rl = new FailureRateLimiter(2, 10_000);
    rl.recordFailure("a");
    rl.recordFailure("a");
    expect(rl.check("a").blocked).toBe(true);
    expect(rl.check("b").blocked).toBe(false);
  });

  test("entries older than the window are pruned on check", async () => {
    // 100ms window + 200ms sleep gives ~100ms of slack for slow CI.
    const rl = new FailureRateLimiter(2, 100);
    rl.recordFailure("k");
    rl.recordFailure("k");
    expect(rl.check("k").blocked).toBe(true);
    await Bun.sleep(200);
    expect(rl.check("k").blocked).toBe(false);
  });

  test("successful usage does not block", () => {
    const rl = new FailureRateLimiter(5, 10_000);
    for (let i = 0; i < 100; i++) {
      expect(rl.check("user").blocked).toBe(false);
    }
  });

  test("sweep drops keys whose entries have all expired", async () => {
    const rl = new FailureRateLimiter(5, 100);
    rl.recordFailure("a");
    rl.recordFailure("b");
    expect(rl.size()).toBe(2);
    await Bun.sleep(200);
    rl.sweep();
    expect(rl.size()).toBe(0);
  });

  test("sweep keeps keys with fresh entries", async () => {
    const rl = new FailureRateLimiter(5, 150);
    rl.recordFailure("old");
    await Bun.sleep(200);
    rl.recordFailure("new");
    rl.sweep();
    expect(rl.size()).toBe(1);
  });

  test("reset clears all buckets", () => {
    const rl = new FailureRateLimiter(2, 10_000);
    rl.recordFailure("a");
    rl.recordFailure("a");
    expect(rl.check("a").blocked).toBe(true);
    rl.reset();
    expect(rl.check("a").blocked).toBe(false);
    expect(rl.size()).toBe(0);
  });

  test("unknown-ip bucket does not leak state to other keys", () => {
    // Guards against a regression where server.ts used req.ip ?? "unknown"
    // and collapsed every anonymous request into one bucket.
    const rl = new FailureRateLimiter(2, 10_000);
    rl.recordFailure("unknown");
    rl.recordFailure("unknown");
    expect(rl.check("unknown").blocked).toBe(true);
    expect(rl.check("1.2.3.4").blocked).toBe(false);
  });
});
