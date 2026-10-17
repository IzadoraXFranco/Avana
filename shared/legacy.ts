import type { Priority } from "./types.ts";

export interface TaskDraft {
  main: { title: string; description: string; assignee: string; priority: Priority; executionOrder: string; plannedDate: string; dueDate: string; dueTime: string; projectId: string };
  hold: { reason: string; waitingFor: string; nextAction: string; followUpDate: string };
  subtasks: Record<string, { title: string; assignee: string; dueDate: string }>;
  comment: string;
  commentKind: "comment" | "evidence";
  completionNote: string;
  completionLink: string;
  followupNote: string;
  nextFollowup: string;
  newSubtask: string;
}
export interface TaskDraftRecord { version: number; base: TaskDraft; draft: TaskDraft }
export interface ExecutionOrderDraft { text: string; base: number | null; revision: string }
export interface PortableExport { format: "avana"; version: 1; exportedAt: string; data: Record<string, unknown[]> }
export interface LegacyInspection {
  draftCount: number;
  preferenceCount: number;
  exports: Array<{ key: string; data: PortableExport }>;
  unknown: Array<{ key: string; reason: string }>;
}
const preferences = new Set(["avana.project", "avana.sidebar", "avana.columns", "avana.collapsed", "avana.theme", "avana.sort"]);
const copiedPreferences = new Set(["avana.project", "avana.sidebar", "avana.columns", "avana.collapsed"]);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const identifier = (value: string) => /^[A-Za-z0-9_-]{1,200}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const textFields = (value: Record<string, unknown>, keys: readonly string[]) => keys.every(key => typeof value[key] === "string");
const mainText = ["title", "description", "assignee", "plannedDate", "dueDate", "dueTime", "projectId"] as const;
const holdText = ["reason", "waitingFor", "nextAction", "followUpDate"] as const;
const draftText = ["comment", "completionNote", "completionLink", "followupNote", "nextFollowup", "newSubtask"] as const;
const subText = ["title", "assignee", "dueDate"] as const;

function parseJSON(raw: string | null): unknown {
  try { return raw === null ? null : JSON.parse(raw); } catch { return null; }
}
function normalizeDraft(value: unknown): TaskDraft | null {
  if (!record(value) || !onlyKeys(value, ["main", "hold", "subtasks", "commentKind", ...draftText]) || !textFields(value, draftText) ||
      !["comment", "evidence"].includes(value.commentKind as string) || !record(value.main) || !record(value.hold) || !record(value.subtasks)) return null;
  const main = value.main, hold = value.hold;
  if (!onlyKeys(main, [...mainText, "priority", "executionOrder"]) || !textFields(main, mainText) ||
      !["", "low", "medium", "high", "urgent"].includes(main.priority as string) ||
      (main.executionOrder !== undefined && typeof main.executionOrder !== "string") ||
      !onlyKeys(hold, holdText) || !textFields(hold, holdText)) return null;
  for (const [id, subtask] of Object.entries(value.subtasks))
    if (!identifier(id) || !record(subtask) || !onlyKeys(subtask, subText) || !textFields(subtask, subText)) return null;
  // Text still being edited remains recoverable. Objects/numbers are never coerced to text.
  // Known migrations leave the original recovery package unchanged.
  return {
    ...value,
    main: { ...main, priority: main.priority === "urgent" ? "high" : main.priority, executionOrder: main.executionOrder ?? "" },
    hold: { ...hold },
    subtasks: Object.fromEntries(Object.entries(value.subtasks).map(([id, subtask]) => [id, { ...(subtask as Record<string, string>) }])),
  } as TaskDraft;
}
export function parseTaskDraftRecord(raw: string | null): TaskDraftRecord | null {
  const value = parseJSON(raw);
  if (!record(value) || !onlyKeys(value, ["version", "base", "draft"]) || !Number.isSafeInteger(value.version) || (value.version as number) < 1) return null;
  const base = normalizeDraft(value.base), draft = normalizeDraft(value.draft);
  return base && draft ? { version: value.version as number, base, draft } : null;
}
export function parseExecutionOrderDraft(raw: string | null): ExecutionOrderDraft | null {
  const value = parseJSON(raw);
  if (!record(value) || !onlyKeys(value, ["text", "base", "revision"]) || typeof value.text !== "string" ||
      typeof value.revision !== "string" || !value.revision.trim() || value.revision.length > 200 ||
      !(value.base === null || (Number.isSafeInteger(value.base) && (value.base as number) >= 1 && (value.base as number) <= 99999))) return null;
  return { text: value.text, base: value.base as number | null, revision: value.revision };
}

