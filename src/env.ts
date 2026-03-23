import { z } from "zod/v4";

const envSchema = z.object({
  TASKS_DIR: z.string().min(1),
  API_KEY: z.string().min(1),
  TASKS_REPO_URL: z.string().optional(),
  GIT_TOKEN: z.string().optional(),
  GIT_USER_NAME: z.string().min(1),
  GIT_USER_EMAIL: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(8181),
  SERVER_URL: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  return envSchema.parse({
    TASKS_DIR: process.env.TASKS_DIR,
    API_KEY: process.env.API_KEY,
    TASKS_REPO_URL: process.env.TASKS_REPO_URL,
    GIT_TOKEN: process.env.GIT_TOKEN,
    GIT_USER_NAME: process.env.GIT_USER_NAME,
    GIT_USER_EMAIL: process.env.GIT_USER_EMAIL,
    PORT: process.env.PORT ?? 8181,
    SERVER_URL: process.env.SERVER_URL,
  });
}

export function resolveRepoUrl(repoUrl: string, token?: string): string {
  if (!token) return repoUrl;
  try {
    const url = new URL(repoUrl);
    url.username = token;
    url.password = "";
    return url.toString();
  } catch {
    return repoUrl;
  }
}
