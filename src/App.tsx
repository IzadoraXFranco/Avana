import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ArrowUpRight,
  BriefcaseBusiness,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Columns3,
  Ellipsis,
  FolderClosed,
  GripVertical,
  Hourglass,
  Inbox,
  LayoutList,
  ListFilter,
  LoaderCircle,
  Menu,
  MessageSquare,
  Moon,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Settings as SettingsIcon,
  Star,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import type {
  ActiveSection,
  Bootstrap,
  Project,
  Section,
  Task,
  TaskDetail,
  TaskCommand,
} from "./types";
import { api, command, getDetail, getApiMode, getDataScope, scopedStorageKey } from "./api";
import { serverClockOffset } from "../shared/clock";
import { getCloudUiState } from "./cloud";
import {
  formatDate,
  formatInstant,
  isOverdue,
  priorityLabels,
  sectionLabels,
  sectionOf,
  today,
} from "./dates";
import Modal from "./Modal";
import SettingsModal from "./SettingsModal";
import TaskPanel from "./TaskPanel";
import PrioritySelect from "./PrioritySelect";
import ExecutionOrderCell from "./ExecutionOrderCell";
import { sortLabels, sortTasks, type TaskSort } from "./taskOrder";

const sections: Section[] = ["backlog", "hold", "today", "doneToday", "done"];
const sectionIcons = {
  backlog: Inbox,
  hold: Hourglass,
  today: Sun,
  doneToday: CircleCheck,
  done: CheckCheck,
};
const sectionHints = {
  backlog: "O que vem depois começa aqui.",
  hold: "Dependências e respostas que você está aguardando.",
  today: "Seu plano de trabalho. Uma tarefa de cada vez.",
  doneToday: "As entregas que você concluiu hoje.",
  done: "Seu histórico de entregas, sempre por perto.",
};
const readPreference = <T,>(key: string, fallback: T): T => {
  try {
    return (
      JSON.parse(localStorage.getItem(scopedStorageKey(`avana.${key}`)) || "null") ?? fallback
    );
  } catch {
    return fallback;
  }
};
const writePreference = (key: string, value: unknown) => {
  try {
    localStorage.setItem(scopedStorageKey(`avana.${key}`), JSON.stringify(value));
  } catch {
    /* Display preferences are optional; task data remains in SQLite. */
  }
};

