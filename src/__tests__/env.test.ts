import { test, expect, describe } from "bun:test";
import { loadEnv, resolveRepoUrl } from "../env.ts";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    originals[key] = process.env[key];
  }
  try {
    for (const [key, val] of Object.entries(vars)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    fn();
  } finally {
    for (const [key, val] of Object.entries(originals)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }
}

const validEnv = {
  TASKS_DIR: "/data/tasks",
  API_KEY: "my-secret",
  GIT_USER_NAME: "Test User",
  GIT_USER_EMAIL: "test@example.com",
};

describe("loadEnv", () => {
  test("throws when TASKS_DIR is missing", () => {
    withEnv({ ...validEnv, TASKS_DIR: undefined }, () => {
      expect(() => loadEnv()).toThrow();
    });
  });

  test("throws when API_KEY is missing", () => {
    withEnv({ ...validEnv, API_KEY: undefined }, () => {
      expect(() => loadEnv()).toThrow();
    });
  });

  test("throws when GIT_USER_NAME is missing", () => {
    withEnv({ ...validEnv, GIT_USER_NAME: undefined }, () => {
      expect(() => loadEnv()).toThrow();
    });
  });

  test("throws when GIT_USER_EMAIL is missing", () => {
    withEnv({ ...validEnv, GIT_USER_EMAIL: undefined }, () => {
      expect(() => loadEnv()).toThrow();
    });
  });

  test("parses valid env vars correctly", () => {
    withEnv({ ...validEnv, PORT: "9090", TASKS_REPO_URL: "https://github.com/test/repo.git" }, () => {
      const env = loadEnv();
      expect(env.TASKS_DIR).toBe("/data/tasks");
      expect(env.API_KEY).toBe("my-secret");
      expect(env.GIT_USER_NAME).toBe("Test User");
      expect(env.GIT_USER_EMAIL).toBe("test@example.com");
      expect(env.PORT).toBe(9090);
      expect(env.TASKS_REPO_URL).toBe("https://github.com/test/repo.git");
    });
  });

  test("applies default PORT of 8181", () => {
    withEnv({ ...validEnv, PORT: undefined }, () => {
      const env = loadEnv();
      expect(env.PORT).toBe(8181);
    });
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
