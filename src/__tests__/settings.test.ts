import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { readSettings, writeSettings, validateSettings, DEFAULTS } from "../settings.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let tasksDir: string;

beforeEach(async () => {
  tasksDir = await mkdtemp(path.join(tmpdir(), "tf-settings-"));
});

afterEach(async () => {
  await rm(tasksDir, { recursive: true, force: true });
});

describe("readSettings", () => {
  test("returns defaults when settings.yml is missing", async () => {
    const settings = await readSettings(tasksDir);
    expect(settings).toEqual(DEFAULTS);
  });

  test("merges file values with defaults", async () => {
    await Bun.write(`${tasksDir}/settings.yml`, "due_soon_days: 7\n");
    const settings = await readSettings(tasksDir);
    expect(settings.due_soon_days).toBe(7);
    expect(settings.default_priority).toBe("medium");
  });

  test("validates file contents and rejects invalid values", async () => {
    await Bun.write(`${tasksDir}/settings.yml`, "due_soon_days: banana\n");
    await expect(readSettings(tasksDir)).rejects.toThrow();
  });
});

describe("writeSettings", () => {
  test("writes partial and returns merged result", async () => {
    const result = await writeSettings(tasksDir, { due_soon_days: 5 });
    expect(result.due_soon_days).toBe(5);
    expect(result.default_priority).toBe("medium");

    const reread = await readSettings(tasksDir);
    expect(reread.due_soon_days).toBe(5);
  });

  test("rejects invalid values without writing", async () => {
    await expect(writeSettings(tasksDir, { due_soon_days: -1 } as any)).rejects.toThrow();
    const settings = await readSettings(tasksDir);
    expect(settings).toEqual(DEFAULTS);
  });

  test("merges with existing non-default values", async () => {
    await writeSettings(tasksDir, { due_soon_days: 7 });
    const result = await writeSettings(tasksDir, { default_priority: "high" });
    expect(result.due_soon_days).toBe(7);
    expect(result.default_priority).toBe("high");
  });
});

describe("validateSettings", () => {
  test("accepts valid partial settings", () => {
    const result = validateSettings({ due_soon_days: 5, default_priority: "high" });
    expect(result).toEqual({ due_soon_days: 5, default_priority: "high" });
  });

  test("rejects invalid values", () => {
    expect(() => validateSettings({ due_soon_days: -1 })).toThrow();
    expect(() => validateSettings({ default_priority: "super" })).toThrow();
    expect(() => validateSettings({ due_soon_days: "not a number" })).toThrow();
  });

  test("rejects non-object input", () => {
    expect(() => validateSettings("garbage")).toThrow();
    expect(() => validateSettings(42)).toThrow();
  });

  test("strips unknown keys", () => {
    const result = validateSettings({ due_soon_days: 5, foo: "bar" });
    expect(result).toEqual({ due_soon_days: 5 });
    expect((result as any).foo).toBeUndefined();
  });
});