export default function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [loadError, setLoadError] = useState("");
  const [projectId, setProjectId] = useState<string>(() =>
    readPreference("project", ""),
  );
  const [page, setPage] = useState<"project" | "projects" | "favorites">(
    "project",
  );
  const [taskId, setTaskId] = useState<string | null>(() =>
    new URLSearchParams(location.search).get("task"),
  );
  const [sidebar, setSidebar] = useState(
    () => window.innerWidth > 800 && readPreference("sidebar", true),
  );
  const [q, setQ] = useState("");
  const [view, setView] = useState<"list" | "followups">("list");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    readPreference("collapsed", { done: true }),
  );
  const [columns, setColumns] = useState<Record<string, boolean>>(() => ({
    execution: true,
    assignee: true,
    priority: true,
    planned: true,
    due: true,
    followup: true,
    holdReason: true,
    completed: true,
    ...readPreference<Record<string, boolean>>("columns", {}),
  }));
  const [sort, setSort] = useState<TaskSort>("manual");
  const [priority, setPriority] = useState("all");
  const [onlyLate, setOnlyLate] = useState(false);
  const [popover, setPopover] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [projectForm, setProjectForm] = useState<Project | "new" | null>(null);
  const [newTask, setNewTask] = useState<ActiveSection | null>(null);
  const [complete, setComplete] = useState<Task | null>(null);
  const [hold, setHold] = useState<Task | null>(null);
  const [deleteTask, setDeleteTask] = useState<Task | null>(null);
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, TaskDetail>>({});
  const [limits, setLimits] = useState<Record<string, number>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const alive = useRef(true);
  const reloadGeneration = useRef(0);
  const serverOffset = useRef(0);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const [cloudState, setCloudState] = useState(getCloudUiState);
  const notice = useCallback((s: string) => setToast(s), []);
  const reload = useCallback(async () => {
    const generation = ++reloadGeneration.current;
    const scope = getDataScope();
    const sentAt = Date.now();
    const next = await api<Bootstrap>("/bootstrap");
    if (!alive.current || generation !== reloadGeneration.current || scope !== getDataScope()) return;
    serverOffset.current = serverClockOffset(next.serverTime, sentAt, Date.now()) ?? serverOffset.current;
    setData(next);
    setLoadError("");
    setProjectId((current) =>
      next.projects.some((p) => p.id === current && !p.deletedAt)
        ? current
        : next.projects.find((p) => !p.deletedAt && !p.archivedAt)?.id || "",
    );
    window.dispatchEvent(new Event("avana:data-changed"));
    const staleExpanded = Object.entries(expandedRef.current).filter(([id, detail]) => next.tasks.find(task => task.id === id)?.version !== detail.task.version);
    if (staleExpanded.length) {
      const refreshed = await Promise.allSettled(staleExpanded.map(([id]) => getDetail(id)));
      if (!alive.current || generation !== reloadGeneration.current || scope !== getDataScope()) return;
      setExpanded(previous => {
        const updated = { ...previous };
        refreshed.forEach((result, index) => {
          const id = staleExpanded[index][0];
          if (!(id in updated)) return;
          if (result.status === "fulfilled" && (!updated[id] || result.value.task.version >= updated[id].task.version)) updated[id] = result.value;
          else if (result.status === "rejected") delete updated[id];
        });
        return updated;
      });
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    reload().catch((e) => setLoadError(e.message));
    const timer = setInterval(() => setTick((t) => t + 1), 30000);
    const focus = () => {
      setTick((t) => t + 1);
      void reload().catch(() => {});
    };
    window.addEventListener("focus", focus);
    const visible = () => {
      if (document.visibilityState === "visible") focus();
    };
    document.addEventListener("visibilitychange", visible);
    let remoteTimer: ReturnType<typeof setTimeout> | undefined;
    const remote = () => {
      clearTimeout(remoteTimer);
      remoteTimer = setTimeout(() => { void reload().catch(() => {}); }, 120);
    };
    const syncState = () => setCloudState(getCloudUiState());
    window.addEventListener("avana:remote-change", remote);
    window.addEventListener("avana:cloud-status", syncState);
    return () => {
      alive.current = false; reloadGeneration.current += 1;
      clearInterval(timer);
      clearTimeout(remoteTimer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("avana:remote-change", remote);
      window.removeEventListener("avana:cloud-status", syncState);
    };
  }, [reload]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    writePreference("project", projectId);
  }, [projectId]);
  useEffect(() => {
    writePreference("sidebar", sidebar);
  }, [sidebar]);
  useEffect(() => {
    const media = matchMedia("(max-width: 800px)");
    const collapse = () => {
      if (media.matches) setSidebar(false);
    };
    media.addEventListener("change", collapse);
    return () => media.removeEventListener("change", collapse);
  }, []);
  useEffect(() => {
    writePreference("columns", columns);
  }, [columns]);
  useEffect(() => {
    writePreference("collapsed", collapsed);
  }, [collapsed]);
  useEffect(() => {
    const theme = data?.settings.theme || "system";
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      (document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [data?.settings.theme]);
  useEffect(() => {
    const pop = () =>
      setTaskId(new URLSearchParams(location.search).get("task"));
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const editable =
        ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) ||
        el.isContentEditable;
      if (!editable && !document.querySelector('[aria-modal="true"]')) {
        if (e.key === "/") {
          e.preventDefault();
          searchRef.current?.focus();
        }
        if (e.key === "n" && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          setNewTask("backlog");
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const now = new Date(Date.now() + serverOffset.current);
  const day = data ? today(data.settings.timezone, now) : today();
  void tick;
  const project = data?.projects.find((p) => p.id === projectId);
  const activeProjects =
    data?.projects.filter((p) => !p.deletedAt && !p.archivedAt) || [];
  const baseTasks = useMemo(() => {
    if (!data) return [];
    return data.tasks.filter(
      (t) =>
        !t.deletedAt &&
        (q
          ? data.projects.some((p) => p.id === t.projectId && !p.deletedAt)
          : t.projectId === projectId),
    );
  }, [data, projectId, q]);
  const visibleTasks = useMemo(() => {
    const norm = (s: string) =>
      s
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
    return baseTasks.filter(
      (t) =>
        (!q || norm(t.title).includes(norm(q))) &&
        (priority === "all" || t.priority === priority) &&
        (!onlyLate || isOverdue(t, day, now)),
    );
  }, [baseTasks, q, priority, onlyLate, day, tick]);
  const filtered = !!q || priority !== "all" || onlyLate;
  const canReorder = sort === "manual" && !filtered && !project?.archivedAt;
  const opened = baseTasks.filter((t) => !t.completedAt).length;
  const doneCount = baseTasks.filter(
    (t) => sectionOf(t, day, data?.settings.timezone) === "doneToday",
  ).length;
  const selected = baseTasks.filter((t) => t.section === "today").length;
  const overdue = baseTasks.filter((t) => isOverdue(t, day, now)).length;
  const openTask = (id: string) => {
    lastFocus.current = document.activeElement as HTMLElement;
    setTaskId(id);
    const url = new URL(location.href);
    url.searchParams.set("task", id);
    history.pushState({}, "", url);
  };
  const closeTask = () => {
    setTaskId(null);
    const url = new URL(location.href);
    url.searchParams.delete("task");
    history.pushState({}, "", url);
    setTimeout(() => lastFocus.current?.focus(), 20);
  };
  const selectProject = (id: string) => {
    if (window.innerWidth <= 800) setSidebar(false);
    setProjectId(id);
    setPage("project");
    setQ("");
    setView("list");
    setPriority("all");
    setOnlyLate(false);
    setPopover(null);
  };
  const perform = async (task: Task, action: TaskCommand, message?: string) => {
    setBusy(true);
    try {
      const detail = await command(task, action);
      try { await reload(); }
      catch { notice("A alteração foi salva. A lista será atualizada quando a conexão voltar."); }
      if (expanded[task.id]) setExpanded((e) => ({ ...e, [task.id]: detail }));
      if (message) notice(message);
      return detail;
    } catch (e) {
      notice((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
      setMenu(null);
    }
  };
  const move = (task: Task, section: ActiveSection) => {
    if (section === "hold") {
      setHold(task);
      setMenu(null);
      return;
    }
    void perform(
      task,
      { action: task.completedAt ? "reopen" : "move", section },
      section === "today"
        ? "Tarefa planejada para hoje."
        : "Tarefa movida para Backlog.",
    ).catch(() => {});
  };
  const toggleSubtasks = async (task: Task) => {
    if (expanded[task.id]) {
      setExpanded((e) => {
        const copy = { ...e };
        delete copy[task.id];
        return copy;
      });
      return;
    }
    try {
      const detail = await getDetail(task.id);
      setExpanded((e) => ({ ...e, [task.id]: detail }));
    } catch (e) {
      notice((e as Error).message);
    }
  };
  const toggleTheme = async () => {
    const theme =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    try {
      await api("/settings", {
        method: "PATCH",
        body: JSON.stringify({ theme }),
      });
      await reload();
    } catch (e) {
      notice((e as Error).message);
    }
  };
  const sorted = (tasks: Task[], section: Section) =>
    sortTasks(tasks, sort, section);
  const drop = async (
    e: React.DragEvent,
    section: Section,
    beforeId?: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const id = e.dataTransfer.getData("text/avana-task");
    const task = data?.tasks.find((t) => t.id === id);
    if (!task || project?.archivedAt || q) return;
    if (section === "done") {
      notice("Done é definido pela data real de conclusão.");
      return;
    }
    if (section === "doneToday") {
      if (!task.completedAt) setComplete(task);
      else notice("A data de conclusão é preservada.");
      return;
    }
    if (task.section === section && !task.completedAt) {
      if (canReorder && id !== beforeId)
        await perform(task, {
          action: "reorder",
          beforeId: beforeId || null,
        }).catch(() => {});
    } else move(task, section);
  };
  const gridStyle = {
    "--task-columns": `minmax(280px, 1fr) ${columns.execution ? "145px " : ""}${columns.priority ? "150px " : ""}${columns.assignee ? "100px " : ""}${columns.planned ? "132px " : ""}${columns.due ? "132px " : ""}${columns.followup ? "132px " : ""}${columns.holdReason ? "190px " : ""}${columns.completed ? "170px " : ""}36px`,
  } as React.CSSProperties;
  const row = (task: Task) => {
    const archived = !!data?.projects.find((p) => p.id === task.projectId)
      ?.archivedAt;
    return (
      <div className="task-block" key={task.id}>
        <div
          className={`task-row ${task.completedAt ? "completed" : ""} ${taskId === task.id ? "selected" : ""}`}
          style={gridStyle}
          draggable={!archived && !q}
          onDragStart={(e) => {
            e.dataTransfer.setData("text/avana-task", task.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => {
            if (!archived) e.preventDefault();
          }}
          onDrop={(e) =>
            void drop(e, sectionOf(task, day, data!.settings.timezone), task.id)
          }
        >
          <div className="task-name-cell">
            <span
              className={`drag-handle ${!canReorder ? "dim" : ""}`}
              title={
                canReorder
                  ? "Arraste para reordenar"
                  : "Use a ordem manual, sem filtros, para reordenar"
              }
            >
              <GripVertical size={14} />
            </span>
            <button
              className={`completion-check ${task.completedAt ? "checked" : ""}`}
              aria-label={`${task.completedAt ? "Reabrir" : "Concluir"} ${task.title}`}
              disabled={busy || archived}
              onClick={() =>
                task.completedAt ? openTask(task.id) : setComplete(task)
              }
            >
              {task.completedAt && <Check size={13} />}
            </button>
            {task.subtaskCount > 0 && (
              <button
                className="subtask-chevron"
                aria-label={`${expanded[task.id] ? "Recolher" : "Expandir"} subtarefas de ${task.title}`}
                onClick={() => void toggleSubtasks(task)}
              >
                {expanded[task.id] ? (
                  <ChevronDown size={13} />
                ) : (
                  <ChevronRight size={13} />
                )}
              </button>
            )}
            <div className="task-title-wrap">
              <button className="task-title" onClick={() => openTask(task.id)}>
                {task.title}
              </button>
              {q && (
                <small>
                  {data?.projects.find((p) => p.id === task.projectId)?.name}
                </small>
              )}
              {task.section === "today" &&
                task.plannedDate &&
                task.plannedDate < day && (
                  <small className="review-label">
                    Planejada em {formatDate(task.plannedDate)} · revisar
                  </small>
                )}
              {task.section === "hold" && task.waitingFor && (
                <small>Aguardando {task.waitingFor}</small>
              )}
            </div>
            <div className="row-indicators">
              {task.subtaskCount > 0 && (
                <span title="Subtarefas concluídas">
                  <LayoutList size={12} />
                  {task.subtaskDone}/{task.subtaskCount}
                </span>
              )}
              {task.commentCount > 0 && (
                <span title="Comentários">
                  <MessageSquare size={12} />
                  {task.commentCount}
                </span>
              )}
              {isOverdue(task, day, now) && (
                <span className="late-tag">Atrasada</span>
              )}
            </div>
          </div>
          {columns.execution && (
            <ExecutionOrderCell
              taskId={task.id}
              title={task.title}
              value={task.executionOrder}
              disabled={busy || archived}
              onSave={(executionOrder) =>
                perform(task, { action: "edit", fields: { executionOrder } })
              }
            />
          )}
          {columns.priority && (
            <div>
              <PrioritySelect
                aria-label={`Prioridade de ${task.title}`}
                value={task.priority}
                disabled={busy || archived}
                onChange={(priority) =>
                  void perform(task, {
                    action: "edit",
                    fields: { priority },
                  }).catch(() => {})
                }
              />
            </div>
          )}
          {columns.assignee && (
            <div className="assignee-cell">
              <span
                className="avatar tiny"
                title={task.assignee || "Sem responsável"}
              >
                {task.assignee ? task.assignee[0].toUpperCase() : "—"}
              </span>
              <span>
                {task.assignee === data?.settings.name ||
                task.assignee === "Você"
                  ? "Você"
                  : task.assignee || "—"}
              </span>
            </div>
          )}
          {columns.planned && (
            <div className="date-cell">
              <input
                type="date"
                aria-label={`Data planejada de ${task.title}`}
                value={task.plannedDate || ""}
                disabled={busy || archived}
                onChange={(e) =>
                  void perform(task, {
                    action: "edit",
                    fields: { plannedDate: e.target.value || null },
                  }).catch(() => {})
                }
              />
            </div>
          )}
          {columns.due && (
            <div
              className={`date-cell ${isOverdue(task, day, now) ? "overdue" : ""}`}
            >
              <input
                type="date"
                aria-label={`Prazo de ${task.title}`}
                title={
                  task.dueTime
                    ? `Prazo às ${task.dueTime} (${task.dueTimezone})`
                    : undefined
                }
                value={task.dueDate || ""}
                disabled={busy || archived}
                onChange={(e) =>
                  void perform(task, {
                    action: "edit",
                    fields: { dueDate: e.target.value || null },
                  }).catch(() => {})
                }
              />
            </div>
          )}
          {columns.followup && (
            <div
              className={`date-cell ${task.followUpDate && task.followUpDate < day && !task.completedAt ? "overdue" : ""}`}
            >
              <input
                type="date"
                aria-label={`Follow-up de ${task.title}`}
                value={task.followUpDate || ""}
                disabled={busy || archived || !!task.completedAt}
                onChange={(e) =>
                  void perform(task, {
                    action: "followup",
                    date: e.target.value || null,
                  }).catch(() => {})
                }
              />
            </div>
          )}
          {columns.holdReason && (
            <div className="hold-reason-cell">
              {task.section === "hold" && !archived ? (
                <button
                  className="hold-reason-button"
                  aria-label={`Editar motivo da espera de ${task.title}`}
                  title={task.holdReason || "Adicionar motivo da espera"}
                  onClick={() => setHold(task)}
                >
                  {task.holdReason || "Adicionar motivo…"}
                </button>
              ) : (
                <span title={task.holdReason || "Sem espera ativa"}>
                  {task.holdReason || "—"}
                </span>
              )}
            </div>
          )}
          {columns.completed && (
            <div className="completion-date-cell">
              {task.completedAt ? (
                <time
                  dateTime={task.completedAt}
                  title={`Conclusão registrada em ${formatInstant(task.completedAt, data!.settings.timezone)} (${data!.settings.timezone})`}
                >
                  {formatInstant(task.completedAt, data!.settings.timezone)}
                </time>
              ) : (
                <span title="Ainda não concluída">—</span>
              )}
            </div>
          )}
          <div className="task-menu-wrap">
            <button
              className="icon-button row-more"
              aria-label={`Ações de ${task.title}`}
              onClick={() => setMenu(menu === task.id ? null : task.id)}
            >
              <Ellipsis size={17} />
            </button>
            {menu === task.id && (
              <div className="dropdown row-dropdown">
                <button
                  onClick={() => {
                    setMenu(null);
                    openTask(task.id);
                  }}
                >
                  <Pencil size={14} />
                  Abrir e editar
                </button>
                {!archived && (
                  <>
                    <span className="dropdown-caption">
                      {task.completedAt ? "Reabrir em" : "Mover para"}
                    </span>
                    <button onClick={() => move(task, "backlog")}>
                      <Inbox size={14} />
                      Backlog
                    </button>
                    <button onClick={() => move(task, "hold")}>
                      <Hourglass size={14} />
                      Hold
                    </button>
                    <button onClick={() => move(task, "today")}>
                      <Sun size={14} />
                      Planejar para hoje
                    </button>
                    {!task.completedAt && (
                      <button
                        onClick={() => {
                          setComplete(task);
                          setMenu(null);
                        }}
                      >
                        <CircleCheck size={14} />
                        Concluir tarefa
                      </button>
                    )}
                    {canReorder && !task.completedAt && (
                      <>
                        <button
                          onClick={() => {
                            const list = sorted(
                              baseTasks.filter(
                                (t) =>
                                  t.section === task.section && !t.completedAt,
                              ),
                              task.section!,
                            );
                            const index = list.findIndex(
                              (t) => t.id === task.id,
                            );
                            if (index > 0)
                              void perform(task, {
                                action: "reorder",
                                beforeId: list[index - 1].id,
                              }).catch(() => {});
                          }}
                        >
                          <ArrowUp size={14} />
                          Mover para cima
                        </button>
                        <button
                          onClick={() => {
                            const list = sorted(
                              baseTasks.filter(
                                (t) =>
                                  t.section === task.section && !t.completedAt,
                              ),
                              task.section!,
                            );
                            const index = list.findIndex(
                              (t) => t.id === task.id,
                            );
                            if (index < list.length - 1)
                              void perform(task, {
                                action: "reorder",
                                beforeId: list[index + 2]?.id || null,
                              }).catch(() => {});
                          }}
                        >
                          <ArrowDown size={14} />
                          Mover para baixo
                        </button>
                      </>
                    )}
                    <button
                      className="danger-text"
                      onClick={() => {
                        setDeleteTask(task);
                        setMenu(null);
                      }}
                    >
                      <Trash2 size={14} />
                      Excluir tarefa
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        {expanded[task.id] && (
          <div className="inline-subtasks">
            {expanded[task.id].subtasks.map((sub) => (
              <div key={sub.id}>
                <button
                  className={`completion-check ${sub.completedAt ? "checked" : ""}`}
                  aria-label={`${sub.completedAt ? "Reabrir" : "Concluir"} subtarefa ${sub.title}`}
                  disabled={busy || archived}
                  onClick={() =>
                    void perform(task, {
                      action: "subtaskEdit",
                      subtaskId: sub.id,
                      fields: { completed: !sub.completedAt },
                    }).catch(() => {})
                  }
                >
                  {sub.completedAt && <Check size={12} />}
                </button>
                <span>{sub.title}</span>
                {sub.dueDate && <small>{formatDate(sub.dueDate)}</small>}
              </div>
            ))}
            <button className="text-button" onClick={() => openTask(task.id)}>
              <Plus size={13} />
              Gerenciar subtarefas
            </button>
          </div>
        )}
      </div>
    );
  };
  if (!data)
    return (
      <div className="loading-screen">
        <div className="brand-mark">A</div>
        <h1>Avana</h1>
        {loadError ? (
          <>
            <p role="alert">{loadError}</p>
            <button
              className="primary-button"
              onClick={() =>
                void reload().catch((e) => setLoadError(e.message))
              }
            >
              Tentar novamente
            </button>
          </>
        ) : (
          <>
            <LoaderCircle className="spin" size={20} />
            <p>Preparando seu espaço…</p>
          </>
        )}
      </div>
    );
  return (
    <div className={`app-shell ${sidebar ? "" : "sidebar-collapsed"}`}>
      {sidebar && (
        <button
          className="mobile-nav-dismiss"
          aria-label="Fechar navegação"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <span>
            avana<span className="brand-dot">.</span>
          </span>
          <button
            className="icon-button sidebar-toggle"
            aria-label="Recolher navegação"
            onClick={() => setSidebar(false)}
          >
            <PanelLeftClose size={17} />
          </button>
        </div>
        <div className="workspace-label">
          <span className="workspace-icon">A</span>
          <div>
            <strong>Meu espaço</strong>
            <small>Organização pessoal</small>
          </div>
        </div>
        <nav aria-label="Navegação principal">
          <button
            className={`nav-item ${page === "projects" ? "active" : ""}`}
            onClick={() => {
              setPage("projects");
              setQ("");
            }}
          >
            <FolderClosed size={18} />
            Projetos<span className="nav-count">{activeProjects.length}</span>
          </button>
          <button
            className={`nav-item ${page === "favorites" ? "active" : ""}`}
            onClick={() => {
              setPage("favorites");
              setQ("");
            }}
          >
            <Star size={18} />
            Favoritos
          </button>
        </nav>
        <div className="sidebar-heading">
          <span>MEUS PROJETOS</span>
          <button
            className="icon-button"
            aria-label="Criar projeto"
            onClick={() => setProjectForm("new")}
          >
            <Plus size={15} />
          </button>
        </div>
        <nav className="project-nav" aria-label="Projetos">
          {activeProjects.map((p) => (
            <button
              key={p.id}
              className={`nav-item project-link ${page === "project" && projectId === p.id ? "active" : ""}`}
              onClick={() => selectProject(p.id)}
            >
              <span className="project-dot" style={{ background: p.color }} />
              <span>{p.name}</span>
              {p.favorite && <Star className="favorite-star" size={12} />}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="cloud-sync-state" title={cloudState.email || "Dados neste computador"}><span />{getApiMode() === "cloud" ? cloudState.connection === "connected" ? "Sincronização conectada" : "Reconectando sincronização…" : "Armazenamento local"}</div>
          <button className="nav-item" onClick={() => setSettings(true)}>
            <SettingsIcon size={18} />
            Configurações
          </button>
          <div className="profile">
            <span className="avatar">
              {data.settings.name[0]?.toUpperCase() || "V"}
            </span>
            <div>
              <strong>{data.settings.name}</strong>
              <small>Seu espaço de trabalho</small>
            </div>
            <button
              className="icon-button"
              aria-label="Alternar tema"
              onClick={() => void toggleTheme()}
            >
              {document.documentElement.dataset.theme === "dark" ? (
                <Sun size={16} />
              ) : (
                <Moon size={16} />
              )}
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button"
              aria-label={sidebar ? "Recolher navegação" : "Expandir navegação"}
              onClick={() => setSidebar(!sidebar)}
            >
              <Menu size={18} />
            </button>
            <span>Meu espaço</span>
            <ChevronRight size={13} />
            <strong>
              {q
                ? "Busca"
                : page === "project"
                  ? project?.name || "Projetos"
                  : page === "favorites"
                    ? "Favoritos"
                    : "Projetos"}
            </strong>
          </div>
          <div className="global-search">
            <Search size={16} />
            <input
              ref={searchRef}
              aria-label="Buscar tarefas"
              placeholder="Buscar tarefas…"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage("project");
              }}
            />
            {q ? (
              <button
                className="icon-button"
                aria-label="Limpar busca"
                onClick={() => setQ("")}
              >
                <X size={13} />
              </button>
            ) : (
              <kbd>/</kbd>
            )}
          </div>
          <button
            className="top-create"
            aria-label="Criar tarefa"
            onClick={() => setNewTask("backlog")}
            disabled={!activeProjects.length}
          >
            <Plus size={17} />
            <span>Criar tarefa</span>
          </button>
          <span className="avatar top-avatar">
            {data.settings.name[0]?.toUpperCase() || "V"}
          </span>
        </header>
        {(page === "projects" || page === "favorites") && !q ? (
          <main className="projects-page">
            <div className="page-eyebrow">SEU ESPAÇO, DO SEU JEITO</div>
            <div className="projects-heading">
              <div>
                <h1>{page === "favorites" ? "Favoritos" : "Projetos"}</h1>
                <p>
                  {page === "favorites"
                    ? "Os projetos que você quer manter por perto."
                    : "Um lugar para cada frente do seu trabalho."}
                </p>
              </div>
              <button
                className="primary-button"
                onClick={() => setProjectForm("new")}
              >
                <Plus size={16} />
                Novo projeto
              </button>
            </div>
            <div className="project-grid">
              {data.projects
                .filter(
                  (p) => !p.deletedAt && (page !== "favorites" || p.favorite),
                )
                .map((p) => (
                  <article
                    className={`project-card ${p.archivedAt ? "archived" : ""}`}
                    key={p.id}
                  >
                    <div className="project-card-top">
                      <button
                        className="project-icon"
                        style={{ color: p.color }}
                        aria-label={`Abrir ${p.name}`}
                        onClick={() => selectProject(p.id)}
                      >
                        <BriefcaseBusiness size={24} />
                      </button>
                      <button
                        className={`icon-button ${p.favorite ? "starred" : ""}`}
                        aria-label={`${p.favorite ? "Remover" : "Adicionar"} ${p.name} ${p.favorite ? "dos" : "aos"} favoritos`}
                        onClick={() =>
                          void api(`/projects/${p.id}`, {
                            method: "PATCH",
                            body: JSON.stringify({ favorite: !p.favorite }),
                          })
                            .then(reload)
                            .catch((e) => notice(e.message))
                        }
                      >
                        <Star size={17} />
                      </button>
                    </div>
                    <button
                      className="project-card-name"
                      onClick={() => selectProject(p.id)}
                    >
                      {p.name}
                    </button>
                    <p>
                      {p.description ||
                        "Organize tarefas, acompanhe pendências e registre suas entregas."}
                    </p>
                    <footer>
                      <span>
                        {p.archivedAt
                          ? "Arquivado"
                          : `${data.tasks.filter((t) => t.projectId === p.id && !t.deletedAt && !t.completedAt).length} tarefas abertas`}
                      </span>
                      <button
                        className="icon-button"
                        aria-label={`Editar projeto ${p.name}`}
                        onClick={() => setProjectForm(p)}
                      >
                        <Ellipsis size={19} />
                      </button>
                    </footer>
                  </article>
                ))}
              <button
                className="new-project-card"
                onClick={() => setProjectForm("new")}
              >
                <span>
                  <Plus size={24} />
                </span>
                Criar um novo projeto
              </button>
            </div>
          </main>
        ) : (
          <main className="project-page">
            <div className="project-header">
              <div className="project-title-group">
                <div
                  className="project-icon"
                  style={{ color: project?.color || "#8b6bc4" }}
                >
                  {q ? <Search size={26} /> : <BriefcaseBusiness size={26} />}
                </div>
                <div>
                  <div className="project-title-row">
                    <h1>
                      {q
                        ? "Resultados da busca"
                        : project?.name || "Seu trabalho"}
                    </h1>
                    {!q && project && (
                      <>
                        <button
                          className={`icon-button ${project.favorite ? "starred" : ""}`}
                          aria-label={
                            project.favorite
                              ? "Remover dos favoritos"
                              : "Favoritar projeto"
                          }
                          onClick={() =>
                            void api(`/projects/${project.id}`, {
                              method: "PATCH",
                              body: JSON.stringify({
                                favorite: !project.favorite,
                              }),
                            })
                              .then(reload)
                              .catch((e) => notice(e.message))
                          }
                        >
                          <Star size={17} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label="Configurar projeto"
                          onClick={() => setProjectForm(project)}
                        >
                          <Ellipsis size={19} />
                        </button>
                      </>
                    )}
                  </div>
                  <p>
                    {q
                      ? `${visibleTasks.length} resultado(s) em seus projetos`
                      : project?.description ||
                        "Organize o dia. Acompanhe o que importa."}
                  </p>
                </div>
              </div>
              <div className="project-stats">
                <span>
                  <i className="stat-dot" />
                  {opened} abertas
                </span>
                <span>
                  <CircleCheck size={14} />
                  {doneCount} concluídas hoje
                </span>
              </div>
            </div>
            <div className="project-tabs">
              <button
                className={view === "list" ? "active" : ""}
                onClick={() => setView("list")}
              >
                <LayoutList size={16} />
                Lista
              </button>
              <button
                className={view === "followups" ? "active" : ""}
                onClick={() => setView("followups")}
              >
                <CalendarDays size={16} />
                Acompanhamentos
                {baseTasks.some((t) => t.followUpDate && !t.completedAt) && (
                  <span className="tab-count">
                    {
                      baseTasks.filter((t) => t.followUpDate && !t.completedAt)
                        .length
                    }
                  </span>
                )}
              </button>
              <span className="today-date">
                {new Intl.DateTimeFormat("pt-BR", {
                  day: "numeric",
                  month: "long",
                  timeZone: data.settings.timezone,
                }).format(new Date())}
              </span>
            </div>
            {project?.archivedAt && !q && (
              <div className="archive-banner">
                <Archive size={16} />
                Este projeto está arquivado. O histórico continua disponível.
                <button
                  className="text-button"
                  onClick={() =>
                    void api(`/projects/${project.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ archived: false }),
                    })
                      .then(reload)
                      .catch((e) => notice(e.message))
                  }
                >
                  Restaurar projeto
                </button>
              </div>
            )}
            <div className="list-toolbar">
              <button
                className="primary-button"
                disabled={!!project?.archivedAt || !project}
                onClick={() => setNewTask("backlog")}
              >
                <Plus size={16} />
                Adicionar tarefa
              </button>
              <div className="toolbar-spacer" />
              <div className="popover-wrap">
                <button
                  className={`toolbar-button ${filtered ? "active" : ""}`}
                  onClick={() =>
                    setPopover(popover === "filters" ? null : "filters")
                  }
                >
                  <ListFilter size={15} />
                  Filtrar
                  {(priority !== "all" || onlyLate) && (
                    <span className="filter-dot" />
                  )}
                </button>
                {popover === "filters" && (
                  <div className="dropdown filter-dropdown">
                    <label>
                      Prioridade
                      <select
                        value={priority}
                        onChange={(e) => setPriority(e.target.value)}
                      >
                        <option value="all">Todas as prioridades</option>
                        {Object.entries(priorityLabels).map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={onlyLate}
                        onChange={(e) => setOnlyLate(e.target.checked)}
                      />
                      Somente atrasadas
                    </label>
                    <button
                      onClick={() => {
                        setPriority("all");
                        setOnlyLate(false);
                        setPopover(null);
                      }}
                    >
                      Limpar filtros
                    </button>
                  </div>
                )}
              </div>
              <div className="sort-control">
                <ArrowUpDown size={14} />
                <select
                  aria-label="Ordenar tarefas"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as TaskSort)}
                >
                  {Object.entries(sortLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="popover-wrap">
                <button
                  className="toolbar-button"
                  aria-label="Mostrar ou ocultar colunas"
                  onClick={() =>
                    setPopover(popover === "columns" ? null : "columns")
                  }
                >
                  <Columns3 size={15} />
                  <span>Colunas</span>
                </button>
                {popover === "columns" && (
                  <div className="dropdown columns-dropdown">
                    {Object.entries({
                      execution: "Ordem de execução",
                      priority: "Prioridade",
                      assignee: "Responsável",
                      planned: "Data planejada",
                      due: "Prazo",
                      followup: "Follow-up",
                      holdReason: "Motivo da espera",
                      completed: "Data de conclusão",
                    }).map(([key, label]) => (
                      <label key={key} className="check-label">
                        <input
                          type="checkbox"
                          checked={columns[key]}
                          onChange={(e) =>
                            setColumns({ ...columns, [key]: e.target.checked })
                          }
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {sort !== "manual" && (
              <div className="order-notice">
                {sortLabels[sort]}. A ordenação vale dentro de cada seção.{" "}
                <button
                  className="text-button"
                  onClick={() => setSort("manual")}
                >
                  Voltar à ordem manual para reordenar
                </button>
              </div>
            )}
            {(onlyLate || priority !== "all") && (
              <div className="filter-chips">
                {onlyLate && (
                  <button onClick={() => setOnlyLate(false)}>
                    Atrasadas
                    <X size={12} />
                  </button>
                )}
                {priority !== "all" && (
                  <button onClick={() => setPriority("all")}>
                    {priorityLabels[priority]}
                    <X size={12} />
                  </button>
                )}
                <span>{visibleTasks.length} tarefas encontradas</span>
              </div>
            )}
            {view === "list" ? (
              <div className="list-scroll">
                <div className="task-table" style={gridStyle}>
                  <div className="table-head">
                    <span>Nome da tarefa</span>
                    {columns.execution && (
                      <button
                        className={`column-sort ${sort.startsWith("execution") ? "active" : ""}`}
                        aria-label={`Ordenar por ordem de execução ${sort === "execution" ? "decrescente" : "crescente"}`}
                        onClick={() =>
                          setSort(
                            sort === "execution"
                              ? "executionDesc"
                              : "execution",
                          )
                        }
                      >
                        Ordem de execução
                        {sort === "execution" ? (
                          <ArrowUp size={13} />
                        ) : sort === "executionDesc" ? (
                          <ArrowDown size={13} />
                        ) : (
                          <ArrowUpDown size={13} />
                        )}
                      </button>
                    )}
                    {columns.priority && (
                      <button
                        className={`column-sort ${sort === "priority" ? "active" : ""}`}
                        onClick={() => setSort("priority")}
                        aria-label="Ordenar por prioridade"
                      >
                        Prioridade <ArrowUpDown size={13} />
                      </button>
                    )}
                    {columns.assignee && <span>Responsável</span>}
                    {columns.planned && <span>Data planejada</span>}
                    {columns.due && <span>Prazo</span>}
                    {columns.followup && <span>Follow-up</span>}
                    {columns.holdReason && <span>Motivo da espera</span>}
                    {columns.completed && (
                      <button
                        className={`column-sort ${sort.startsWith("completion") ? "active" : ""}`}
                        aria-label={`Ordenar por conclusão ${sort === "completion" ? "mais antiga" : "mais recente"}`}
                        onClick={() =>
                          setSort(
                            sort === "completion"
                              ? "completionAsc"
                              : "completion",
                          )
                        }
                      >
                        Data de conclusão{" "}
                        {sort === "completion" ? (
                          <ArrowDown size={13} />
                        ) : sort === "completionAsc" ? (
                          <ArrowUp size={13} />
                        ) : (
                          <ArrowUpDown size={13} />
                        )}
                      </button>
                    )}
                    <span />
                  </div>
                  {sections.map((section) => {
                    const Icon = sectionIcons[section];
                    const tasks = sorted(
                      visibleTasks.filter(
                        (t) =>
                          sectionOf(t, day, data.settings.timezone) === section,
                      ),
                      section,
                    );
                    const total = baseTasks.filter(
                      (t) =>
                        sectionOf(t, day, data.settings.timezone) === section,
                    ).length;
                    const closed = collapsed[section] && !q;
                    const isActive = ["backlog", "hold", "today"].includes(
                      section,
                    );
                    return (
                      <section
                        className={`task-section section-${section}`}
                        key={section}
                        aria-label={sectionLabels[section]}
                        onDragOver={(e) => {
                          if (section !== "done" && !project?.archivedAt)
                            e.preventDefault();
                        }}
                        onDrop={(e) => void drop(e, section)}
                      >
                        <div className="section-header">
                          <button
                            className="section-toggle"
                            aria-expanded={!closed}
                            aria-label={`${closed ? "Expandir" : "Recolher"} ${sectionLabels[section]}`}
                            onClick={() =>
                              setCollapsed({ ...collapsed, [section]: !closed })
                            }
                          >
                            {closed ? (
                              <ChevronRight size={15} />
                            ) : (
                              <ChevronDown size={15} />
                            )}
                            <span className="section-symbol">
                              <Icon size={15} />
                            </span>
                            <h2>{sectionLabels[section]}</h2>
                            <span className="section-count">
                              {filtered
                                ? `${tasks.length}/${total}`
                                : tasks.length}
                            </span>
                          </button>
                          <span className="section-description">
                            {section === "today" && selected > 0
                              ? `${selected} selecionada${selected === 1 ? "" : "s"} para o dia`
                              : sectionHints[section]}
                          </span>
                          {isActive && !project?.archivedAt && !q && (
                            <button
                              className="icon-button section-add"
                              aria-label={`Adicionar tarefa em ${sectionLabels[section]}`}
                              onClick={() =>
                                setNewTask(section as ActiveSection)
                              }
                            >
                              <Plus size={16} />
                            </button>
                          )}
                        </div>
                        {!closed && (
                          <>
                            {tasks.slice(0, limits[section] || 100).map(row)}
                            {tasks.length > (limits[section] || 100) && (
                              <button
                                className="text-button load-more"
                                onClick={() =>
                                  setLimits({
                                    ...limits,
                                    [section]: (limits[section] || 100) + 100,
                                  })
                                }
                              >
                                Carregar mais tarefas
                              </button>
                            )}
                            {isActive && !project?.archivedAt && !q ? (
                              <QuickAdd
                                section={section as ActiveSection}
                                projectId={projectId}
                                onCreated={reload}
                                onNotice={notice}
                              />
                            ) : (
                              tasks.length === 0 && (
                                <div className="section-empty">
                                  {section === "doneToday"
                                    ? "Suas entregas de hoje aparecerão aqui."
                                    : section === "done"
                                      ? "As entregas dos dias anteriores ficam guardadas aqui."
                                      : "Nenhuma tarefa encontrada."}
                                </div>
                              )
                            )}
                          </>
                        )}
                      </section>
                    );
                  })}
                </div>
                <div className="list-footer">
                  <span>
                    <Check size={13} />
                    Seu trabalho fica salvo automaticamente
                  </span>
                  <span>
                    {overdue > 0
                      ? `${overdue} tarefa${overdue === 1 ? "" : "s"} atrasada${overdue === 1 ? "" : "s"}`
                      : "Tudo no seu ritmo"}
                    <span className="footer-dot">·</span>
                    {data.settings.timezone}
                  </span>
                </div>
              </div>
            ) : (
              <div className="followup-view">
                {[
                  ["late", "Vencidos", "Precisam de uma nova verificação"],
                  ["today", "Hoje", "Acompanhamentos para este dia"],
                  ["next", "Próximos", "Prepare os próximos contatos"],
                  ["missing", "Hold sem follow-up", "Defina quando acompanhar"],
                ].map(([key, title, description]) => {
                  const items = visibleTasks
                    .filter(
                      (t) =>
                        !t.completedAt &&
                        (key === "late"
                          ? !!t.followUpDate && t.followUpDate < day
                          : key === "today"
                            ? t.followUpDate === day
                            : key === "next"
                              ? !!t.followUpDate && t.followUpDate > day
                              : t.section === "hold" && !t.followUpDate),
                    )
                    .sort((a, b) =>
                      (a.followUpDate || "").localeCompare(
                        b.followUpDate || "",
                      ),
                    );
                  return (
                    <section className={`followup-group ${key}`} key={key}>
                      <div className="followup-heading">
                        <CalendarDays size={18} />
                        <h2>{title}</h2>
                        <span className="section-count">{items.length}</span>
                      </div>
                      <p>{description}</p>
                      {items.length ? (
                        items.map((t) => (
                          <button
                            className="followup-card"
                            key={t.id}
                            onClick={() => openTask(t.id)}
                          >
                            <strong>{t.title}</strong>
                            {t.waitingFor && (
                              <span>Aguardando {t.waitingFor}</span>
                            )}
                            <div>
                              <span>
                                {t.followUpDate
                                  ? formatDate(t.followUpDate)
                                  : "Sem data de acompanhamento"}
                              </span>
                              {isOverdue(t, day, now) && (
                                <span className="late-tag">Prazo atrasado</span>
                              )}
                              <ArrowUpRight size={14} />
                            </div>
                          </button>
                        ))
                      ) : (
                        <div className="followup-empty">
                          <Check size={18} />
                          Nenhuma pendência aqui
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            )}
          </main>
        )}
      </div>
      {taskId && (
        <TaskPanel
          key={taskId}
          taskId={taskId}
          projects={data.projects}
          settings={data.settings}
          now={now}
          onClose={closeTask}
          onChanged={reload}
          onNotice={notice}
        />
      )}
      {settings && (
        <SettingsModal
          data={data}
          onClose={() => setSettings(false)}
          onChanged={reload}
          onNotice={notice}
        />
      )}
      {projectForm && (
        <ProjectEditor
          project={projectForm}
          onClose={() => setProjectForm(null)}
          onSaved={async (id) => {
            await reload();
            if (projectForm === "new") selectProject(id);
          }}
          onNotice={notice}
        />
      )}
      {newTask && (
        <CreateTask
          section={newTask}
          projectId={project?.archivedAt ? activeProjects[0]?.id : projectId}
          projects={activeProjects}
          onClose={() => setNewTask(null)}
          onCreated={async (detail) => {
            await reload();
            selectProject(detail.task.projectId);
            notice("Tarefa criada.");
          }}
        />
      )}
      {complete && (
        <CompleteTask
          task={complete}
          requireEvidence={
            !!data.projects.find((p) => p.id === complete.projectId)
              ?.requireEvidence
          }
          onClose={() => setComplete(null)}
          onConfirm={async (action) => {
            await perform(
              complete,
              action,
              "Entrega registrada. Bom trabalho!",
            );
            setComplete(null);
          }}
        />
      )}
      {hold && (
        <HoldTask
          task={hold}
          onClose={() => setHold(null)}
          onConfirm={async (action) => {
            await perform(
              hold,
              action,
              action.action === "hold"
                ? "Espera atualizada."
                : "Tarefa em espera.",
            );
            setHold(null);
          }}
        />
      )}
      {deleteTask && (
        <Modal title="Excluir tarefa?" onClose={() => setDeleteTask(null)}>
          <div className="modal-body">
            <p>
              <strong>{deleteTask.title}</strong> será enviada para a lixeira.
              Você poderá recuperá-la por 30 dias.
            </p>
            <div className="modal-actions">
              <button
                className="secondary-button"
                onClick={() => setDeleteTask(null)}
              >
                Cancelar
              </button>
              <button
                className="danger-button"
                disabled={busy}
                onClick={() =>
                  void perform(
                    deleteTask,
                    { action: "delete" },
                    "Tarefa enviada à lixeira.",
                  )
                    .then(() => setDeleteTask(null))
                    .catch(() => {})
                }
              >
                Excluir tarefa
              </button>
            </div>
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <CircleCheck size={17} />
          <span>{toast}</span>
          <button
            className="icon-button"
            aria-label="Dispensar aviso"
            onClick={() => setToast("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {(popover || menu) && (
        <div
          className="popover-dismiss"
          onClick={() => {
            setPopover(null);
            setMenu(null);
          }}
        />
      )}
    </div>
  );
}

function QuickAdd({
  section,
  projectId,
  onCreated,
  onNotice,
}: {
  section: ActiveSection;
  projectId: string;
  onCreated: () => Promise<void>;
  onNotice: (s: string) => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="quick-add"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!value.trim() || busy) return;
        setBusy(true);
        try {
          await api("/tasks", {
            method: "POST",
            body: JSON.stringify({ title: value.trim(), projectId, section }),
          });
          setValue("");
          await onCreated();
        } catch (e) {
          onNotice((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Plus size={15} />
      <input
        aria-label={`Nova tarefa em ${sectionLabels[section]}`}
        placeholder="Adicionar tarefa…"
        maxLength={300}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {value && (
        <button type="submit" className="text-button" disabled={busy}>
          {busy ? "Salvando…" : "Adicionar"}
          <span>↵</span>
        </button>
      )}
    </form>
  );
}

function CreateTask({
  section,
  projectId,
  projects,
  onClose,
  onCreated,
}: {
  section: ActiveSection;
  projectId: string;
  projects: Project[];
  onClose: () => void;
  onCreated: (detail: TaskDetail) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [project, setProject] = useState(projectId || projects[0]?.id || "");
  const [destination, setDestination] = useState(section);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Uma nova tarefa" onClose={onClose}>
      <form
        className="modal-body"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const detail = await api<TaskDetail>("/tasks", {
              method: "POST",
              body: JSON.stringify({
                title: title.trim(),
                projectId: project,
                section: destination,
              }),
            });
            await onCreated(detail);
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          O que precisa ser feito?
          <input
            autoFocus
            required
            maxLength={300}
            value={title}
            placeholder="Dê um nome à tarefa"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <div className="form-columns">
          <label>
            Projeto
            <select
              value={project}
              onChange={(e) => setProject(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Seção
            <select
              value={destination}
              onChange={(e) => setDestination(e.target.value as ActiveSection)}
            >
              {(["backlog", "hold", "today"] as ActiveSection[]).map((s) => (
                <option key={s} value={s}>
                  {sectionLabels[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {destination === "today" && (
          <p className="hint">
            Será planejada para hoje. O prazo pode ser definido depois.
          </p>
        )}
        {error && (
          <p role="alert" className="error-message">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="primary-button"
            disabled={busy || !title.trim() || !project}
          >
            <Plus size={15} />
            {busy ? "Criando…" : "Criar tarefa"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CompleteTask({
  task,
  requireEvidence,
  onClose,
  onConfirm,
}: {
  task: Task;
  requireEvidence: boolean;
  onClose: () => void;
  onConfirm: (a: TaskCommand) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [link, setLink] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = task.subtaskCount - task.subtaskDone;
  return (
    <Modal title="Registrar uma entrega" onClose={onClose}>
      <form
        className="modal-body"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await onConfirm({
              action: "complete",
              note,
              link,
              confirmPending: confirm,
            });
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="completion-summary">
          <CircleCheck size={24} />
          <strong>{task.title}</strong>
        </div>
        <p className="hint">
          A conclusão será registrada agora e aparecerá em Done Today.
        </p>
        <label>
          Resultado {requireEvidence ? "" : "(opcional)"}
          <textarea
            rows={3}
            placeholder="O que foi entregue?"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <label>
          Link de evidência (opcional)
          <input
            type="url"
            placeholder="https://…"
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
        </label>
        {requireEvidence && (
          <p className="hint">
            Este projeto exige uma nota ou link de evidência.
          </p>
        )}
        {pending > 0 && (
          <div className="warning-box">
            <strong>
              {pending} subtarefa{pending > 1 ? "s" : ""} ainda pendente
              {pending > 1 ? "s" : ""}
            </strong>
            <label className="check-label">
              <input
                type="checkbox"
                checked={confirm}
                onChange={(e) => setConfirm(e.target.checked)}
              />
              Concluir apenas a tarefa principal, mantendo as subtarefas como
              estão.
            </label>
          </div>
        )}
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Voltar
          </button>
          <button
            className="primary-button"
            disabled={
              busy ||
              (pending > 0 && !confirm) ||
              (requireEvidence && !note.trim() && !link.trim())
            }
          >
            <Check size={16} />
            {busy ? "Registrando…" : "Concluir tarefa"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function HoldTask({
  task,
  onClose,
  onConfirm,
}: {
  task: Task;
  onClose: () => void;
  onConfirm: (a: TaskCommand) => Promise<void>;
}) {
  const [reason, setReason] = useState(task.holdReason || "");
  const [waitingFor, setWaitingFor] = useState(task.waitingFor || "");
  const [nextAction, setNextAction] = useState(task.nextAction || "");
  const [date, setDate] = useState(task.followUpDate || "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={
        task.completedAt
          ? "Reabrir em Hold"
          : task.section === "hold"
            ? "Editar espera"
            : "Colocar em espera"
      }
      onClose={onClose}
    >
      <form
        className="modal-body"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await onConfirm({
              action:
                task.section === "hold" && !task.completedAt ? "hold" : "move",
              section: "hold",
              reason,
              waitingFor,
              nextAction,
              followUpDate: date || null,
            });
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="hint">
          {task.title}. Seu prazo e responsável serão preservados.
        </p>
        <label>
          Motivo da espera
          <textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="O que impede o andamento?"
          />
        </label>
        <label>
          Aguardando quem ou o quê
          <input
            value={waitingFor}
            onChange={(e) => setWaitingFor(e.target.value)}
            placeholder="Pessoa, documento, aprovação…"
          />
        </label>
        <label>
          Próxima ação
          <input
            value={nextAction}
            onChange={(e) => setNextAction(e.target.value)}
            placeholder="O que fazer quando retomar?"
          />
        </label>
        <label>
          Data de follow-up
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <p className="hint">
          Preenchimento opcional. O follow-up é independente do prazo.
        </p>
        {error && <p className="error-message">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancelar
          </button>
          <button className="primary-button" disabled={busy}>
            <Hourglass size={15} />
            {busy
              ? "Salvando…"
              : task.section === "hold"
                ? "Salvar espera"
                : "Mover para Hold"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ProjectEditor({
  project,
  onClose,
  onSaved,
  onNotice,
}: {
  project: Project | "new";
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
  onNotice: (s: string) => void;
}) {
  const existing = project !== "new";
  const [name, setName] = useState(existing ? project.name : "");
  const [description, setDescription] = useState(
    existing ? project.description : "",
  );
  const [color, setColor] = useState(existing ? project.color : "#9673c7");
  const [required, setRequired] = useState(
    existing ? project.requireEvidence : false,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = async (fields: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    try {
      const p = await api<Project>(
        existing ? `/projects/${project.id}` : "/projects",
        { method: existing ? "PATCH" : "POST", body: JSON.stringify(fields) },
      );
      await onSaved(p.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={
        existing ? "Configurações do projeto" : "Um novo espaço para organizar"
      }
      onClose={onClose}
    >
      <form
        className="modal-body"
        onSubmit={(e) => {
          e.preventDefault();
          void save({
            name: name.trim(),
            description,
            color,
            requireEvidence: required,
          });
        }}
      >
        <label>
          Nome do projeto
          <input
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Planejamento pessoal"
          />
        </label>
        <label>
          Descrição
          <textarea
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Qual é o objetivo deste projeto?"
          />
        </label>
        <label>Cor do projeto</label>
        <div className="color-options">
          {[
            "#9673c7",
            "#6e78c8",
            "#b06ba4",
            "#758c79",
            "#bd886b",
            "#626a82",
          ].map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Cor ${c}`}
              aria-pressed={color === c}
              style={{ background: c }}
              onClick={() => setColor(c)}
            >
              {color === c && <Check size={16} />}
            </button>
          ))}
        </div>
        <label className="check-label">
          <input
            type="checkbox"
            checked={required}
            onChange={(e) => setRequired(e.target.checked)}
          />
          Exigir uma evidência ao concluir tarefas
        </label>
        <p className="hint">
          O projeto usa as cinco seções do fluxo principal do Avana.
        </p>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancelar
          </button>
          <button className="primary-button" disabled={busy || !name.trim()}>
            {busy ? "Salvando…" : existing ? "Salvar projeto" : "Criar projeto"}
          </button>
        </div>
        {existing && (
          <div className="project-danger-zone">
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => void save({ archived: !project.archivedAt })}
            >
              <Archive size={15} />
              {project.archivedAt ? "Restaurar projeto" : "Arquivar projeto"}
            </button>
            {!confirmDelete ? (
              <button
                type="button"
                className="text-button danger-text"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={15} />
                Excluir projeto
              </button>
            ) : (
              <div className="warning-box">
                <p>O projeto e suas tarefas irão para a lixeira por 30 dias.</p>
                <button
                  type="button"
                  className="danger-button"
                  disabled={busy}
                  onClick={() => void save({ deleted: true })}
                >
                  Confirmar exclusão
                </button>
              </div>
            )}
          </div>
        )}
      </form>
    </Modal>
  );
}
