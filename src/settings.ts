import { z } from "zod/v4";
import { parse, stringify } from "yaml";
import type { Settings } from "./types.ts";
import { PRIORITIES } from "./types.ts";

export const DEFAULTS: Settings = {
  due_soon_days: 3,
  auto_archive_after_days: 30,
  default_priority: "medium",
  default_assignee: "",
};

const settingsSchema = z.object({
  due_soon_days: z.number().int().min(1).optional(),
  auto_archive_after_days: z.number().int().min(1).optional(),
  default_priority: z.enum(PRIORITIES).optional(),
  default_assignee: z.string().optional(),
});

export function validateSettings(input: unknown): Partial<Settings> {
  return settingsSchema.parse(input);
}

export async function readSettings(tasksDir: string): Promise<Settings> {
  const path = `${tasksDir}/settings.yml`;
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { ...DEFAULTS };
  }
  const content = await file.text();
  const data = parse(content) ?? {};
  const validated = validateSettings(data);
  return { ...DEFAULTS, ...validated };
}

export async function writeSettings(tasksDir: string, partial: Partial<Settings>): Promise<Settings> {
  const validated = validateSettings(partial);
  const current = await readSettings(tasksDir);
  const merged = { ...current, ...validated };
  const path = `${tasksDir}/settings.yml`;
  await Bun.write(path, stringify(merged));
  return merged;
}
