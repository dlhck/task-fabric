import { test, expect, describe } from "bun:test";
import { generateId, slugify, parseTask, serializeTask, resolveTaskPath } from "../task.ts";
import type { Task } from "../types.ts";

describe("generateId", () => {
  test("produces t_ prefix with 8-char suffix", () => {
    const id = generateId();
    expect(id).toMatch(/^t_[A-Za-z0-9_-]{8}$/);
  });

  test("produces unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

describe("slugify", () => {
  test("lowercases and hyphenates", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  test("strips special characters", () => {
    expect(slugify("Fix bug #42: auth fails!")).toBe("fix-bug-42-auth-fails");
  });

  test("handles unicode/accented chars", () => {
    expect(slugify("Café résumé")).toBe("cafe-resume");
  });

  test("collapses multiple separators", () => {
    expect(slugify("a---b   c")).toBe("a-b-c");
  });

  test("trims leading/trailing hyphens", () => {
    expect(slugify("--hello--")).toBe("hello");
  });

  test("returns 'untitled' for empty/whitespace input", () => {
    expect(slugify("")).toBe("untitled");
    expect(slugify("   ")).toBe("untitled");
    expect(slugify("!!!")).toBe("untitled");
  });

  test("truncates at 80 characters", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(80);
  });

  test("returns 'untitled' for CJK-only input (non-Latin scripts are stripped)", () => {
    expect(slugify("任务管理")).toBe("untitled");
  });

  test("returns 'untitled' for emoji-only input", () => {
    expect(slugify("🚀🔥")).toBe("untitled");
  });
});

describe("parseTask", () => {
  test("parses valid markdown with frontmatter", () => {
    const content = `---
id: t_abc12345
title: Test task
status: active
priority: high
tags:
  - backend
created: "2026-01-15T10:00:00Z"
updated: "2026-01-15T12:00:00Z"
---
Task body here.`;
    const task = parseTask(content);
    expect(task.id).toBe("t_abc12345");
    expect(task.title).toBe("Test task");
    expect(task.status).toBe("active");
    expect(task.priority).toBe("high");
    expect(task.tags).toEqual(["backend"]);
    expect(task.body).toBe("Task body here.");
  });

  test("defaults priority to medium when missing", () => {
    const content = `---
id: t_abc12345
title: No priority
status: inbox
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
---`;
    const task = parseTask(content);
    expect(task.priority).toBe("medium");
  });

  test("defaults tags to empty array when missing", () => {
    const content = `---
id: t_abc12345
title: No tags
status: inbox
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
---`;
    const task = parseTask(content);
    expect(task.tags).toEqual([]);
  });

  test("throws on missing required field (id)", () => {
    const content = `---
title: No ID
status: inbox
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
---`;
    expect(() => parseTask(content)).toThrow();
  });

  test("throws on invalid status", () => {
    const content = `---
id: t_abc12345
title: Bad status
status: yolo
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
---`;
    expect(() => parseTask(content)).toThrow();
  });

  test("throws on invalid priority", () => {
    const content = `---
id: t_abc12345
title: Bad priority
status: inbox
priority: super
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
---`;
    expect(() => parseTask(content)).toThrow();
  });

  test("handles empty body", () => {
    const content = `---
id: t_abc12345
title: Empty body
status: inbox
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
---`;
    const task = parseTask(content);
    expect(task.body).toBe("");
  });
});

describe("serializeTask / parseTask round-trip", () => {
  const task: Task = {
    id: "t_abc12345",
    title: "Test task",
    status: "active",
    priority: "high",
    tags: ["backend", "urgent"],
    project: "alpha",
    created: "2026-01-15T10:00:00Z",
    updated: "2026-01-15T12:00:00Z",
    due: "2026-02-01",
    assignee: "agent-1",
    depends_on: ["t_dep00001"],
    blocks: ["t_blk00001"],
    body: "This is the task body.\n\n## Log\n\n- [2026-01-15 10:00] Created",
  };

  test("serialize then parse produces same task", () => {
    const serialized = serializeTask(task);
    const parsed = parseTask(serialized);
    expect(parsed).toEqual(task);
  });

  test("omits optional fields when empty", () => {
    const minimal: Task = {
      id: "t_min00001",
      title: "Minimal",
      status: "inbox",
      priority: "medium",
      tags: [],
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      body: "",
    };
    const serialized = serializeTask(minimal);
    expect(serialized).not.toContain("project:");
    expect(serialized).not.toContain("due:");
    expect(serialized).not.toContain("assignee:");
    expect(serialized).not.toContain("depends_on:");
    expect(serialized).not.toContain("blocks:");
  });

  test("serialized output is valid YAML frontmatter", () => {
    const serialized = serializeTask(task);
    expect(serialized).toMatch(/^---\n/);
    expect(serialized).toContain("\n---\n");
  });
});

describe("resolveTaskPath", () => {
  const dir = "/data/tasks";
  const date = new Date("2026-03-15");

  test("inbox uses flat directory", () => {
    expect(resolveTaskPath(dir, "inbox", "my-task", date)).toBe("/data/tasks/inbox/my-task.md");
  });

  test("active uses flat directory", () => {
    expect(resolveTaskPath(dir, "active", "my-task", date)).toBe("/data/tasks/active/my-task.md");
  });

  test("waiting uses flat directory", () => {
    expect(resolveTaskPath(dir, "waiting", "my-task", date)).toBe("/data/tasks/waiting/my-task.md");
  });

  test("done uses YYYY-MM subdirectory", () => {
    expect(resolveTaskPath(dir, "done", "my-task", date)).toBe("/data/tasks/done/2026-03/my-task.md");
  });

  test("archived uses YYYY-MM subdirectory", () => {
    expect(resolveTaskPath(dir, "archived", "my-task", date)).toBe("/data/tasks/archived/2026-03/my-task.md");
  });
});
