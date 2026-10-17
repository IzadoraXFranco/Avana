import type { Task, TaskDetail, Subtask } from "../../shared/types.ts";
export type MainFields = {
  title: string;
  description: string;
  assignee: string;
  priority: Task["priority"];
  executionOrder: string;
  plannedDate: string;
  dueDate: string;
  dueTime: string;
  projectId: string;
};
export type HoldFields = {
  reason: string;
  waitingFor: string;
  nextAction: string;
  followUpDate: string;
};
export type SubFields = { title: string; assignee: string; dueDate: string };
export type Draft = {
  version: number;
  pendingReview: string[];
  base: MainFields;
  fields: MainFields;
  hold: HoldFields;
  sub: Record<string, SubFields>;
  subBase: Record<string, SubFields>;
  newSubtask: string;
  comment: string;
  commentKind: "comment" | "evidence";
  completionNote: string;
  completionLink: string;
  followNote: string;
  nextFollow: string;
};

// Local storage is untrusted input. Reject an unknown shape before the screen
// enables autosave so the original serialized content remains recoverable.
export function parseDraft(raw: string): Draft {
  const invalid = () =>
    new Error(
      "O rascunho tem um formato desconhecido. Ele permanece guardado neste dispositivo.",
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  const record = (value: unknown): value is Record<string, unknown> =>
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
  const strings = (value: unknown, keys: readonly string[]): boolean =>
    record(value) &&
    Object.keys(value).length === keys.length &&
    keys.every(
      (key) => Object.hasOwn(value, key) && typeof value[key] === "string",
    );
  const mainKeys = [
    "title",
    "description",
    "assignee",
    "priority",
    "executionOrder",
    "plannedDate",
    "dueDate",
    "dueTime",
    "projectId",
  ];
  const main = (value: unknown): boolean =>
    strings(value, mainKeys) &&
    record(value) &&
    ["", "low", "medium", "high"].includes(value.priority as string);
  const subtasks = (value: unknown): boolean =>
    record(value) &&
    Object.entries(value).every(
      ([id, fields]) =>
        id.length > 0 &&
        !["__proto__", "prototype", "constructor"].includes(id) &&
        strings(fields, ["title", "assignee", "dueDate"]),
    );
  const textKeys = [
    "newSubtask",
    "comment",
    "completionNote",
    "completionLink",
    "followNote",
    "nextFollow",
  ];
  const keys = [
    "version",
    "base",
    "fields",
    "hold",
    "sub",
    "subBase",
    "commentKind",
    ...textKeys,
  ];
  if (
    !record(parsed) ||
    !keys.every((key) => Object.hasOwn(parsed, key)) ||
    Object.keys(parsed).some(
      (key) => key !== "pendingReview" && !keys.includes(key),
    ) ||
    !Number.isSafeInteger(parsed.version) ||
    (parsed.version as number) < 1 ||
    !main(parsed.fields) ||
    !main(parsed.base) ||
    !strings(parsed.hold, [
      "reason",
      "waitingFor",
      "nextAction",
      "followUpDate",
    ]) ||
    !subtasks(parsed.sub) ||
    !subtasks(parsed.subBase) ||
    !textKeys.every((key) => typeof parsed[key] === "string") ||
    !["comment", "evidence"].includes(parsed.commentKind as string) ||
    (Object.hasOwn(parsed, "pendingReview") &&
      (!Array.isArray(parsed.pendingReview) ||
        parsed.pendingReview.some((item) => typeof item !== "string")))
  )
    throw invalid();
  return { ...parsed, pendingReview: parsed.pendingReview ?? [] } as Draft;
}

export const fieldLabels: Record<keyof MainFields, string> = {
  title: "Nome",
  description: "Descrição",
  assignee: "Responsável",
  priority: "Prioridade",
  executionOrder: "Ordem de execução",
  plannedDate: "Data planejada",
  dueDate: "Prazo",
  dueTime: "Horário",
  projectId: "Projeto",
};
export function mainOf(t: Task): MainFields {
  return {
    title: t.title,
    description: t.description,
    assignee: t.assignee,
    priority: t.priority,
    executionOrder: t.executionOrder?.toString() || "",
    plannedDate: t.plannedDate || "",
    dueDate: t.dueDate || "",
    dueTime: t.dueTime || "",
    projectId: t.projectId,
  };
}
export function holdOf(t: Task): HoldFields {
  return {
    reason: t.holdReason,
    waitingFor: t.waitingFor,
    nextAction: t.nextAction,
    followUpDate: t.followUpDate || "",
  };
}
export function subOf(t: Subtask): SubFields {
  return { title: t.title, assignee: t.assignee, dueDate: t.dueDate || "" };
}
export function initialDraft(detail: TaskDetail): Draft {
  const fields = mainOf(detail.task),
    sub = Object.fromEntries(detail.subtasks.map((t) => [t.id, subOf(t)]));
  return {
    version: detail.task.version,
    pendingReview: [],
    base: fields,
    fields,
    hold: holdOf(detail.task),
    sub,
    subBase: sub,
    newSubtask: "",
    comment: "",
    commentKind: "comment",
    completionNote: "",
    completionLink: "",
    followNote: "",
    nextFollow: "",
  };
}
export function dirtyMain(draft: Draft) {
  return (Object.keys(draft.fields) as (keyof MainFields)[]).filter(
    (key) => draft.fields[key] !== draft.base[key],
  );
}
export function hasText(draft: Draft) {
  return (
    dirtyMain(draft).length > 0 ||
    !!(
      draft.newSubtask ||
      draft.comment ||
      draft.completionNote ||
      draft.completionLink ||
      draft.followNote ||
      draft.nextFollow
    ) ||
    JSON.stringify(draft.sub) !== JSON.stringify(draft.subBase)
  );
}
export function reconcile(
  draft: Draft,
  old: TaskDetail | null,
  next: TaskDetail,
): { draft: Draft; conflicts: string[] } {
  const fresh = mainOf(next.task),
    fields = { ...fresh },
    conflicts: string[] = [...(draft.pendingReview || [])];
  for (const key of Object.keys(fresh) as (keyof MainFields)[]) {
    if (draft.fields[key] !== draft.base[key]) {
      (fields[key] as string) = draft.fields[key];
      if (fresh[key] !== draft.base[key] && fresh[key] !== draft.fields[key])
        conflicts.push(fieldLabels[key]);
    }
  }
  const sub = { ...draft.sub },
    subBase = { ...draft.subBase };
  for (const item of next.subtasks) {
    const latest = subOf(item),
      previous = subBase[item.id],
      typed = sub[item.id] ? { ...sub[item.id] } : undefined;
    if (!previous || !typed) {
      sub[item.id] = latest;
      subBase[item.id] = latest;
      continue;
    }
    for (const key of Object.keys(latest) as (keyof SubFields)[]) {
      if (typed[key] === previous[key]) typed[key] = latest[key];
      else if (latest[key] !== previous[key] && latest[key] !== typed[key])
        conflicts.push(`Subtarefa: ${item.title}`);
    }
    sub[item.id] = typed;
    subBase[item.id] = latest;
  }
  for (const id of Object.keys(sub))
    if (
      !next.subtasks.some((t) => t.id === id) &&
      JSON.stringify(sub[id]) === JSON.stringify(subBase[id])
    ) {
      delete sub[id];
      delete subBase[id];
    }
  // Deleted subtasks with edited text remain as recoverable orphan drafts.
  let hold = draft.hold;
  if (old && JSON.stringify(hold) === JSON.stringify(holdOf(old.task)))
    hold = holdOf(next.task);
  else if (
    old &&
    JSON.stringify(holdOf(old.task)) !== JSON.stringify(holdOf(next.task)) &&
    JSON.stringify(hold) !== JSON.stringify(holdOf(next.task))
  )
    conflicts.push("Bloqueio e follow-up");
  return {
    draft: {
      ...draft,
      version: next.task.version,
      pendingReview: [...new Set(conflicts)],
      base: fresh,
      fields,
      sub,
      subBase,
      hold,
    },
    conflicts: [...new Set(conflicts)],
  };
}
