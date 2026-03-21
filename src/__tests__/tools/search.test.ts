import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { taskSearch, taskQuery } from "../../tools/search.ts";
import { taskCreate } from "../../tools/crud.ts";
import { taskMove } from "../../tools/workflow.ts";
import { createTestEnv, cleanupTestEnv, type TestEnv } from "../test-helpers.ts";

let env: TestEnv;

beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { await cleanupTestEnv(env); });

describe("taskSearch", () => {
  test("finds tasks by keyword in title", async () => {
    await taskCreate(env.ctx, { title: "Fix payment webhook", body: "Stripe integration is flaky" });
    await taskCreate(env.ctx, { title: "Update docs" });

    const results = await taskSearch(env.ctx, { query: "payment" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.title).toBe("Fix payment webhook");
  });

  test("finds tasks by keyword in body", async () => {
    await taskCreate(env.ctx, { title: "Fix integration", body: "The xylophone module is broken" });

    const results = await taskSearch(env.ctx, { query: "xylophone" });
    expect(results.length).toBeGreaterThan(0);
  });

  test("returns empty array when no matches", async () => {
    await taskCreate(env.ctx, { title: "Something else" });

    const results = await taskSearch(env.ctx, { query: "nonexistentkeyword99" });
    expect(results.length).toBe(0);
  });

  test("returns multiple matches", async () => {
    await taskCreate(env.ctx, { title: "Database migration alpha" });
    await taskCreate(env.ctx, { title: "Database cleanup alpha" });
    await taskCreate(env.ctx, { title: "Unrelated task" });

    const results = await taskSearch(env.ctx, { query: "database" });
    expect(results.length).toBe(2);
  });

  test("respects limit parameter", async () => {
    await taskCreate(env.ctx, { title: "Match one database" });
    await taskCreate(env.ctx, { title: "Match two database" });
    await taskCreate(env.ctx, { title: "Match three database" });

    const results = await taskSearch(env.ctx, { query: "database", limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

describe("taskQuery", () => {
  test("filters search results by priority", async () => {
    await taskCreate(env.ctx, { title: "High auth fix", priority: "high", body: "Auth is broken" });
    await taskCreate(env.ctx, { title: "Low auth cleanup", priority: "low", body: "Auth code cleanup" });

    const results = await taskQuery(env.ctx, { query: "auth", priority: "high" });
    expect(results.length).toBe(1);
    expect(results[0]!.priority).toBe("high");
  });

  test("filters by tag", async () => {
    await taskCreate(env.ctx, { title: "Backend API task", tags: ["backend"], body: "API work" });
    await taskCreate(env.ctx, { title: "Frontend API task", tags: ["frontend"], body: "API work" });

    const results = await taskQuery(env.ctx, { query: "API", tag: "backend" });
    expect(results.length).toBe(1);
    expect(results[0]!.title).toContain("Backend");
  });

  test("filters by assignee", async () => {
    await taskCreate(env.ctx, { title: "Agent task work", assignee: "agent-1", body: "Do the work" });
    await taskCreate(env.ctx, { title: "Unassigned task work", body: "Also work" });

    const results = await taskQuery(env.ctx, { query: "work", assignee: "agent-1" });
    expect(results.length).toBe(1);
    expect(results[0]!.title).toContain("Agent");
  });
});
