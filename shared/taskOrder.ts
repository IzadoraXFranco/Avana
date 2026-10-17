import type { Section, Task } from "./types.ts";

export type TaskSort =
  | "manual"
  | "execution"
  | "executionDesc"
  | "priority"
  | "due"
  | "completion"
  | "completionAsc";
export const sortLabels: Record<TaskSort, string> = {
  manual: "Ordem manual",
  execution: "Ordem de execução: 1º → último",
  executionDesc: "Ordem de execução: último → 1º",
  priority: "Prioridade: Alta → Baixa",
  due: "Prazo: mais próximo",
  completion: "Conclusão: mais recente",
  completionAsc: "Conclusão: mais antiga",
};

export function sortTasks(
  tasks: Task[],
  sort: TaskSort,
  section: Section,
): Task[] {
  const manual = (a: Task, b: Task) =>
    a.position - b.position ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id);
  return [...tasks].sort((a, b) => {
    if (sort === "execution" || sort === "executionDesc") {
      if (a.executionOrder == null && b.executionOrder != null) return 1;
      if (b.executionOrder == null && a.executionOrder != null) return -1;
      return (
        ((a.executionOrder ?? 0) - (b.executionOrder ?? 0)) *
          (sort === "executionDesc" ? -1 : 1) || manual(a, b)
      );
    }
    if (
      sort === "completion" ||
      sort === "completionAsc" ||
      (sort === "manual" && ["done", "doneToday"].includes(section))
    ) {
      if (!a.completedAt && b.completedAt) return 1;
      if (!b.completedAt && a.completedAt) return -1;
      return (
        (a.completedAt || "").localeCompare(b.completedAt || "") *
          (sort === "completionAsc" ? 1 : -1) || manual(a, b)
      );
    }
    if (sort === "priority") {
      const ranks = { high: 0, medium: 1, low: 2, "": 3 };
      return ranks[a.priority] - ranks[b.priority] || manual(a, b);
    }
    if (sort === "due")
      return (
        (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || manual(a, b)
      );
    return manual(a, b);
  });
}
