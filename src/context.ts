import type { SimpleGit } from "simple-git";
import type { Store } from "./store.ts";
import type { Settings } from "./types.ts";

export interface AppContext {
  tasksDir: string;
  store: Store;
  git: SimpleGit;
  getSettings: () => Promise<Settings>;
}
