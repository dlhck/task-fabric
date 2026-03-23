export const TASK_STATUSES = ["inbox", "active", "waiting", "done", "archived"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const DATED_STATUSES: TaskStatus[] = ["done", "archived"];

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: Priority;
  tags: string[];
  project?: string;
  created: string;
  updated: string;
  completed_at?: string;
  due?: string;
  assignee?: string;
  waiting_on?: string;
  depends_on?: string[];
  blocks?: string[];
  body: string;
}

export interface Settings {
  due_soon_days: number;
  auto_archive_after_days: number;
  default_priority: Priority;
  default_assignee: string;
  timezone: string;
}
