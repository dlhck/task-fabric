import { test, expect, describe, spyOn } from "bun:test";
import { loadEnv, resolveRepoUrl, buildIssuerUrl, type Env } from "../env.ts";

const VALID_KEY = "0123456789abcdef0123456789abcdef"; // exactly 32 chars

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const keys = [
    "TASKS_DIR", "API_KEY", "GIT_USER_NAME", "GIT_USER_EMAIL",
    "PORT", "SERVER_URL", "ALLOW_INSECURE_HTTP", "TRUST_PROXY_HOPS",
    "TASKS_REPO_URL", "GIT_TOKEN",
    ...Object.keys(vars),
  ];
  const originals: Record<string, string | undefined> = {};
  for (const key of keys) originals[key] = process.env[key];
  try {
    // Clear all relevant keys so undefined overrides actually clear
    for (const key of keys) delete process.env[key];
    for (const [key, val] of Object.entries(vars)) {
      if (val !== undefined) process.env[key] = val;
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
  API_KEY: VALID_KEY,
  GIT_USER_NAME: "Test User",
  GIT_USER_EMAIL: "test@example.com",
};

function mkEnv(overrides: Partial<Env> = {}): Env {
  return {
    TASKS_DIR: "/data/tasks",
    API_KEY: VALID_KEY,
    GIT_USER_NAME: "Test User",
    GIT_USER_EMAIL: "test@example.com",
    PORT: 8181,
    TRUST_PROXY_HOPS: 1,
    ...overrides,
  } as Env;
}

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
      expect(env.API_KEY).toBe(VALID_KEY);
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

  test("rejects API_KEY shorter than 32 characters with helpful error", () => {
    withEnv({ ...validEnv, API_KEY: "short" }, () => {
      expect(() => loadEnv()).toThrow(/at least 32 characters/);
      expect(() => loadEnv()).toThrow(/openssl rand -hex 32/);
    });
  });

  test("accepts API_KEY of exactly 32 characters", () => {
    withEnv({ ...validEnv, API_KEY: "a".repeat(32) }, () => {
      expect(() => loadEnv()).not.toThrow();
    });
  });

  test("TRUST_PROXY_HOPS defaults to 1", () => {
    withEnv({ ...validEnv }, () => {
      expect(loadEnv().TRUST_PROXY_HOPS).toBe(1);
    });
  });

  test("TRUST_PROXY_HOPS coerces string to integer", () => {
    withEnv({ ...validEnv, TRUST_PROXY_HOPS: "2" }, () => {
      expect(loadEnv().TRUST_PROXY_HOPS).toBe(2);
    });
  });

  test("TRUST_PROXY_HOPS rejects negative values", () => {
    withEnv({ ...validEnv, TRUST_PROXY_HOPS: "-1" }, () => {
      expect(() => loadEnv()).toThrow();
    });
  });

  test("TRUST_PROXY_HOPS rejects non-integer", () => {
    withEnv({ ...validEnv, TRUST_PROXY_HOPS: "1.5" }, () => {
      expect(() => loadEnv()).toThrow();
    });
  });
});

describe("buildIssuerUrl", () => {
  test("falls back to http://localhost:PORT when SERVER_URL is unset", () => {
    const url = buildIssuerUrl(mkEnv({ PORT: 9000 }));
    expect(url.toString()).toBe("http://localhost:9000/");
  });

  test("accepts https URL", () => {
    const url = buildIssuerUrl(mkEnv({ SERVER_URL: "https://tasks.example.com" }));
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("tasks.example.com");
  });

  test("accepts http://localhost", () => {
    const url = buildIssuerUrl(mkEnv({ SERVER_URL: "http://localhost:8181" }));
    expect(url.hostname).toBe("localhost");
  });

  test("accepts http://127.0.0.1", () => {
    const url = buildIssuerUrl(mkEnv({ SERVER_URL: "http://127.0.0.1:8181" }));
    expect(url.hostname).toBe("127.0.0.1");
  });

  test("accepts http://[::1]", () => {
    const url = buildIssuerUrl(mkEnv({ SERVER_URL: "http://[::1]:8181" }));
    expect(url.hostname).toBe("[::1]");
  });

  test("rejects http://non-localhost without escape hatch", () => {
    expect(() => buildIssuerUrl(mkEnv({ SERVER_URL: "http://tasks.example.com" })))
      .toThrow(/must use https/);
  });

  test("rejects http://192.168.x.x (no LAN exception)", () => {
    expect(() => buildIssuerUrl(mkEnv({ SERVER_URL: "http://192.168.1.100:8181" })))
      .toThrow(/must use https/);
  });

  test("error message points at ALLOW_INSECURE_HTTP escape hatch", () => {
    expect(() => buildIssuerUrl(mkEnv({ SERVER_URL: "http://tasks.example.com" })))
      .toThrow(/ALLOW_INSECURE_HTTP=1/);
  });

  test("ALLOW_INSECURE_HTTP=1 allows insecure URL and warns", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const url = buildIssuerUrl(mkEnv({
        SERVER_URL: "http://tasks.example.com",
        ALLOW_INSECURE_HTTP: "1",
      }));
      expect(url.hostname).toBe("tasks.example.com");
      expect(warn).toHaveBeenCalled();
      const msg = warn.mock.calls[0]?.[0] as string;
      expect(msg).toContain("not HTTPS");
    } finally {
      warn.mockRestore();
    }
  });

  test("ALLOW_INSECURE_HTTP with value other than '1' does not bypass", () => {
    expect(() => buildIssuerUrl(mkEnv({
      SERVER_URL: "http://tasks.example.com",
      ALLOW_INSECURE_HTTP: "true",
    }))).toThrow(/must use https/);
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
