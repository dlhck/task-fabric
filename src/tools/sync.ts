import { getHistory, getDiff, restoreFile } from "../git.ts";
import { reindex, embedAll } from "../store.ts";
import { withGitSync, formatCommitMessage } from "../git.ts";
import { findTaskFile } from "../task-finder.ts";
import type { AppContext } from "../context.ts";
import matter from "gray-matter";

export async function syncStatus(ctx: AppContext): Promise<{ lastCommit: string; isClean: boolean }> {
  const log = await ctx.git.log({ maxCount: 1 });
  const status = await ctx.git.status();
  return {
    lastCommit: log.latest ? `${log.latest.date} ${log.latest.message}` : "no commits",
    isClean: status.isClean(),
  };
}

export async function syncPull(ctx: AppContext): Promise<{ message: string }> {
  try {
    const remotes = await ctx.git.getRemotes();
    if (remotes.length > 0) {
      await ctx.git.pull({ "--rebase": null });
    }
    await reindex(ctx.store);
    try { await embedAll(ctx.store); } catch { /* models may not be available */ }
    return { message: "Pull, re-index, and embed complete" };
  } catch (err) {
    return { message: `Pull failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function syncHistory(
  ctx: AppContext,
  params: { limit?: number },
): Promise<string[]> {
  return getHistory(ctx.git, params.limit ?? 20);
}

export async function syncDiff(
  ctx: AppContext,
  params: { since?: string },
): Promise<string> {
  return getDiff(ctx.git, params.since);
}

export async function syncRestore(
  ctx: AppContext,
  params: { id: string; commit: string },
): Promise<{ message: string }> {
  // Find the specific file for this task ID by grepping the commit's files
  const diffOutput = await ctx.git.show([params.commit, "--name-only", "--pretty=format:"]);
  const files = diffOutput.trim().split("\n").filter((f) => f.endsWith(".md"));

  if (files.length === 0) {
    return { message: `No markdown files found in commit ${params.commit}` };
  }

  // Find which file belongs to this task ID by checking content at that commit
  let targetFile: string | null = null;
  for (const file of files) {
    try {
      const content = await ctx.git.show([`${params.commit}:${file}`]);
      const { data } = matter(content);
      if (data.id === params.id) {
        targetFile = file;
        break;
      }
    } catch { /* file may not exist at that commit */ }
  }

  if (!targetFile) {
    return { message: `Task ${params.id} not found in commit ${params.commit}` };
  }

  const message = formatCommitMessage("restore", `Restore from ${params.commit.slice(0, 7)}`, params.id);

  await withGitSync(ctx.git, ctx.store, message, async () => {
    await restoreFile(ctx.git, params.commit, targetFile);
  });

  return { message: `Restored ${targetFile} from ${params.commit.slice(0, 7)}` };
}