const exportTables = ["workspaces", "users", "memberships", "settings", "projects", "tasks", "completions", "subtasks", "comments", "activity", "holds", "followUps", "commands", "requests"];
export function isPortableExport(value: unknown): value is PortableExport {
  if (!record(value) || value.format !== "avana" || value.version !== 1 || typeof value.exportedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T/.test(value.exportedAt) || !Number.isFinite(Date.parse(value.exportedAt)) || !record(value.data)) return false;
  const data = value.data;
  if (!exportTables.every(table => Array.isArray(data[table]) && (data[table] as unknown[]).every(record))) return false;
  return ["workspaces", "users", "memberships", "settings"].every(table => (data[table] as unknown[]).length === 1);
}

function validPreference(key: string, value: unknown): boolean {
  if (key === "avana.project") return typeof value === "string";
  if (key === "avana.sidebar") return typeof value === "boolean";
  if (key === "avana.columns" || key === "avana.collapsed") return record(value) && Object.keys(value).every(identifier) && Object.values(value).every(item => typeof item === "boolean");
  if (key === "avana.theme") return ["light", "dark", "system"].includes(value as string);
  if (key === "avana.sort") return ["manual", "execution", "executionDesc", "priority", "due", "completion", "completionAsc"].includes(value as string);
  return false;
}
type InspectedEntry =
  | { kind: "draft"; value: string; taskId: string }
  | { kind: "preference"; value: string }
  | { kind: "export"; data: PortableExport }
  | { kind: "unknown"; reason: string }
  | { kind: "ignored" };
function inspectEntry(key: string, raw: string): InspectedEntry {
  if (/^avana:(pending-requests|migration-browser|scope):/.test(key)) return { kind: "ignored" };
  const draftKey = /^avana:(task-draft|execution-order-draft):(.*)$/.exec(key);
  if (draftKey) {
    const valid = draftKey[1] === "task-draft" ? parseTaskDraftRecord(raw) : parseExecutionOrderDraft(raw);
    return valid && identifier(draftKey[2]) ? { kind: "draft", value: JSON.stringify(valid), taskId: draftKey[2] }
      : { kind: "unknown", reason: "Rascunho com estrutura desconhecida ou campos inválidos. Mantido no pacote original, sem copiar nem publicar." };
  }
  const data = parseJSON(raw);
  if (preferences.has(key)) return validPreference(key, data) ? { kind: "preference", value: raw }
    : { kind: "unknown", reason: "Preferência em formato desconhecido. Conteúdo preservado no pacote, sem alterar a conta." };
  if (isPortableExport(data)) return { kind: "export", data };
  return { kind: "unknown", reason: data === null
    ? "Conteúdo sem formato JSON reconhecido; mantido integralmente no arquivo de recuperação."
    : Array.isArray(data) || (record(data) && Array.isArray(data.tasks))
      ? "Possíveis tarefas de uma versão antiga. Revisar o formato antes de importar, preservando IDs, relações e datas reais."
      : "Formato desconhecido ou exportação incompleta. Conteúdo preservado para revisão, sem publicar alterações." };
}

// Incomplete drafts and loose task arrays never invent fields, relationships or dates.
export function inspectLegacyEntries(entries: Record<string, string>): LegacyInspection {
  const report: LegacyInspection = { draftCount: 0, preferenceCount: 0, exports: [], unknown: [] };
  for (const [key, raw] of Object.entries(entries)) {
    const entry = inspectEntry(key, raw);
    if (entry.kind === "draft") report.draftCount++;
    if (entry.kind === "preference") report.preferenceCount++;
    if (entry.kind === "export") report.exports.push({ key, data: entry.data });
    if (entry.kind === "unknown") report.unknown.push({ key, reason: entry.reason });
  }
  return report;
}

export function recoveryCopyCandidates(entries: Record<string, string>, taskIds?: Set<string>): { entries: Array<{ key: string; value: string }>; skipped: number } {
  const candidates: Array<{ key: string; value: string }> = [];
  let skipped = 0;
  for (const [key, raw] of Object.entries(entries)) {
    const entry = inspectEntry(key, raw);
    if (entry.kind === "unknown") { skipped++; continue; }
    if (entry.kind === "draft") {
      if (taskIds && !taskIds.has(entry.taskId)) { skipped++; continue; }
      candidates.push({ key, value: entry.value });
    } else if (entry.kind === "preference" && copiedPreferences.has(key)) candidates.push({ key, value: entry.value });
  }
  return { entries: candidates, skipped };
}
