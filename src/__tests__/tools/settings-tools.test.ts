import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { settingsGet, settingsUpdate } from "../../tools/settings-tools.ts";
import { DEFAULTS } from "../../settings.ts";
import { createTestEnv, cleanupTestEnv, type TestEnv } from "../test-helpers.ts";

let env: TestEnv;

beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { await cleanupTestEnv(env); });

describe("settingsGet", () => {
  test("returns defaults when no settings file", async () => {
    const settings = await settingsGet(env.ctx);
    expect(settings).toEqual(DEFAULTS);
  });
});

describe("settingsUpdate", () => {
  test("updates and returns merged settings", async () => {
    const result = await settingsUpdate(env.ctx, { due_soon_days: 7 });
    expect(result.due_soon_days).toBe(7);
    expect(result.default_priority).toBe("medium");
  });

  test("persists across reads", async () => {
    await settingsUpdate(env.ctx, { default_priority: "high" });
    const settings = await settingsGet(env.ctx);
    expect(settings.default_priority).toBe("high");
  });

  test("accepts valid IANA timezone", async () => {
    const result = await settingsUpdate(env.ctx, { timezone: "America/New_York" });
    expect(result.timezone).toBe("America/New_York");
  });

  test("rejects invalid timezone", async () => {
    await expect(settingsUpdate(env.ctx, { timezone: "Fake/Zone" })).rejects.toThrow();
  });

  test("defaults timezone to UTC", async () => {
    const settings = await settingsGet(env.ctx);
    expect(settings.timezone).toBe("UTC");
  });
});
