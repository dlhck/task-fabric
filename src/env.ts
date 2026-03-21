import { z } from "zod/v4";

const envSchema = z.object({
  TASKS_DIR: z.string().min(1),
  API_KEY: z.string().min(1),
  TASKS_REPO_URL: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(8181),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  return envSchema.parse({
    TASKS_DIR: process.env.TASKS_DIR,
    API_KEY: process.env.API_KEY,
    TASKS_REPO_URL: process.env.TASKS_REPO_URL,
    PORT: process.env.PORT ?? 8181,
  });
}
