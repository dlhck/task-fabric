import simpleGit, { type SimpleGit } from "simple-git";
import { reindex, embedAll, type Store } from "./store.ts";

export async function initGit(repoPath: string): Promise<SimpleGit> {
  const git = simpleGit(repoPath);
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    await git.init(["-b", "main"]);
  }
  return git;
}

export function formatCommitMessage(verb: string, description: string, id?: string): string {
  const idSuffix = id ? ` [${id}]` : "";
  return `task(${verb}): ${description}${idSuffix}`;
}

export async function withGitSync<T>(
  git: SimpleGit,
  store: Store,
  message: string,
  fn: () => Promise<T>,
): Promise<T> {
  const result = await fn();

  await reindex(store);

  // Incrementally embed new/changed documents (only processes documents without embeddings)
  try {
    await embedAll(store);
  } catch {
    // Models may not be available — keyword search still works
  }

  await git.add(".");
  await git.commit(message);

  try {
    const remotes = await git.getRemotes();
    if (remotes.length > 0) {
      const branch = (await git.branchLocal()).current;
      // Pull first, but handle conflicts
      try {
        await git.pull("origin", branch, { "--rebase": null });
      } catch (pullErr) {
        // If rebase failed with conflicts, abort and try regular merge
        try {
          await git.rebase(["--abort"]);
        } catch { /* may not be in rebase state */ }
        try {
          await git.pull("origin", branch);
        } catch {
          // Remote branch doesn't exist yet or offline — push will create it
        }
      }
      await git.push("origin", branch, { "-u": null });
    }
  } catch (err) {
    throw new Error(`Git push failed after commit: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

export async function getHistory(git: SimpleGit, maxCount = 20): Promise<string[]> {
  const log = await git.log({ maxCount });
  return log.all.map((entry) => `${entry.date} ${entry.hash.slice(0, 7)} ${entry.message}`);
}

export async function getDiff(git: SimpleGit, since?: string): Promise<string> {
  if (since) {
    return git.diff([`${since}..HEAD`]);
  }
  return git.diff(["HEAD~1", "HEAD"]);
}

export async function restoreFile(git: SimpleGit, commitSha: string, filePath: string): Promise<void> {
  await git.checkout([commitSha, "--", filePath]);
}
