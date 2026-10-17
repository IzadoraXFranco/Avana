// Contrato de domínio único, consumido pela Web e pelo Android.
export type ActiveSection = "backlog" | "hold" | "today";
export type Section = ActiveSection | "doneToday" | "done";
export type Priority = "" | "low" | "medium" | "high";
export interface Project {
  id: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  favorite: boolean;
  archivedAt: string | null;
  deletedAt: string | null;
  requireEvidence: boolean;
  createdAt: string;
}
export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  section: ActiveSection | null;
  completionId: string | null;
  completedAt: string | null;
  position: number;
  executionOrder: number | null;
  assignee: string;
  priority: Priority;
  plannedDate: string | null;
  dueDate: string | null;
  dueTime: string | null;
  dueTimezone: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
  subtaskCount: number;
  subtaskDone: number;
  commentCount: number;
  followUpDate: string | null;
  holdReason: string;
  waitingFor: string;
  holdSince: string | null;
  nextAction: string;
}
export interface Subtask {
  id: string;
  taskId: string;
  title: string;
  completedAt: string | null;
  assignee: string;
  dueDate: string | null;
  position: number;
}
export interface Comment {
  id: string;
  taskId: string;
  body: string;
  kind: "comment" | "evidence";
  completionId: string | null;
  createdAt: string;
  author: string;
}
export interface Activity {
  id: string;
  taskId: string;
  type: string;
  summary: string;
  before: unknown;
  after: unknown;
  createdAt: string;
  author: string;
}
export interface HoldEpisode {
  id: string;
  taskId: string;
  reason: string;
  waitingFor: string;
  nextAction: string;
  startedAt: string;
  endedAt: string | null;
}
export interface FollowUp {
  id: string;
  taskId: string;
  date: string;
  status: "pending" | "done" | "cancelled";
  note: string;
  createdAt: string;
  closedAt: string | null;
}
export interface Completion {
  id: string;
  taskId: string;
  completedAt: string;
  author: string;
}
export interface TaskDetail {
  task: Task;
  subtasks: Subtask[];
  comments: Comment[];
  activity: Activity[];
  holds: HoldEpisode[];
  followUps: FollowUp[];
  completions: Completion[];
}
export interface Settings {
  name: string;
  timezone: string;
  theme: "light" | "dark" | "system";
  backupDirectory?: string;
  [key: string]: unknown;
}
export interface Bootstrap {
  workspaceId?: string;
  revision?: number;
  projects: Project[];
  tasks: Task[];
  settings: Settings;
  today: string;
  serverTime: string;
}
export type TaskCommand = { action: string; [key: string]: unknown };
