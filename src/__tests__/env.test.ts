import { test, expect, describe } from "bun:test";
import { loadEnv, resolveRepoUrl } from "../env.ts";

describe("loadEnv", () => {
  test("throws when TASKS_DIR is missing", () => {
    const orig = process.env.TASKS_DIR;
    delete process.env.TASKS_DIR;
    try {
      expect(() => loadEnv()).toThrow();
    } finally {
      if (orig) process.env.TASKS_DIR = orig;
    }
  });

  test("throws when API_KEY is missing", () => {
    const origDir = process.env.TASKS_DIR;
    const origKey = process.env.API_KEY;
    process.env.TASKS_DIR = "/tmp/test";
    delete process.env.API_KEY;
    try {
      expect(() => loadEnv()).toThrow();
    } finally {
      if (origDir) process.env.TASKS_DIR = origDir;
      else delete process.env.TASKS_DIR;
      if (origKey) process.env.API_KEY = origKey;
      else delete process.env.API_KEY;
    }
  });

  test("parses valid env vars correctly", () => {
    const origDir = process.env.TASKS_DIR;
    const origKey = process.env.API_KEY;
    const origPort = process.env.PORT;
    const origRepo = process.env.TASKS_REPO_URL;
    process.env.TASKS_DIR = "/data/tasks";
    process.env.API_KEY = "my-secret";
    process.env.PORT = "9090";
    process.env.TASKS_REPO_URL = "https://github.com/test/repo.git";
    try {
      const env = loadEnv();
      expect(env.TASKS_DIR).toBe("/data/tasks");
      expect(env.API_KEY).toBe("my-secret");
      expect(env.PORT).toBe(9090);
      expect(env.TASKS_REPO_URL).toBe("https://github.com/test/repo.git");
    } finally {
      if (origDir) process.env.TASKS_DIR = origDir;
      else delete process.env.TASKS_DIR;
      if (origKey) process.env.API_KEY = origKey;
      else delete process.env.API_KEY;
      if (origPort) process.env.PORT = origPort;
      else delete process.env.PORT;
      if (origRepo) process.env.TASKS_REPO_URL = origRepo;
      else delete process.env.TASKS_REPO_URL;
    }
  });

  test("applies default PORT of 8181", () => {
    const origDir = process.env.TASKS_DIR;
    const origKey = process.env.API_KEY;
    const origPort = process.env.PORT;
    process.env.TASKS_DIR = "/tmp/test";
    process.env.API_KEY = "test-key";
    delete process.env.PORT;
    try {
      const env = loadEnv();
      expect(env.PORT).toBe(8181);
    } finally {
      if (origDir) process.env.TASKS_DIR = origDir;
      else delete process.env.TASKS_DIR;
      if (origKey) process.env.API_KEY = origKey;
      else delete process.env.API_KEY;
      if (origPort) process.env.PORT = origPort;
      else delete process.env.PORT;
    }
  });
});

describe("resolveRepoUrl", () => {
  test("injects token into HTTPS URL", () => {
    const result = resolveRepoUrl("https://github.com/user/repo.git", "ghp_abc123");
    expect(result).toBe("https://ghp_abc123@github.com/user/repo.git");
  });

  test("returns URL unchanged when no token", () => {
    const url = "https://github.com/user/repo.git";
    expect(resolveRepoUrl(url)).toBe(url);
    expect(resolveRepoUrl(url, undefined)).toBe(url);
  });

  test("returns non-URL strings unchanged when token provided", () => {
    expect(resolveRepoUrl("git@github.com:user/repo.git", "token")).toBe("git@github.com:user/repo.git");
  });
});
