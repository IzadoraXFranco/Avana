import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Clock3,
  ExternalLink,
  History,
  Link2,
  LoaderCircle,
  MessageSquare,
  Plus,
  RotateCcw,
  Save,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { command, getDetail, scopedStorageKey } from "./api";
import {
  formatDate,
  formatInstant,
  isOverdue,
  sectionOf,
  today,
} from "./dates";
import type {
  ActiveSection,
  Priority,
  Project,
  Settings,
  Subtask,
  TaskCommand,
  TaskDetail,
} from "./types";
import Modal from "./Modal";
import PrioritySelect from "./PrioritySelect";
import { parseTaskDraftRecord } from "../shared/legacy";
import { downloadJson } from "./cloud";
import "./task-panel.css";

interface Props {
  taskId: string;
  projects: Project[];
  settings: Settings;
  now: Date;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onNotice: (message: string) => void;
}
type MainFields = {
  title: string;
  description: string;
  assignee: string;
  priority: Priority;
  executionOrder: string;
  plannedDate: string;
  dueDate: string;
  dueTime: string;
  projectId: string;
};
type HoldFields = {
  reason: string;
  waitingFor: string;
  nextAction: string;
  followUpDate: string;
};
type SubFields = { title: string; assignee: string; dueDate: string };
type Draft = {
  main: MainFields;
  hold: HoldFields;
  subtasks: Record<string, SubFields>;
  comment: string;
  commentKind: "comment" | "evidence";
  completionNote: string;
  completionLink: string;
  followupNote: string;
  nextFollowup: string;
  newSubtask: string;
};
type DraftRecord = { version: number; base: Draft; draft: Draft };
type Dialog = "complete" | "reopen" | "hold" | "leave" | "delete" | null;
type Conflict = { current: TaskDetail; base: Draft; draft: Draft };
const names = {
  backlog: "Backlog",
  hold: "Hold",
  today: "In Progress (Do Today)",
  doneToday: "Done Today",
  done: "Done",
};
const fieldNames: Record<string, string> = {
  title: "Título",
  description: "Descrição",
  assignee: "Responsável",
  priority: "Prioridade",
  executionOrder: "Ordem de execução",
  plannedDate: "Data planejada",
  dueDate: "Prazo",
  dueTime: "Horário",
  projectId: "Projeto",
  reason: "Motivo da espera",
  waitingFor: "Aguardando",
  nextAction: "Próxima ação",
  followUpDate: "Follow-up",
};
const keyFor = (id: string) => scopedStorageKey(`avana:task-draft:${id}`);
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Não foi possível salvar. Tente novamente.";
const normalizePriority = (value: string): Priority =>
  value === "urgent"
    ? "high"
    : ["low", "medium", "high"].includes(value)
      ? (value as Priority)
      : "";
const validExecutionOrder = (value: string) =>
  value === "" ||
  (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 99999);

function initialDraft(detail: TaskDetail): Draft {
  const t = detail.task;
  return {
    main: {
      title: t.title,
      description: t.description,
      assignee: t.assignee,
      priority: normalizePriority(t.priority),
      executionOrder: t.executionOrder == null ? "" : String(t.executionOrder),
      plannedDate: t.plannedDate || "",
      dueDate: t.dueDate || "",
      dueTime: t.dueTime || "",
      projectId: t.projectId,
    },
    hold: {
      reason: t.holdReason || "",
      waitingFor: t.waitingFor || "",
      nextAction: t.nextAction || "",
      followUpDate: t.followUpDate || "",
    },
    subtasks: Object.fromEntries(
      detail.subtasks.map((s) => [
        s.id,
        { title: s.title, assignee: s.assignee, dueDate: s.dueDate || "" },
      ]),
    ),
    comment: "",
    commentKind: "comment",
    completionNote: "",
    completionLink: "",
    followupNote: "",
    nextFollowup: "",
    newSubtask: "",
  };
}

function mergeFields<T extends Record<string, string>>(
  local: T,
  previous: T,
  current: T,
): T {
  return Object.fromEntries(
    Object.keys(current).map((key) => [
      key,
      local[key] === previous[key] ? current[key] : local[key],
    ]),
  ) as T;
}

function mergeDraft(
  local: Draft,
  previous: Draft,
  current: Draft,
  resets: string[] = [],
): Draft {
  const merged = {
    ...local,
    main: resets.includes("main")
      ? current.main
      : mergeFields(local.main, previous.main, current.main),
    hold: resets.includes("hold")
      ? current.hold
      : mergeFields(local.hold, previous.hold, current.hold),
    subtasks: { ...current.subtasks },
  };
  for (const id of Object.keys(current.subtasks)) {
    if (
      local.subtasks[id] &&
      previous.subtasks[id] &&
      !resets.includes(`subtask:${id}`)
    )
      merged.subtasks[id] = mergeFields(
        local.subtasks[id],
        previous.subtasks[id],
        current.subtasks[id],
      );
  }
  if (resets.includes("comment")) merged.comment = "";
  if (resets.includes("complete")) {
    merged.completionNote = "";
    merged.completionLink = "";
  }
  if (resets.includes("followup")) {
    merged.followupNote = "";
    merged.nextFollowup = "";
  }
  if (resets.includes("newSubtask")) merged.newSubtask = "";
  return merged;
}

function dirty(draft: Draft, base: Draft): boolean {
  return (
    !same(draft.main, base.main) ||
    !same(draft.hold, base.hold) ||
    !same(draft.subtasks, base.subtasks) ||
    !!(
      draft.comment ||
      draft.completionNote ||
      draft.completionLink ||
      draft.followupNote ||
      draft.nextFollowup ||
      draft.newSubtask
    )
  );
}

function safeUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function inline(text: string): ReactNode[] {
  const pieces = text.split(
    /(\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>]+|\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g,
  );
  return pieces.map((piece, index) => {
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(piece);
    if (link && safeUrl(link[2]))
      return (
        <a key={index} href={link[2]} target="_blank" rel="noopener noreferrer">
          {link[1]}
        </a>
      );
    if (/^https?:\/\//.test(piece) && safeUrl(piece))
      return (
        <a key={index} href={piece} target="_blank" rel="noopener noreferrer">
          {piece}
        </a>
      );
    if (piece.startsWith("**") && piece.endsWith("**"))
      return <strong key={index}>{piece.slice(2, -2)}</strong>;
    if (piece.startsWith("`") && piece.endsWith("`"))
      return <code key={index}>{piece.slice(1, -1)}</code>;
    if (piece.startsWith("*") && piece.endsWith("*"))
      return <em key={index}>{piece.slice(1, -1)}</em>;
    return piece;
  });
}

function TextPreview({ value }: { value: string }) {
  if (!value.trim()) return <p className="tp-muted">Sem descrição.</p>;
  return (
    <div className="tp-prose">
      {value.split("\n").map((line, index) =>
        /^#{1,3} /.test(line) ? (
          <h4 key={index}>{inline(line.replace(/^#{1,3} /, ""))}</h4>
        ) : (
          <p
            key={index}
            className={line.startsWith("- ") ? "tp-bullet" : undefined}
          >
            {line ? (
              inline(line.startsWith("- ") ? line.slice(2) : line)
            ) : (
              <br />
            )}
          </p>
        ),
      )}
    </div>
  );
}

export default function TaskPanel({
  taskId,
  projects,
  settings,
  now,
  onClose,
  onChanged,
  onNotice,
}: Props) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const [storageError, setStorageError] = useState("");
  const [unrecognizedDraft, setUnrecognizedDraft] = useState<{ key: string; raw: string } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [reopenTo, setReopenTo] = useState<ActiveSection>("today");
  const [pendingConfirmed, setPendingConfirmed] = useState(false);
  const [previewDescription, setPreviewDescription] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [conflictOpen, setConflictOpen] = useState(true);
  const [conflictChoices, setConflictChoices] = useState<
    Record<string, boolean>
  >({});
  const [expandedSubtask, setExpandedSubtask] = useState<string | null>(null);
  const [deletingSubtask, setDeletingSubtask] = useState<Subtask | null>(null);
  const [compact, setCompact] = useState(
    () => window.matchMedia("(max-width: 1000px)").matches,
  );
  const detailRef = useRef<TaskDetail | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const busyRef = useRef(false);
  const mountedId = useRef(taskId);
  const skipPersist = useRef(false);
  const conflictReturnDialog = useRef<Dialog>(null);
  const pendingRefresh = useRef(false);
  const refreshDetail = useRef<() => void>(() => {});
  const base = detail ? initialDraft(detail) : null;
  const hasDraft = !!(draft && base && dirty(draft, base));
  const hasFieldEdits = !!(
    draft &&
    base &&
    (!same(draft.main, base.main) ||
      !same(draft.hold, base.hold) ||
      !same(draft.subtasks, base.subtasks))
  );
  const project = projects.find((p) => p.id === detail?.task.projectId);
  const readOnly = !!(
    project?.archivedAt ||
    project?.deletedAt ||
    detail?.task.deletedAt
  );
  const locked = busy || readOnly || !!conflict;
  const timezone = settings.timezone;

  function updateDraft(fn: (previous: Draft) => Draft) {
    setDraft((previous) => {
      if (!previous) return previous;
      const next = fn(previous);
      draftRef.current = next;
      return next;
    });
    setSaved("");
  }
  const setMain = <K extends keyof MainFields>(key: K, value: MainFields[K]) =>
    updateDraft((d) => ({
      ...d,
      main: {
        ...d.main,
        [key]: value,
        ...(key === "dueDate" && !value ? { dueTime: "" } : {}),
      },
    }));
  const setHold = <K extends keyof HoldFields>(key: K, value: HoldFields[K]) =>
    updateDraft((d) => ({ ...d, hold: { ...d.hold, [key]: value } }));

  async function load() {
    setLoadError("");
    try {
      const result = await getDetail(taskId);
      if (mountedId.current !== taskId) return;
      const fresh = initialDraft(result);
      let recovered: DraftRecord | null = null;
      const savedDraft = localStorage.getItem(keyFor(taskId));
      if (savedDraft) {
        recovered = parseTaskDraftRecord(savedDraft);
        if (!recovered) {
          // Preserve unknown formats before allowing the normal draft writer to run.
          // If this copy fails, loading stops and the original is never overwritten.
          const recoveryKey = scopedStorageKey(`avana:unrecognized-task-draft:${taskId}:${crypto.randomUUID()}`);
          localStorage.setItem(recoveryKey, savedDraft);
          setUnrecognizedDraft({ key: keyFor(taskId), raw: savedDraft });
        }
      }
      detailRef.current = result;
      setDetail(result);
      if (recovered?.draft?.main && recovered?.base?.main) {
        const restored = {
          ...fresh,
          ...recovered.draft,
          main: {
            ...fresh.main,
            ...recovered.draft.main,
            priority: normalizePriority(recovered.draft.main.priority),
            executionOrder: String(
              recovered.draft.main.executionOrder ?? fresh.main.executionOrder,
            ),
          },
          hold: { ...fresh.hold, ...recovered.draft.hold },
          subtasks: recovered.draft.subtasks || fresh.subtasks,
        };
        draftRef.current = restored;
        setDraft(restored);
        if (recovered.version !== result.task.version) {
          setConflict({
            current: result,
            base: {
              ...recovered.base,
              main: {
                ...fresh.main,
                ...recovered.base.main,
                priority: normalizePriority(recovered.base.main.priority),
                executionOrder: String(
                  recovered.base.main.executionOrder ??
                    fresh.main.executionOrder,
                ),
              },
            },
            draft: restored,
          });
          setConflictChoices({});
          setConflictOpen(true);
        } else setSaved("Rascunho recuperado neste dispositivo.");
      } else {
        draftRef.current = fresh;
        setDraft(fresh);
      }
    } catch (cause) {
      if (mountedId.current === taskId) setLoadError(errorText(cause));
    }
  }

  useEffect(() => {
    mountedId.current = taskId;
    skipPersist.current = false;
    setDetail(null);
    setDraft(null);
    detailRef.current = null;
    draftRef.current = null;
    setError("");
    setSaved("");
    setStorageError("");
    setUnrecognizedDraft(null);
    setDialog(null);
    setConflict(null);
    setExpandedSubtask(null);
    void load();
    return () => {
      mountedId.current = "";
    };
    // Each task keeps its own recoverable draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1000px)");
    const update = () => setCompact(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (detail)
      panelRef.current
        ?.querySelector<HTMLTextAreaElement>("#task-title")
        ?.focus();
  }, [taskId, !!detail]);

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    const refresh = async () => {
      if (busyRef.current) { pendingRefresh.current = true; return; }
      if (!detailRef.current) return;
      const requestGeneration = ++generation;
      pendingRefresh.current = false;
      try {
        const next = await getDetail(taskId);
        const previous = detailRef.current;
        const local = draftRef.current;
        if (
          cancelled || requestGeneration !== generation ||
          !previous ||
          next.task.version <= previous.task.version
        )
          return;
        if (busyRef.current) { pendingRefresh.current = true; return; }
        if (local && dirty(local, initialDraft(previous))) {
          setConflict({
            current: next,
            base: initialDraft(previous),
            draft: local,
          });
          setConflictChoices({});
          setConflictOpen(true);
          setDialog(null);
          setDeletingSubtask(null);
        } else acceptResponse(next, []);
      } catch {
        /* A failed background refresh must not discard the editor. */
      }
    };
    refreshDetail.current = () => { void refresh(); };
    window.addEventListener("avana:data-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      refreshDetail.current = () => {};
      window.removeEventListener("avana:data-changed", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [taskId]);

  useEffect(() => {
    if (
      !detail ||
      detail.task.id !== taskId ||
      !draft ||
      skipPersist.current ||
      conflict
    )
      return;
    try {
      const fresh = initialDraft(detail);
      if (dirty(draft, fresh))
        localStorage.setItem(
          keyFor(taskId),
          JSON.stringify({
            version: detail.task.version,
            base: fresh,
            draft,
          } satisfies DraftRecord),
        );
      else localStorage.removeItem(keyFor(taskId));
      setStorageError("");
    } catch {
      setStorageError(
        "O rascunho não pôde ser guardado neste navegador. Mantenha o painel aberto até salvar.",
      );
    }
  }, [detail, draft, taskId, conflict]);

  useEffect(() => {
    if (!hasDraft && !busy) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasDraft, busy]);

  function requestClose() {
    if (busyRef.current) {
      setError("Aguarde a resposta do salvamento antes de fechar.");
      return;
    }
    if (hasDraft) setDialog("leave");
    else onClose();
  }

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (dialog || (conflict && conflictOpen) || deletingSubtask) return;
      if (
        event.key === "Escape" &&
        panelRef.current?.contains(document.activeElement)
      ) {
        event.preventDefault();
        event.stopPropagation();
        requestClose();
      }
      if (compact && event.key === "Tab") {
        const nodes = Array.from(
          panelRef.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary",
          ) || [],
        ).filter((node) => node.offsetParent !== null);
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  });

  function acceptResponse(next: TaskDetail, resets: string[]) {
    const prior = detailRef.current;
    const currentDraft = draftRef.current;
    const fresh = initialDraft(next);
    const merged =
      prior && currentDraft
        ? mergeDraft(currentDraft, initialDraft(prior), fresh, resets)
        : fresh;
    detailRef.current = next;
    draftRef.current = merged;
    setDetail(next);
    setDraft(merged);
    setSaved("Alterações salvas.");
  }

  async function run(
    action: TaskCommand,
    resets: string[] = [],
  ): Promise<boolean> {
    if (!detailRef.current || busyRef.current || readOnly || conflict)
      return false;
    const workingId = taskId;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const next = await command(detailRef.current.task, action);
      if (mountedId.current !== workingId) return false;
      acceptResponse(next, resets);
      try {
        await onChanged();
      } catch {
        setError(
          "A alteração foi salva, mas a lista não atualizou. Atualize a página quando terminar suas edições.",
        );
      }
      return true;
    } catch (cause) {
      if (mountedId.current !== workingId) return false;
      const metadata = cause as { code?: string; status?: number };
      if (
        metadata?.code === "VERSION_CONFLICT" ||
        metadata?.status === 409 ||
        /versão|version|conflito|conflict/i.test(errorText(cause))
      ) {
        try {
          const current = await getDetail(workingId);
          if (detailRef.current && draftRef.current) {
            conflictReturnDialog.current =
              action.action === "complete"
                ? "complete"
                : action.action === "reopen"
                  ? "reopen"
                  : action.action === "move" && action.section === "hold"
                    ? "hold"
                    : null;
            setConflict({
              current,
              base: initialDraft(detailRef.current),
              draft: draftRef.current,
            });
            setConflictChoices({});
            setConflictOpen(true);
            setDialog(null);
            setDeletingSubtask(null);
          }
        } catch {
          setError(
            "Outra alteração foi detectada. Seu rascunho está preservado; tente novamente quando a conexão voltar.",
          );
        }
      } else setError(errorText(cause));
      return false;
    } finally {
      busyRef.current = false;
      if (mountedId.current === workingId) setBusy(false);
      if (pendingRefresh.current && mountedId.current === workingId) refreshDetail.current();
    }
  }

  async function saveMain() {
    if (!draft || !base) return;
    if (!draft.main.title.trim()) {
      setError("A tarefa precisa de um título.");
      return;
    }
    if (!validExecutionOrder(draft.main.executionOrder)) {
      setError(
        "A ordem de execução deve ser um número inteiro entre 1 e 99999, ou ficar em branco. Suas alterações foram preservadas.",
      );
      panelRef.current
        ?.querySelector<HTMLInputElement>("#task-execution-order")
        ?.focus();
      return;
    }
    const fields = Object.fromEntries(
      Object.entries(draft.main)
        .filter(([key, value]) => value !== base.main[key as keyof MainFields])
        .map(([key, value]) => [
          key,
          key === "executionOrder"
            ? value === ""
              ? null
              : Number(value)
            : ["plannedDate", "dueDate", "dueTime"].includes(key)
              ? value || null
              : value,
        ]),
    );
    if (Object.keys(fields).length)
      await run({ action: "edit", fields }, ["main"]);
  }

  function requireSavedFields(): boolean {
    if (hasFieldEdits) {
      setError(
        "Salve as alterações dos campos antes de mudar o estado da tarefa. Seus textos continuam no painel.",
      );
      return false;
    }
    return true;
  }

  function changeSection(section: ActiveSection) {
    if (
      section === "hold" &&
      draft &&
      base &&
      same(draft.main, base.main) &&
      same(draft.subtasks, base.subtasks)
    ) {
      setDialog("hold");
      return;
    }
    if (!requireSavedFields()) return;
    if (section === "hold") setDialog("hold");
    else void run({ action: section === "today" ? "plan" : "move", section });
  }

  function closeHoldDialog() {
    if (busyRef.current) return;
    if (base) updateDraft((d) => ({ ...d, hold: base.hold }));
    setDialog(null);
  }

  async function registerFollowup() {
    if (!draft || !requireSavedFields()) return;
    await run(
      {
        action: "followupDone",
        note: draft.followupNote.trim(),
        nextDate: draft.nextFollowup || null,
      },
      ["followup", "hold"],
    );
  }

  async function complete() {
    if (!draft || !detail) return;
    if (draft.completionLink && !safeUrl(draft.completionLink)) {
      setError("Informe um link completo começando com https:// ou http://.");
      return;
    }
    if (
      project?.requireEvidence &&
      !draft.completionNote.trim() &&
      !draft.completionLink.trim()
    ) {
      setError(
        "Este projeto pede uma nota ou link como evidência de conclusão.",
      );
      return;
    }
    if (
      await run(
        {
          action: "complete",
          note: draft.completionNote.trim(),
          link: draft.completionLink.trim(),
          confirmPending: pendingConfirmed,
        },
        ["complete", "hold"],
      )
    ) {
      setDialog(null);
      onNotice("Tarefa concluída. Sua entrega está em Done Today.");
    }
  }

  function beginCompletion() {
    if (!requireSavedFields()) return;
    if (draft?.followupNote || draft?.nextFollowup) {
      setError(
        "Registre o acompanhamento em aberto ou limpe seus campos antes de concluir. Seu texto está preservado abaixo.",
      );
      return;
    }
    setError("");
    setPendingConfirmed(false);
    setDialog("complete");
  }

  function conflictItems() {
    if (!conflict) return [];
    const current = initialDraft(conflict.current);
    const items: {
      key: string;
      label: string;
      before: string;
      local: string;
      server: string;
    }[] = [];
    for (const group of ["main", "hold"] as const) {
      for (const key of Object.keys(current[group])) {
        const before =
          (conflict.base[group] as Record<string, string>)[key] ?? "";
        const local =
          (conflict.draft[group] as Record<string, string>)[key] ?? "";
        const server = (current[group] as Record<string, string>)[key] ?? "";
        if (local !== before && server !== before && local !== server)
          items.push({
            key: `${group}.${key}`,
            label: fieldNames[key] || key,
            before,
            local,
            server,
          });
      }
    }
    for (const [id, localFields] of Object.entries(conflict.draft.subtasks)) {
      const previous = conflict.base.subtasks[id];
      const server = current.subtasks[id];
      if (!previous || !server) continue;
      for (const key of Object.keys(localFields) as (keyof SubFields)[])
        if (
          localFields[key] !== previous[key] &&
          server[key] !== previous[key] &&
          localFields[key] !== server[key]
        )
          items.push({
            key: `subtasks.${id}.${key}`,
            label: `Subtarefa · ${fieldNames[key]}`,
            before: previous[key],
            local: localFields[key],
            server: server[key],
          });
    }
    return items;
  }

  function resolveConflict() {
    if (!conflict) return;
    const fresh = initialDraft(conflict.current);
    const merged = mergeDraft(conflict.draft, conflict.base, fresh);
    const removedDrafts = Object.entries(conflict.draft.subtasks).filter(
      ([id, fields]) =>
        !fresh.subtasks[id] && !same(fields, conflict.base.subtasks[id]),
    );
    if (removedDrafts.length) {
      const recovery = removedDrafts
        .map(
          ([, fields]) =>
            `Rascunho de subtarefa removida em outra janela:\n${fields.title}\nResponsável: ${fields.assignee || "não definido"}\nPrazo: ${fields.dueDate || "sem prazo"}`,
        )
        .join("\n\n");
      merged.comment = [merged.comment, recovery].filter(Boolean).join("\n\n");
    }
    for (const item of conflictItems()) {
      if (conflictChoices[item.key]) continue;
      const path = item.key.split(".");
      if (path[0] === "main" || path[0] === "hold")
        (merged[path[0]] as Record<string, string>)[path[1]] = item.server;
      else if (merged.subtasks[path[1]])
        merged.subtasks[path[1]][path[2] as keyof SubFields] = item.server;
    }
    detailRef.current = conflict.current;
    draftRef.current = merged;
    setDetail(conflict.current);
    setDraft(merged);
    setConflict(null);
    setError("");
    setDialog(conflictReturnDialog.current);
    conflictReturnDialog.current = null;
    setSaved(
      "Versão atual carregada. Revise seu rascunho e salve cada alteração.",
    );
  }

  function hasRemovedSubtaskDrafts(): boolean {
    if (!conflict) return false;
    return Object.entries(conflict.draft.subtasks).some(
      ([id, fields]) =>
        !conflict.current.subtasks.some((s) => s.id === id) &&
        !same(fields, conflict.base.subtasks[id]),
    );
  }

  function holdForm(prefix: string) {
    if (!draft) return null;
    return (
      <div className="tp-form-stack">
        <label htmlFor={`${prefix}-reason`}>
          Motivo da espera
          <input
            id={`${prefix}-reason`}
            value={draft.hold.reason}
            onChange={(e) => setHold("reason", e.target.value)}
            placeholder="O que impede o avanço?"
          />
        </label>
        <label htmlFor={`${prefix}-waiting`}>
          Aguardando quem ou o quê
          <input
            id={`${prefix}-waiting`}
            value={draft.hold.waitingFor}
            onChange={(e) => setHold("waitingFor", e.target.value)}
            placeholder="Pessoa, aprovação ou informação"
          />
        </label>
        <label htmlFor={`${prefix}-next`}>
          Próxima ação
          <input
            id={`${prefix}-next`}
            value={draft.hold.nextAction}
            onChange={(e) => setHold("nextAction", e.target.value)}
            placeholder="O que você fará para acompanhar?"
          />
        </label>
        <label htmlFor={`${prefix}-followup`}>
          Data de follow-up
          <input
            id={`${prefix}-followup`}
            type="date"
            value={draft.hold.followUpDate}
            onChange={(e) => setHold("followUpDate", e.target.value)}
          />
        </label>
      </div>
    );
  }

  if (!detail || !draft || !base)
    return (
      <aside
        className="task-panel"
        aria-label="Detalhes da tarefa"
        ref={panelRef}
      >
        <div className="tp-toolbar">
          <span>Detalhes da tarefa</span>
          <button
            className="tp-icon"
            onClick={onClose}
            aria-label="Fechar detalhes"
          >
            <X size={18} />
          </button>
        </div>
        <div className="tp-loading" role="status">
          {loadError ? (
            <>
              <p>{loadError}</p>
              <button className="tp-btn" onClick={() => void load()}>
                Tentar novamente
              </button>
            </>
          ) : (
            <>
              <LoaderCircle className="tp-spin" size={22} />
              <span>Carregando tarefa…</span>
            </>
          )}
        </div>
      </aside>
    );

  const task = detail.task;
  const currentToday = today(timezone, now);
  const grouping = sectionOf(task, currentToday, timezone);
  const incomplete = detail.subtasks.filter((s) => !s.completedAt).length;
  const sortedSubtasks = [...detail.subtasks].sort(
    (a, b) => a.position - b.position,
  );
  const currentFollowup = detail.followUps.find((f) => f.status === "pending");
  const unchangedMain = same(draft.main, base.main);
  const unchangedHold = same(draft.hold, base.hold);

  return (
    <>
      <aside
        className="task-panel"
        role={compact ? "dialog" : "complementary"}
        aria-modal={compact || undefined}
        aria-label={`Detalhes: ${task.title}`}
        ref={panelRef}
      >
        <div className="tp-toolbar">
          <span
            className={`tp-state ${task.completedAt ? "tp-state-complete" : ""}`}
          >
            {task.completedAt ? (
              <CheckCheck size={15} />
            ) : task.section === "hold" ? (
              <Clock3 size={15} />
            ) : (
              <span className="tp-state-dot" />
            )}
            {names[grouping]}
          </span>
          <div className="tp-toolbar-actions">
            <a
              className="tp-icon"
              href={`/?task=${encodeURIComponent(task.id)}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Abrir tarefa em outra aba"
              title="Abrir em outra aba"
            >
              <ExternalLink size={16} />
            </a>
            <button
              className="tp-icon"
              onClick={requestClose}
              aria-label="Fechar detalhes"
            >
              <X size={19} />
            </button>
          </div>
        </div>
        <div className="tp-body">
          {readOnly && (
            <div className="tp-alert">
              <ShieldAlert size={16} />
              <span>
                {task.deletedAt
                  ? "Esta tarefa está na lixeira. Restaure-a para editar."
                  : "Projeto arquivado ou excluído. Restaure-o para editar suas tarefas."}
              </span>
            </div>
          )}
          {conflict && (
            <div className="tp-alert">
              <span>
                A tarefa foi alterada em outra janela. Seu rascunho foi
                preservado.
              </span>
              <button
                className="tp-text-btn"
                onClick={() => setConflictOpen(true)}
              >
                Revisar versões
              </button>
            </div>
          )}
          {error && (
            <div className="tp-alert tp-alert-error" role="alert">
              <span>{error}</span>
              <button
                className="tp-icon"
                onClick={() => setError("")}
                aria-label="Dispensar aviso"
              >
                <X size={15} />
              </button>
            </div>
          )}
          {storageError && (
            <div className="tp-alert tp-alert-error" role="alert">
              {storageError}
            </div>
          )}
          {unrecognizedDraft && (
            <div className="tp-alert" role="status">
              <span>Um rascunho antigo não foi reconhecido. O original foi preservado neste navegador para revisão.</span>
              <button className="tp-text-btn" onClick={() => downloadJson({
                format: "avana-browser-recovery", version: 1,
                exportedAt: new Date().toISOString(), origin: location.origin,
                entries: { [unrecognizedDraft.key]: unrecognizedDraft.raw },
              }, `avana-rascunho-${taskId}.json`)}>Baixar rascunho original</button>
            </div>
          )}
          <div className="tp-title-area">
            <label className="tp-sr-only" htmlFor="task-title">
              Título da tarefa
            </label>
            <textarea
              id="task-title"
              className="tp-title"
              rows={2}
              maxLength={300}
              value={draft.main.title}
              disabled={locked}
              onChange={(e) => setMain("title", e.target.value)}
              placeholder="Título da tarefa"
            />
            <div className="tp-main-actions">
              <button
                className={`tp-btn ${task.completedAt ? "" : "tp-btn-primary"}`}
                disabled={locked}
                onClick={() => {
                  if (!requireSavedFields()) return;
                  if (task.completedAt) {
                    setReopenTo("today");
                    setDialog("reopen");
                  } else beginCompletion();
                }}
              >
                {task.completedAt ? (
                  <RotateCcw size={15} />
                ) : (
                  <Check size={16} />
                )}
                {task.completedAt ? "Reabrir tarefa" : "Concluir tarefa"}
              </button>
              {!task.completedAt && (
                <select
                  className="tp-section-select"
                  aria-label="Mover tarefa para seção"
                  value={task.section || "backlog"}
                  disabled={locked}
                  onChange={(e) =>
                    changeSection(e.target.value as ActiveSection)
                  }
                >
                  <option value="backlog">Backlog</option>
                  <option value="hold">Hold</option>
                  <option value="today">In Progress (Do Today)</option>
                </select>
              )}
            </div>
            <div className="tp-status-chips">
              {isOverdue(task, currentToday, now) && (
                <span className="tp-chip tp-chip-danger">Prazo atrasado</span>
              )}
              {task.section === "hold" && (
                <span className="tp-chip">Em espera</span>
              )}
              {task.followUpDate &&
                task.followUpDate < currentToday &&
                !task.completedAt && (
                  <span className="tp-chip tp-chip-danger">
                    Follow-up vencido
                  </span>
                )}
            </div>
            {task.completedAt && (
              <p className="tp-caption">
                Concluída em {formatInstant(task.completedAt, timezone)}.
              </p>
            )}
            {task.section === "today" &&
              (!task.plannedDate || task.plannedDate < currentToday) && (
                <div className="tp-review">
                  <span>
                    {task.plannedDate
                      ? `Planejada para ${formatDate(task.plannedDate)}. `
                      : ""}
                    Reveja sua seleção para hoje.
                  </span>
                  <button
                    disabled={locked}
                    onClick={() => {
                      if (requireSavedFields()) void run({ action: "plan" });
                    }}
                  >
                    Planejar para hoje
                  </button>
                </div>
              )}
          </div>

          <fieldset className="tp-fields" disabled={locked}>
            <label htmlFor="task-project">
              Projeto
              <select
                id="task-project"
                value={draft.main.projectId}
                onChange={(e) => setMain("projectId", e.target.value)}
              >
                {projects
                  .filter(
                    (p) =>
                      (!p.archivedAt && !p.deletedAt) ||
                      p.id === task.projectId,
                  )
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
            <label htmlFor="task-assignee">
              Responsável
              <input
                id="task-assignee"
                value={draft.main.assignee}
                onChange={(e) => setMain("assignee", e.target.value)}
                placeholder="Sem responsável"
              />
            </label>
            <label htmlFor="task-priority">
              Prioridade
              <PrioritySelect
                id="task-priority"
                value={draft.main.priority}
                disabled={locked}
                onChange={(value: Priority) => setMain("priority", value)}
              />
            </label>
            <label htmlFor="task-execution-order">
              <span>
                Ordem de execução <span className="tp-optional">opcional</span>
              </span>
              <input
                id="task-execution-order"
                type="number"
                inputMode="numeric"
                min={1}
                max={99999}
                step={1}
                value={draft.main.executionOrder}
                aria-describedby="task-execution-order-hint"
                aria-invalid={
                  !validExecutionOrder(draft.main.executionOrder) || undefined
                }
                onChange={(e) => setMain("executionOrder", e.target.value)}
                placeholder="Sem ordem definida"
              />
              <span id="task-execution-order-hint" className="tp-field-hint">
                {draft.main.executionOrder &&
                validExecutionOrder(draft.main.executionOrder)
                  ? `${Number(draft.main.executionOrder)}º na sequência de execução.`
                  : "Use 1 para 1º, 2 para 2º… até 99999."}
              </span>
            </label>
            <label htmlFor="task-planned">
              Data planejada
              <input
                id="task-planned"
                type="date"
                value={draft.main.plannedDate}
                onChange={(e) => setMain("plannedDate", e.target.value)}
              />
            </label>
            <label htmlFor="task-due">
              Prazo final
              <input
                id="task-due"
                type="date"
                value={draft.main.dueDate}
                onChange={(e) => setMain("dueDate", e.target.value)}
              />
            </label>
            <label htmlFor="task-time">
              Horário do prazo <span className="tp-optional">opcional</span>
              <input
                id="task-time"
                type="time"
                value={draft.main.dueTime}
                disabled={!draft.main.dueDate || locked}
                onChange={(e) => setMain("dueTime", e.target.value)}
              />
            </label>
          </fieldset>
          {draft.main.dueTime && (
            <p className="tp-caption tp-date-help">
              Horário em {task.dueTimezone || timezone}.
            </p>
          )}
          {draft.main.projectId !== task.projectId && (
            <p className="tp-caption">
              Mover de projeto preserva comentários e histórico. Tarefas abertas
              fora de Hold voltam ao Backlog.
            </p>
          )}

          <section className="tp-section">
            <div className="tp-heading">
              <h3>Descrição</h3>
              <button
                className="tp-text-btn"
                onClick={() => setPreviewDescription(!previewDescription)}
              >
                {previewDescription ? "Editar texto" : "Visualizar"}
              </button>
            </div>
            {previewDescription ? (
              <TextPreview value={draft.main.description} />
            ) : (
              <>
                <label className="tp-sr-only" htmlFor="task-description">
                  Descrição
                </label>
                <textarea
                  id="task-description"
                  className="tp-description"
                  rows={4}
                  value={draft.main.description}
                  disabled={locked}
                  onChange={(e) => setMain("description", e.target.value)}
                  placeholder="Adicione contexto, objetivos ou instruções…"
                />
                <p className="tp-caption">
                  Formatação: **negrito**, *itálico*, - lista e
                  [texto](https://link).
                </p>
              </>
            )}
            {!unchangedMain && (
              <div className="tp-save-row">
                <span>Alterações de campos não salvas</span>
                <button
                  className="tp-btn tp-btn-primary"
                  disabled={locked}
                  onClick={() => void saveMain()}
                >
                  <Save size={14} />
                  Salvar campos
                </button>
              </div>
            )}
          </section>

          <section className="tp-section">
            <div className="tp-heading">
              <h3>Subtarefas</h3>
              <span className="tp-count">
                {detail.subtasks.filter((s) => s.completedAt).length} de{" "}
                {detail.subtasks.length} concluídas
              </span>
            </div>
            {detail.subtasks.length > 0 && (
              <div
                className="tp-progress"
                role="progressbar"
                aria-label="Progresso das subtarefas"
                aria-valuemin={0}
                aria-valuemax={detail.subtasks.length}
                aria-valuenow={
                  detail.subtasks.filter((s) => s.completedAt).length
                }
              >
                <span
                  style={{
                    width: `${(detail.subtasks.filter((s) => s.completedAt).length / detail.subtasks.length) * 100}%`,
                  }}
                />
              </div>
            )}
            <div className="tp-subtasks">
              {sortedSubtasks.map((subtask, index) => {
                const fields =
                  draft.subtasks[subtask.id] || base.subtasks[subtask.id];
                if (!fields) return null;
                const changed = !same(fields, base.subtasks[subtask.id]);
                const changeSub = (key: keyof SubFields, value: string) =>
                  updateDraft((d) => ({
                    ...d,
                    subtasks: {
                      ...d.subtasks,
                      [subtask.id]: { ...fields, [key]: value },
                    },
                  }));
                return (
                  <div className="tp-subtask" key={subtask.id}>
                    <div className="tp-subtask-row">
                      <input
                        type="checkbox"
                        aria-label={`${subtask.completedAt ? "Reabrir" : "Concluir"} subtarefa ${subtask.title}`}
                        checked={!!subtask.completedAt}
                        disabled={locked}
                        onChange={(e) =>
                          void run({
                            action: "subtaskEdit",
                            subtaskId: subtask.id,
                            fields: { completed: e.target.checked },
                          })
                        }
                      />
                      <input
                        className={subtask.completedAt ? "tp-subtask-done" : ""}
                        aria-label={`Título da subtarefa ${index + 1}`}
                        value={fields.title}
                        disabled={locked}
                        onChange={(e) => changeSub("title", e.target.value)}
                      />
                      <button
                        className="tp-icon"
                        aria-expanded={expandedSubtask === subtask.id}
                        aria-label={`Opções da subtarefa ${subtask.title}`}
                        onClick={() =>
                          setExpandedSubtask(
                            expandedSubtask === subtask.id ? null : subtask.id,
                          )
                        }
                      >
                        {expandedSubtask === subtask.id ? (
                          <ChevronDown size={15} />
                        ) : (
                          <ChevronRight size={15} />
                        )}
                      </button>
                    </div>
                    {(expandedSubtask === subtask.id || changed) && (
                      <div className="tp-subtask-options">
                        <div className="tp-fields">
                          <label>
                            Responsável
                            <input
                              value={fields.assignee}
                              disabled={locked}
                              onChange={(e) =>
                                changeSub("assignee", e.target.value)
                              }
                              placeholder="Opcional"
                            />
                          </label>
                          <label>
                            Prazo
                            <input
                              type="date"
                              value={fields.dueDate}
                              disabled={locked}
                              onChange={(e) =>
                                changeSub("dueDate", e.target.value)
                              }
                            />
                          </label>
                        </div>
                        <div className="tp-subtask-buttons">
                          <button
                            className="tp-icon"
                            disabled={locked || index === 0}
                            title="Mover subtarefa para cima"
                            aria-label="Mover subtarefa para cima"
                            onClick={() =>
                              void run({
                                action: "subtaskReorder",
                                subtaskId: subtask.id,
                                beforeId: sortedSubtasks[index - 1].id,
                              })
                            }
                          >
                            <ArrowUp size={15} />
                          </button>
                          <button
                            className="tp-icon"
                            disabled={
                              locked || index === sortedSubtasks.length - 1
                            }
                            title="Mover subtarefa para baixo"
                            aria-label="Mover subtarefa para baixo"
                            onClick={() =>
                              void run({
                                action: "subtaskReorder",
                                subtaskId: subtask.id,
                                beforeId: sortedSubtasks[index + 2]?.id || null,
                              })
                            }
                          >
                            <ArrowDown size={15} />
                          </button>
                          <button
                            className="tp-icon tp-danger-text"
                            disabled={locked}
                            aria-label={`Excluir subtarefa ${subtask.title}`}
                            onClick={() => setDeletingSubtask(subtask)}
                          >
                            <Trash2 size={14} />
                          </button>
                          {changed && (
                            <button
                              className="tp-btn tp-btn-small"
                              disabled={locked || !fields.title.trim()}
                              onClick={() =>
                                void run(
                                  {
                                    action: "subtaskEdit",
                                    subtaskId: subtask.id,
                                    fields: {
                                      ...fields,
                                      title: fields.title.trim(),
                                      dueDate: fields.dueDate || null,
                                    },
                                  },
                                  [`subtask:${subtask.id}`],
                                )
                              }
                            >
                              Salvar subtarefa
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {!readOnly && (
              <form
                className="tp-add-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (draft.newSubtask.trim())
                    void run(
                      { action: "subtaskAdd", title: draft.newSubtask.trim() },
                      ["newSubtask"],
                    );
                }}
              >
                <Plus size={16} />
                <input
                  aria-label="Nova subtarefa"
                  value={draft.newSubtask}
                  disabled={locked}
                  onChange={(e) =>
                    updateDraft((d) => ({ ...d, newSubtask: e.target.value }))
                  }
                  placeholder="Adicionar subtarefa"
                />
                <button
                  className="tp-text-btn"
                  disabled={locked || !draft.newSubtask.trim()}
                >
                  Adicionar
                </button>
              </form>
            )}
          </section>

          <section className="tp-section">
            <div className="tp-heading">
              <h3>Bloqueio e acompanhamento</h3>
              <Clock3 size={16} className="tp-muted" />
            </div>
            {task.section === "hold" ? (
              <fieldset disabled={locked} className="tp-fieldset">
                <p className="tp-caption">
                  Em espera desde{" "}
                  {task.holdSince
                    ? formatInstant(task.holdSince, timezone)
                    : "agora"}
                  . O responsável continua sendo{" "}
                  {task.assignee || "não definido"}.
                </p>
                {holdForm("panel")}
                <div className="tp-save-row">
                  <span>Follow-up é a data de acompanhar, não o prazo.</span>
                  <button
                    className="tp-btn tp-btn-small"
                    disabled={locked || unchangedHold}
                    onClick={() =>
                      void run(
                        {
                          action: "hold",
                          ...draft.hold,
                          followUpDate: draft.hold.followUpDate || null,
                        },
                        ["hold"],
                      )
                    }
                  >
                    Salvar acompanhamento
                  </button>
                </div>
              </fieldset>
            ) : (
              <>
                {!task.completedAt && (
                  <label className="tp-standalone-field">
                    Data de follow-up
                    <input
                      type="date"
                      disabled={locked}
                      value={draft.hold.followUpDate}
                      onChange={(e) => setHold("followUpDate", e.target.value)}
                    />
                  </label>
                )}
                {!task.completedAt &&
                  draft.hold.followUpDate !== base.hold.followUpDate && (
                    <button
                      className="tp-btn tp-btn-small"
                      disabled={locked}
                      onClick={() =>
                        void run(
                          {
                            action: "followup",
                            date: draft.hold.followUpDate || null,
                          },
                          ["hold"],
                        )
                      }
                    >
                      Salvar follow-up
                    </button>
                  )}
                {!task.completedAt && (
                  <p className="tp-caption">
                    Se depender de uma resposta ou aprovação, mova a tarefa para
                    Hold.
                  </p>
                )}
              </>
            )}
            {currentFollowup && !task.completedAt && (
              <div className="tp-followup">
                <div className="tp-followup-label">
                  <Clock3 size={15} />
                  <strong>
                    Acompanhar em {formatDate(currentFollowup.date)}
                  </strong>
                  {currentFollowup.date < currentToday && (
                    <span className="tp-chip tp-chip-danger">Vencido</span>
                  )}
                </div>
                <label>
                  Registro do acompanhamento
                  <textarea
                    rows={2}
                    value={draft.followupNote}
                    disabled={locked}
                    onChange={(e) =>
                      updateDraft((d) => ({
                        ...d,
                        followupNote: e.target.value,
                      }))
                    }
                    placeholder="O que aconteceu neste acompanhamento?"
                  />
                </label>
                <label>
                  Próximo follow-up{" "}
                  <span className="tp-optional">opcional</span>
                  <input
                    type="date"
                    value={draft.nextFollowup}
                    disabled={locked}
                    onChange={(e) =>
                      updateDraft((d) => ({
                        ...d,
                        nextFollowup: e.target.value,
                      }))
                    }
                  />
                </label>
                <button
                  className="tp-btn tp-btn-small"
                  disabled={locked || !draft.followupNote.trim()}
                  onClick={() => void registerFollowup()}
                >
                  Registrar acompanhamento
                </button>
              </div>
            )}
            {detail.holds.length > 0 && (
              <details className="tp-history-details">
                <summary>
                  Histórico de bloqueios <span>{detail.holds.length}</span>
                </summary>
                <ol className="tp-timeline">
                  {[...detail.holds].reverse().map((hold) => (
                    <li key={hold.id}>
                      <strong>{hold.reason || "Sem motivo registrado"}</strong>
                      <p>
                        {hold.waitingFor
                          ? `Aguardando: ${hold.waitingFor}. `
                          : ""}
                        {hold.nextAction && `Próxima ação: ${hold.nextAction}`}
                      </p>
                      <span>
                        {formatInstant(hold.startedAt, timezone)}
                        {hold.endedAt
                          ? ` → ${formatInstant(hold.endedAt, timezone)}`
                          : " · em aberto"}
                      </span>
                    </li>
                  ))}
                </ol>
              </details>
            )}
            {detail.followUps.some((f) => f.status !== "pending") && (
              <details className="tp-history-details">
                <summary>Acompanhamentos anteriores</summary>
                <ol className="tp-timeline">
                  {detail.followUps
                    .filter((f) => f.status !== "pending")
                    .slice()
                    .reverse()
                    .map((f) => (
                      <li key={f.id}>
                        <strong>
                          {formatDate(f.date)} ·{" "}
                          {f.status === "done" ? "Realizado" : "Encerrado"}
                        </strong>
                        <p>{f.note || "Sem observação."}</p>
                        {f.closedAt && (
                          <span>{formatInstant(f.closedAt, timezone)}</span>
                        )}
                      </li>
                    ))}
                </ol>
              </details>
            )}
          </section>

          <section className="tp-section">
            <div className="tp-heading">
              <h3>Comentários e evidências</h3>
              <span className="tp-count">{detail.comments.length}</span>
            </div>
            {detail.comments.length === 0 && (
              <p className="tp-empty">
                <MessageSquare size={17} />
                Registre decisões, entregas e links úteis.
              </p>
            )}
            <div className="tp-comments">
              {detail.comments.map((comment) => (
                <article className="tp-comment" key={comment.id}>
                  <div className="tp-comment-meta">
                    <strong>{comment.author || settings.name}</strong>
                    {comment.kind === "evidence" && (
                      <span className="tp-chip">
                        <Link2 size={11} />
                        Evidência
                      </span>
                    )}
                    <time dateTime={comment.createdAt}>
                      {formatInstant(comment.createdAt, timezone)}
                    </time>
                  </div>
                  <TextPreview value={comment.body} />
                </article>
              ))}
            </div>
            {!readOnly && (
              <form
                className="tp-comment-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (draft.comment.trim())
                    void run(
                      {
                        action: "comment",
                        body: draft.comment.trim(),
                        kind: draft.commentKind,
                      },
                      ["comment"],
                    );
                }}
              >
                <label className="tp-sr-only" htmlFor="task-comment">
                  Escrever comentário ou evidência
                </label>
                <textarea
                  id="task-comment"
                  rows={3}
                  value={draft.comment}
                  disabled={locked}
                  onChange={(e) =>
                    updateDraft((d) => ({ ...d, comment: e.target.value }))
                  }
                  placeholder="Escreva um comentário ou cole um link…"
                />
                <div className="tp-comment-actions">
                  <label>
                    <input
                      type="checkbox"
                      checked={draft.commentKind === "evidence"}
                      disabled={locked}
                      onChange={(e) =>
                        updateDraft((d) => ({
                          ...d,
                          commentKind: e.target.checked
                            ? "evidence"
                            : "comment",
                        }))
                      }
                    />
                    Marcar como evidência
                  </label>
                  <button
                    className="tp-btn tp-btn-primary tp-btn-small"
                    disabled={locked || !draft.comment.trim()}
                  >
                    Adicionar
                  </button>
                </div>
              </form>
            )}
          </section>

          <section className="tp-section tp-activity">
            <button
              className="tp-activity-toggle"
              aria-expanded={showActivity}
              onClick={() => setShowActivity(!showActivity)}
            >
              <History size={16} />
              <span>Histórico de atividade</span>
              <span className="tp-count">{detail.activity.length}</span>
              {showActivity ? (
                <ChevronDown size={16} />
              ) : (
                <ChevronRight size={16} />
              )}
            </button>
            {showActivity && (
              <ol className="tp-timeline">
                {detail.activity.map((activity) => (
                  <li key={activity.id}>
                    <strong>{activity.summary}</strong>
                    <span>
                      {activity.author || settings.name} ·{" "}
                      {formatInstant(activity.createdAt, timezone)}
                    </span>
                    {(activity.before != null || activity.after != null) && (
                      <details>
                        <summary>Ver alteração</summary>
                        <div className="tp-change-values">
                          <div>
                            <span>Antes</span>
                            <pre>
                              {typeof activity.before === "string"
                                ? activity.before
                                : (JSON.stringify(activity.before, null, 2) ??
                                  "—")}
                            </pre>
                          </div>
                          <div>
                            <span>Depois</span>
                            <pre>
                              {typeof activity.after === "string"
                                ? activity.after
                                : (JSON.stringify(activity.after, null, 2) ??
                                  "—")}
                            </pre>
                          </div>
                        </div>
                      </details>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
          <div className="tp-footer-info">
            <span>Criada em {formatInstant(task.createdAt, timezone)}</span>
            <span>
              Última alteração: {formatInstant(task.updatedAt, timezone)}
            </span>
            {!readOnly && (
              <button
                className="tp-text-btn tp-danger-text"
                disabled={locked}
                onClick={() => setDialog("delete")}
              >
                <Trash2 size={13} />
                Mover para lixeira
              </button>
            )}
          </div>
        </div>
        <div className="tp-save-status" role="status" aria-live="polite">
          {busy ? (
            <>
              <LoaderCircle size={13} className="tp-spin" />
              Salvando…
            </>
          ) : hasDraft ? (
            <>
              <span className="tp-unsaved-dot" />
              Há alterações não salvas · rascunho neste dispositivo
            </>
          ) : (
            <>
              <Check size={13} />
              {saved || "Todas as alterações salvas"}
            </>
          )}
          {!unchangedMain && (
            <button
              className="tp-text-btn"
              disabled={locked}
              onClick={() => void saveMain()}
            >
              Salvar campos
            </button>
          )}
        </div>
      </aside>

      {dialog === "complete" && (
        <Modal
          title="Concluir tarefa"
          onClose={() => {
            if (!busy) setDialog(null);
          }}
        >
          <div className="tp-modal-body">
            <p>
              Registre o resultado de <strong>{task.title}</strong>.
            </p>
            <label>
              Resultado ou evidência{" "}
              {project?.requireEvidence ? (
                <span className="tp-required">obrigatório: texto ou link</span>
              ) : (
                <span className="tp-optional">opcional</span>
              )}
              <textarea
                rows={4}
                value={draft.completionNote}
                disabled={busy}
                onChange={(e) =>
                  updateDraft((d) => ({ ...d, completionNote: e.target.value }))
                }
                placeholder="O que foi entregue ou resolvido?"
              />
            </label>
            <label>
              Link da evidência
              <input
                type="url"
                value={draft.completionLink}
                disabled={busy}
                onChange={(e) =>
                  updateDraft((d) => ({ ...d, completionLink: e.target.value }))
                }
                placeholder="https://"
              />
            </label>
            {incomplete > 0 && (
              <div className="tp-alert tp-pending-warning">
                <span>
                  Há {incomplete} subtarefa{incomplete > 1 ? "s" : ""} pendente
                  {incomplete > 1 ? "s" : ""}. Elas continuarão abertas.
                </span>
                <label>
                  <input
                    type="checkbox"
                    checked={pendingConfirmed}
                    disabled={busy}
                    onChange={(e) => setPendingConfirmed(e.target.checked)}
                  />
                  Concluir somente a tarefa principal
                </label>
              </div>
            )}
            {error && (
              <p className="tp-modal-error" role="alert">
                {error}
              </p>
            )}
            <div className="tp-modal-actions">
              <button
                className="tp-btn"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                Cancelar
              </button>
              <button
                className="tp-btn tp-btn-primary"
                disabled={busy || (incomplete > 0 && !pendingConfirmed)}
                onClick={() => void complete()}
              >
                <Check size={16} />
                {busy ? "Concluindo…" : "Concluir tarefa"}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {dialog === "reopen" && (
        <Modal
          title="Reabrir tarefa"
          onClose={() => {
            if (!busy) setDialog(null);
          }}
        >
          <div className="tp-modal-body">
            <p>
              A conclusão anterior continuará no histórico. Escolha onde retomar
              esta tarefa.
            </p>
            <label>
              Destino
              <select
                value={reopenTo}
                disabled={busy}
                onChange={(e) => setReopenTo(e.target.value as ActiveSection)}
              >
                <option value="today">In Progress (Do Today)</option>
                <option value="backlog">Backlog</option>
                <option value="hold">Hold</option>
              </select>
            </label>
            {reopenTo === "today" && (
              <p className="tp-caption">
                A data planejada passa a ser hoje. O prazo permanece igual.
              </p>
            )}
            {error && (
              <p className="tp-modal-error" role="alert">
                {error}
              </p>
            )}
            <div className="tp-modal-actions">
              <button
                className="tp-btn"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                Cancelar
              </button>
              <button
                className="tp-btn tp-btn-primary"
                disabled={busy}
                onClick={async () => {
                  if (
                    await run({ action: "reopen", section: reopenTo }, ["hold"])
                  ) {
                    setDialog(null);
                    onNotice("Tarefa reaberta. O histórico foi preservado.");
                  }
                }}
              >
                <RotateCcw size={15} />
                Reabrir
              </button>
            </div>
          </div>
        </Modal>
      )}
      {dialog === "hold" && (
        <Modal title="Colocar tarefa em Hold" onClose={closeHoldDialog}>
          <div className="tp-modal-body">
            <p>
              Registre a dependência e quando acompanhar. A responsabilidade e o
              prazo não mudam.
            </p>
            <fieldset disabled={busy} className="tp-fieldset">
              {holdForm("modal")}
            </fieldset>
            <p className="tp-caption">
              Os campos são opcionais e podem ser preenchidos depois.
            </p>
            {error && (
              <p className="tp-modal-error" role="alert">
                {error}
              </p>
            )}
            <div className="tp-modal-actions">
              <button
                className="tp-btn"
                disabled={busy}
                onClick={closeHoldDialog}
              >
                Cancelar
              </button>
              <button
                className="tp-btn tp-btn-primary"
                disabled={busy}
                onClick={async () => {
                  if (
                    await run(
                      {
                        action: "move",
                        section: "hold",
                        ...draft.hold,
                        followUpDate: draft.hold.followUpDate || null,
                      },
                      ["hold"],
                    )
                  )
                    setDialog(null);
                }}
              >
                Mover para Hold
              </button>
            </div>
          </div>
        </Modal>
      )}
      {dialog === "leave" && (
        <Modal title="Há alterações não salvas" onClose={() => setDialog(null)}>
          <div className="tp-modal-body">
            <p>
              {storageError
                ? "O navegador não conseguiu guardar seu rascunho. Copie o conteúdo ou salve as alterações antes de fechar."
                : "Seu rascunho fica guardado neste navegador para continuar depois. Ele ainda não faz parte dos dados salvos nem do backup."}
            </p>
            <div className="tp-modal-actions tp-modal-actions-wrap">
              <button className="tp-btn" onClick={() => setDialog(null)}>
                Continuar editando
              </button>
              <button
                className="tp-btn tp-danger-text"
                onClick={() => {
                  skipPersist.current = true;
                  try {
                    localStorage.removeItem(keyFor(taskId));
                  } catch {
                    /* No persistent draft available. */
                  }
                  onClose();
                }}
              >
                Descartar rascunho
              </button>
              <button
                className="tp-btn tp-btn-primary"
                disabled={!!storageError}
                onClick={onClose}
              >
                Fechar e manter rascunho
              </button>
            </div>
          </div>
        </Modal>
      )}
      {dialog === "delete" && (
        <Modal
          title="Mover tarefa para a lixeira?"
          onClose={() => {
            if (!busy) setDialog(null);
          }}
        >
          <div className="tp-modal-body">
            <p>
              <strong>{task.title}</strong> poderá ser restaurada durante 30
              dias. Comentários e histórico serão preservados nesse período.
            </p>
            {error && (
              <p className="tp-modal-error" role="alert">
                {error}
              </p>
            )}
            <div className="tp-modal-actions">
              <button
                className="tp-btn"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                Cancelar
              </button>
              <button
                className="tp-btn tp-btn-danger"
                disabled={busy}
                onClick={async () => {
                  if (await run({ action: "delete" })) {
                    onNotice("Tarefa movida para a lixeira.");
                    onClose();
                  }
                }}
              >
                Mover para lixeira
              </button>
            </div>
          </div>
        </Modal>
      )}
      {deletingSubtask && (
        <Modal
          title="Excluir subtarefa?"
          onClose={() => {
            if (!busy) setDeletingSubtask(null);
          }}
        >
          <div className="tp-modal-body">
            <p>
              A subtarefa <strong>{deletingSubtask.title}</strong> será
              removida. Esta ação será registrada no histórico.
            </p>
            {error && (
              <p className="tp-modal-error" role="alert">
                {error}
              </p>
            )}
            <div className="tp-modal-actions">
              <button
                className="tp-btn"
                disabled={busy}
                onClick={() => setDeletingSubtask(null)}
              >
                Cancelar
              </button>
              <button
                className="tp-btn tp-btn-danger"
                disabled={busy}
                onClick={async () => {
                  if (
                    await run({
                      action: "subtaskDelete",
                      subtaskId: deletingSubtask.id,
                    })
                  )
                    setDeletingSubtask(null);
                }}
              >
                Excluir subtarefa
              </button>
            </div>
          </div>
        </Modal>
      )}
      {conflict && conflictOpen && (
        <Modal
          title="Esta tarefa foi alterada"
          onClose={() => setConflictOpen(false)}
          wide
        >
          <div className="tp-modal-body">
            <p>
              Seus textos foram preservados. A versão salva mudou em outra
              janela. Confira os campos abaixo antes de continuar; nenhuma
              alteração será enviada agora.
            </p>
            {hasRemovedSubtaskDrafts() && (
              <p className="tp-alert">
                Uma subtarefa editada no rascunho foi removida na versão salva.
                Seu texto será preservado no campo de novo comentário, sem envio
                automático.
              </p>
            )}
            {conflictItems().length ? (
              <div className="tp-conflict-list">
                {conflictItems().map((item) => (
                  <div className="tp-conflict-item" key={item.key}>
                    <strong>{item.label}</strong>
                    <div className="tp-conflict-options">
                      <label>
                        <input
                          type="radio"
                          name={`conflict-${item.key}`}
                          checked={!conflictChoices[item.key]}
                          onChange={() =>
                            setConflictChoices((c) => ({
                              ...c,
                              [item.key]: false,
                            }))
                          }
                        />
                        <span>
                          Versão salva<pre>{item.server || "Vazio"}</pre>
                        </span>
                      </label>
                      <label>
                        <input
                          type="radio"
                          name={`conflict-${item.key}`}
                          checked={!!conflictChoices[item.key]}
                          onChange={() =>
                            setConflictChoices((c) => ({
                              ...c,
                              [item.key]: true,
                            }))
                          }
                        />
                        <span>
                          Meu rascunho<pre>{item.local || "Vazio"}</pre>
                        </span>
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="tp-caption">
                Não há campos com alterações concorrentes. Seu rascunho será
                combinado com a versão atual para você revisar.
              </p>
            )}
            <div className="tp-modal-actions">
              <button
                className="tp-btn tp-btn-primary"
                onClick={resolveConflict}
              >
                Carregar escolhas e revisar
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
