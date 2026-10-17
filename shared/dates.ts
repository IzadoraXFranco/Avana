import type { Task, Section } from "./types.ts";
export const today = (timezone = "America/Sao_Paulo", now: Date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
export const formatDate = (date: string | null | undefined) =>
  date
    ? new Intl.DateTimeFormat("pt-BR", {
        day: "2-digit",
        month: "short",
        timeZone: "UTC",
      })
        .format(new Date(`${date}T12:00:00Z`))
        .replace(".", "")
    : "Sem data";
export const formatInstant = (
  timestamp: string,
  timezone = "America/Sao_Paulo",
) =>
  new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(timestamp));
export function sectionOf(
  task: Task,
  day: string,
  timezone = "America/Sao_Paulo",
): Section {
  return task.completedAt
    ? today(timezone, new Date(task.completedAt)) === day
      ? "doneToday"
      : "done"
    : task.section || "backlog";
}
export function isOverdue(
  task: Task,
  day: string,
  now: Date = new Date(),
): boolean {
  if (task.completedAt || !task.dueDate) return false;
  if (!task.dueTime) return task.dueDate < day;
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: task.dueTimezone || "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
  return parts.replace(" ", "T") > `${task.dueDate}T${task.dueTime}`;
}
export const sectionLabels: Record<Section, string> = {
  backlog: "Backlog",
  hold: "Hold",
  today: "In Progress (Do Today)",
  doneToday: "Done Today",
  done: "Done",
};
export const priorityLabels: Record<string, string> = {
  "": "Sem prioridade",
  low: "Baixa",
  medium: "Média",
  high: "Alta",
};
