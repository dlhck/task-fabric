import matter from "gray-matter";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { TaskStatus } from "./types.ts";
import { TASK_STATUSES } from "./types.ts";

export async function findFilesRecursive(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...await findFilesRecursive(full));
      else results.push(full);
    }
  } catch { /* dir doesn't exist */ }
  return results;
}

export async function findTaskFile(
  tasksDir: string,
  id: string,
): Promise<{ filePath: string; status: TaskStatus } | null> {
  for (const status of TASK_STATUSES) {
    const dir = path.join(tasksDir, status);
    const files = await findFilesRecursive(dir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      try {
        const content = await Bun.file(file).text();
        const { data } = matter(content);
        if (data.id === id) return { filePath: file, status };
      } catch { /* skip unreadable files */ }
    }
  }
  return null;
}
