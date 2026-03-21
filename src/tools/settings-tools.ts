import { readSettings, writeSettings } from "../settings.ts";
import { withGitSync, formatCommitMessage } from "../git.ts";
import type { AppContext } from "../context.ts";
import type { Settings } from "../types.ts";

export async function settingsGet(ctx: AppContext): Promise<Settings> {
  return readSettings(ctx.tasksDir);
}

export async function settingsUpdate(
  ctx: AppContext,
  params: Partial<Settings>,
): Promise<Settings> {
  const message = formatCommitMessage("settings", "Update settings");

  const result = await withGitSync(ctx.git, ctx.store, message, async () => {
    return writeSettings(ctx.tasksDir, params);
  });

  return result;
}
