import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Alert,
  AppState,
  Pressable,
  RefreshControl,
  SectionList,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { client, createService, messageOf } from "./client";
import { subscribeWorkspace, type RealtimeState } from "../../shared/realtime";
import { serverClockOffset } from "../../shared/clock";
import {
  formatDate,
  formatInstant,
  isOverdue,
  priorityLabels,
  sectionLabels,
  sectionOf,
  today,
} from "../../shared/dates";
import { sortTasks, sortLabels, type TaskSort } from "../../shared/taskOrder";
import type {
  ActiveSection,
  Bootstrap,
  Project,
  Section,
  Task,
  TaskDetail,
  Settings,
} from "../../shared/types";
import {
  Button,
  Card,
  Choices,
  ErrorBox,
  Field,
  Heading,
  Label,
  Loading,
  palettes,
  PriorityDot,
  Row,
  Sheet,
  Theme,
  useTheme,
} from "./ui";
import { draftStorage } from "./storage";
import TaskScreen from "./TaskScreen";

const sections: Section[] = ["backlog", "hold", "today", "doneToday", "done"];
export default function Home({
  userId,
  email,
}: {
  userId: string;
  email: string;
}) {
  const connection = useMemo(() => createService(userId), [userId]);
  const { service, scope } = connection;
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [projectId, setProjectId] = useState("");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<
    "create" | "projects" | "settings" | "trash" | "sort" | null
  >(null);
  const [sort, setSort] = useState<TaskSort>("manual");
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Partial<Record<Section, boolean>>>(
    { done: true },
  );
  const [realtime, setRealtime] = useState<RealtimeState>("connecting");
  const [revision, setRevision] = useState(0);
  const [, tick] = useState(0);
  const generation = useRef(0),
    mounted = useRef(true),
    offset = useRef(0);
  const systemTheme = useColorScheme();
  const dark =
    data?.settings.theme === "dark" ||
    (data?.settings.theme !== "light" && systemTheme === "dark");
  const palette = dark ? palettes.dark : palettes.light;
  const reload = useCallback(async () => {
    const own = ++generation.current;
    const sentAt = Date.now();
    try {
      const next = await service.request<Bootstrap>("/bootstrap");
      if (!mounted.current || own !== generation.current) return;
      offset.current =
        serverClockOffset(next.serverTime, sentAt, Date.now()) ??
        offset.current;
      setData(next);
      setRevision((value) => value + 1);
      setError("");
      setProjectId((current) =>
        next.projects.some((p) => p.id === current && !p.deletedAt)
          ? current
          : next.projects.find((p) => !p.deletedAt && !p.archivedAt)?.id || "",
      );
    } catch (failure) {
      if (mounted.current && own === generation.current)
        setError(messageOf(failure));
    } finally {
      if (mounted.current && own === generation.current) setLoading(false);
    }
  }, [service]);
  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
      generation.current++;
      service.dispose();
    };
  }, [reload, service]);
  useEffect(
    () =>
      data?.workspaceId
        ? subscribeWorkspace(
            client!,
            data.workspaceId,
            () => void reload(),
            setRealtime,
          )
        : undefined,
    [data?.workspaceId, reload],
  );
  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 30_000);
    const state = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        tick((value) => value + 1);
        void reload();
      }
    });
    return () => {
      clearInterval(timer);
      state.remove();
    };
  }, [reload]);
  const currentNow = () => new Date(Date.now() + offset.current);
  const day = today(
    data?.settings.timezone || "America/Sao_Paulo",
    currentNow(),
  );
  const project = data?.projects.find((p) => p.id === projectId);
  const visible = (data?.tasks || []).filter(
    (t) =>
      t.projectId === projectId &&
      !t.deletedAt &&
      t.title
        .toLocaleLowerCase("pt-BR")
        .includes(search.toLocaleLowerCase("pt-BR")),
  );
  const lists = sections.map((section) => ({
    key: section,
    title: sectionLabels[section],
    section,
    total: visible.filter(
      (t) => sectionOf(t, day, data?.settings.timezone) === section,
    ).length,
    data: collapsed[section]
      ? []
      : sortTasks(
          visible.filter(
            (t) => sectionOf(t, day, data?.settings.timezone) === section,
          ),
          sort,
          section,
        ),
  }));
  const closeSheet = () => setSheet(null);
  return (
    <Theme.Provider value={palette}>
      <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
        <StatusBar style={dark ? "light" : "dark"} />
        <View
          style={{
            paddingHorizontal: 16,
            paddingVertical: 10,
            gap: 10,
            borderBottomWidth: 1,
            borderColor: palette.border,
          }}
        >
          <Row>
            <View style={{ flex: 1 }}>
              <Heading>Avana</Heading>
              <Label muted>
                {realtime === "connected"
                  ? "Conectado à sua conta"
                  : realtime === "reconnecting"
                    ? "Reconectando…"
                    : "Conectando…"}
              </Label>
            </View>
            <Button small disabled={!data} onPress={() => setSheet("projects")}>
              Projetos
            </Button>
            <Button
              small
              disabled={!data}
              label="Abrir configurações"
              onPress={() => setSheet("settings")}
            >
              Ajustes
            </Button>
          </Row>
          <Row>
            <View style={{ flex: 1 }}>
              <Heading>{project?.name || "Seu espaço"}</Heading>
              {project?.archivedAt && (
                <Label muted>Projeto arquivado • somente consulta</Label>
              )}
            </View>
            <Button
              primary
              disabled={!project || !!project.archivedAt}
              onPress={() => setSheet("create")}
            >
              + Tarefa
            </Button>
          </Row>
          <Field
            label="Buscar neste projeto"
            value={search}
            onChangeText={setSearch}
            placeholder="Título da tarefa"
          />
          <Row>
            <View style={{ flex: 1 }}>
              <Label muted>{sortLabels[sort]}</Label>
            </View>
            <Button small onPress={() => setSheet("sort")}>
              Ordenar
            </Button>
          </Row>
          {error && <ErrorBox>{error}</ErrorBox>}
          {notice && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dispensar aviso"
              onPress={() => setNotice("")}
            >
              <Card>
                <Label>{notice}</Label>
              </Card>
            </Pressable>
          )}
        </View>
        {loading ? (
          <Loading />
        ) : !data ? (
          <View style={{ padding: 16, gap: 12 }}>
            <Button onPress={() => void reload()}>Tentar novamente</Button>
            <Button
              danger
              onPress={() => {
                void client!.auth
                  .signOut({ scope: "local" })
                  .then(({ error: failure }) => {
                    if (failure) throw failure;
                  })
                  .catch((failure) => setError(messageOf(failure)));
              }}
            >
              Sair e trocar de conta
            </Button>
          </View>
        ) : !project ? (
          <View style={{ padding: 16, gap: 12 }}>
            <Label>
              Crie seu primeiro projeto para organizar as cinco seções.
            </Label>
            <Button primary onPress={() => setSheet("projects")}>
              Criar projeto
            </Button>
          </View>
        ) : (
          <SectionList
            sections={lists}
            keyExtractor={(task) => task.id}
            stickySectionHeadersEnabled
            refreshControl={
              <RefreshControl
                refreshing={false}
                onRefresh={() => void reload()}
                tintColor={palette.primary}
              />
            }
            contentContainerStyle={{ paddingBottom: 40 }}
            ListEmptyComponent={
              <Label muted>Nenhuma tarefa neste projeto.</Label>
            }
            renderSectionHeader={({ section }) => (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: !collapsed[section.section] }}
                onPress={() =>
                  setCollapsed((current) => ({
                    ...current,
                    [section.section]: !current[section.section],
                  }))
                }
                style={{
                  backgroundColor: palette.bg,
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                  borderBottomWidth: 1,
                  borderColor: palette.border,
                }}
              >
                <Text
                  style={{
                    color: palette.text,
                    fontWeight: "700",
                    fontSize: 15,
                  }}
                >
                  {collapsed[section.section] ? "▸" : "▾"} {section.title} ·{" "}
                  {section.total}
                </Text>
              </Pressable>
            )}
            renderItem={({ item }) => (
              <TaskRow
                task={item}
                timezone={data.settings.timezone}
                day={day}
                now={currentNow()}
                onPress={() => setTaskId(item.id)}
              />
            )}
          />
        )}
        {sheet === "create" && project && (
          <CreateTask
            service={service}
            scope={scope}
            project={project}
            onClose={closeSheet}
            onCreated={async (detail, warning) => {
              closeSheet();
              if (warning) setNotice(warning);
              setTaskId(detail.task.id);
              await reload();
            }}
          />
        )}
        {sheet === "sort" && (
          <Sheet title="Ordenar tarefas" onClose={closeSheet}>
            <Choices
              label="Ordenação"
              value={sort}
              options={(Object.keys(sortLabels) as TaskSort[]).map((value) => ({
                value,
                label: sortLabels[value],
              }))}
              onChange={(value) => {
                setSort(value);
                closeSheet();
              }}
            />
            <Label muted>
              A ordenação muda a visualização. Os números de execução e a
              posição manual permanecem registrados separadamente.
            </Label>
          </Sheet>
        )}
        {sheet === "projects" && data && (
          <Projects
            projects={data.projects}
            activeId={projectId}
            service={service}
            onChange={reload}
            onSelect={(id) => {
              setProjectId(id);
              closeSheet();
            }}
            onClose={closeSheet}
          />
        )}
        {sheet === "settings" && data && (
          <SettingsView
            data={data}
            email={email}
            service={service}
            onClose={closeSheet}
            onChange={reload}
            onTrash={() => setSheet("trash")}
          />
        )}
        {sheet === "trash" && data && (
          <Trash
            data={data}
            service={service}
            onChange={reload}
            onClose={closeSheet}
          />
        )}
        {taskId && data && (
          <TaskScreen
            key={`${scope}:${taskId}`}
            taskId={taskId}
            scope={scope}
            service={service}
            tasks={data.tasks}
            projects={data.projects}
            settings={data.settings}
            revision={revision}
            onChanged={reload}
            onClose={() => setTaskId(null)}
            getNow={currentNow}
          />
        )}
      </SafeAreaView>
    </Theme.Provider>
  );
}
function TaskRow({
  task,
  timezone,
  day,
  now,
  onPress,
}: {
  task: Task;
  timezone: string;
  day: string;
  now: Date;
  onPress: () => void;
}) {
  const c = useTheme();
  const overdue = isOverdue(task, day, now);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${task.title}, ${task.completedAt ? "concluída" : overdue ? "atrasada" : "pendente"}`}
      onPress={onPress}
      style={({ pressed }) => ({
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: pressed ? c.soft : c.surface,
        borderBottomWidth: 1,
        borderColor: c.border,
        gap: 5,
      })}
    >
      <Row>
        <Text
          style={{
            color: task.completedAt ? c.success : c.primary,
            fontSize: 20,
          }}
        >
          {task.completedAt ? "✓" : "○"}
        </Text>
        <Text
          style={{
            flex: 1,
            color: c.text,
            fontWeight: "600",
            fontSize: 16,
            lineHeight: 22,
          }}
        >
          {task.title}
        </Text>
        {task.executionOrder !== null && (
          <Label muted>{task.executionOrder}º</Label>
        )}
      </Row>
      <Row>
        {task.priority && (
          <>
            <PriorityDot priority={task.priority} />
            <Label>{priorityLabels[task.priority]}</Label>
          </>
        )}
        {task.assignee && <Label muted>{task.assignee}</Label>}
        {task.dueDate && (
          <Text style={{ color: overdue ? c.danger : c.muted, fontSize: 13 }}>
            {overdue ? "Atrasada · " : ""}Prazo {formatDate(task.dueDate)}
            {task.dueTime ? ` ${task.dueTime}` : ""}
          </Text>
        )}
        {task.subtaskCount > 0 && (
          <Label muted>
            {task.subtaskDone}/{task.subtaskCount} subtarefas
          </Label>
        )}
      </Row>
      {task.section === "hold" && !task.completedAt && (
        <Label muted>
          Em espera{task.holdReason ? ` · ${task.holdReason}` : ""}
          {task.waitingFor ? ` · aguardando ${task.waitingFor}` : ""}
        </Label>
      )}
      {task.followUpDate && !task.completedAt && (
        <Text
          style={{
            color: task.followUpDate < day ? c.danger : c.muted,
            fontSize: 13,
          }}
        >
          Follow-up {formatDate(task.followUpDate)}
          {task.followUpDate < day ? " · vencido" : ""}
        </Text>
      )}
      {task.section === "today" &&
        !task.completedAt &&
        task.plannedDate !== day && (
          <Label muted>
            Revisar planejamento
            {task.plannedDate ? ` de ${formatDate(task.plannedDate)}` : ""}
          </Label>
        )}
      {task.completedAt && (
        <Label muted>
          Concluída {formatInstant(task.completedAt, timezone)}
        </Label>
      )}
    </Pressable>
  );
}
type Service = ReturnType<typeof createService>["service"];
function CreateTask({
  service,
  scope,
  project,
  onClose,
  onCreated,
}: {
  service: Service;
  scope: string;
  project: Project;
  onClose: () => void;
  onCreated: (detail: TaskDetail, warning?: string) => Promise<void>;
}) {
  const key = `avana:mobile:${scope}:create:${project.id}`;
  const confirmed = useRef<TaskDetail | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const [title, setTitle] = useState(""),
    [section, setSection] = useState<ActiveSection>("backlog"),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void draftStorage
      .get(key)
      .then((raw) => {
        if (active && raw) {
          const saved = JSON.parse(raw);
          if (
            !saved ||
            typeof saved.title !== "string" ||
            !["backlog", "hold", "today"].includes(saved.section)
          )
            throw new Error(
              "O rascunho não pôde ser interpretado. O conteúdo original permanece guardado.",
            );
          setTitle(saved.title || "");
          setSection(
            ["backlog", "hold", "today"].includes(saved.section)
              ? saved.section
              : "backlog",
          );
        }
        if (active) setReady(true);
      })
      .catch((failure) => {
        if (active) setError(messageOf(failure));
      });
    return () => {
      active = false;
    };
  }, [key, readAttempt]);
  useEffect(() => {
    if (ready)
      void draftStorage
        .set(key, JSON.stringify({ title, section }))
        .catch(() =>
          setError("Não foi possível guardar o rascunho neste dispositivo."),
        );
  }, [key, title, section, ready]);
  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const detail =
        confirmed.current ||
        (await service.request<TaskDetail>("/tasks", "POST", {
          title: title.trim(),
          projectId: project.id,
          section,
        }));
      confirmed.current = detail;
      // A confirmed remote commit stays successful if local cleanup fails.
      // Retain the result in this form so retrying navigation never posts again.
      setReady(false);
      let warning = "";
      await draftStorage.remove(key).catch(() => {
        warning =
          "A tarefa foi criada. A limpeza do rascunho local falhou; confira a lista antes de reutilizar esse rascunho.";
      });
      await onCreated(detail, warning);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }
  async function close() {
    if (busy) return;
    if (ready && !confirmed.current) {
      try {
        await draftStorage.set(key, JSON.stringify({ title, section }));
      } catch {
        setError(
          "Não foi possível guardar seu texto. Mantenha a tela aberta e tente novamente.",
        );
        return;
      }
    }
    onClose();
  }
  return (
    <Sheet title="Nova tarefa" onClose={() => void close()}>
      <Label muted>{project.name}</Label>
      <Field
        label="Nome da tarefa"
        value={title}
        onChangeText={setTitle}
        editable={ready && !busy}
        autoFocus
      />
      <Choices
        label="Seção"
        value={section}
        options={(["backlog", "hold", "today"] as ActiveSection[]).map(
          (value) => ({ value, label: sectionLabels[value] }),
        )}
        onChange={setSection}
        disabled={busy || !ready}
      />
      {error && <ErrorBox>{error}</ErrorBox>}
      {!ready && !confirmed.current && (
        <Button
          onPress={() => {
            setError("");
            setReadAttempt((value) => value + 1);
          }}
        >
          Tentar recuperar rascunho
        </Button>
      )}
      <Button
        primary
        disabled={(!ready && !confirmed.current) || busy || !title.trim()}
        onPress={() => void submit()}
      >
        {busy
          ? "Criando…"
          : confirmed.current
            ? "Abrir tarefa criada"
            : "Criar tarefa"}
      </Button>
      <Label muted>
        O título é suficiente. O rascunho fica neste dispositivo; ele só é
        enviado ao tocar em Criar tarefa.
      </Label>
    </Sheet>
  );
}
function Projects({
  projects,
  activeId,
  service,
  onChange,
  onSelect,
  onClose,
}: {
  projects: Project[];
  activeId: string;
  service: Service;
  onChange: () => Promise<void>;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<Project | null>(null),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [requireEvidence, setRequireEvidence] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function act(
    path: string,
    method: string,
    body: Record<string, unknown>,
  ) {
    setBusy(true);
    setError("");
    try {
      await service.request(path, method, body);
      await onChange();
      return true;
    } catch (failure) {
      setError(messageOf(failure));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet title="Projetos" onClose={onClose}>
      {error && <ErrorBox>{error}</ErrorBox>}
      {projects
        .filter((p) => !p.deletedAt)
        .map((p) => (
          <Card key={p.id}>
            <Row>
              <View style={{ flex: 1 }}>
                <Label bold>
                  {p.favorite ? "★ " : ""}
                  {p.name}
                  {p.id === activeId ? " · atual" : ""}
                </Label>
                <Label muted>{p.archivedAt ? "Arquivado" : "Ativo"}</Label>
              </View>
              <Button small onPress={() => onSelect(p.id)}>
                Abrir
              </Button>
            </Row>
            <Row>
              <Button
                small
                disabled={busy}
                onPress={() => {
                  setEditing(p);
                  setName(p.name);
                  setDescription(p.description);
                  setRequireEvidence(p.requireEvidence);
                }}
              >
                Editar
              </Button>
              <Button
                small
                disabled={busy}
                onPress={() =>
                  void act(`/projects/${p.id}`, "PATCH", {
                    favorite: !p.favorite,
                  })
                }
              >
                {p.favorite ? "Desfavoritar" : "Favoritar"}
              </Button>
              <Button
                small
                disabled={busy}
                onPress={() =>
                  void act(`/projects/${p.id}`, "PATCH", {
                    archived: !p.archivedAt,
                  })
                }
              >
                {p.archivedAt ? "Restaurar" : "Arquivar"}
              </Button>
              <Button
                small
                danger
                disabled={busy}
                onPress={() =>
                  Alert.alert(
                    "Excluir projeto?",
                    "O projeto e suas tarefas ficam recuperáveis na lixeira por 30 dias.",
                    [
                      { text: "Cancelar", style: "cancel" },
                      {
                        text: "Excluir",
                        style: "destructive",
                        onPress: () =>
                          void act(`/projects/${p.id}`, "PATCH", {
                            deleted: true,
                          }),
                      },
                    ],
                  )
                }
              >
                Excluir
              </Button>
            </Row>
          </Card>
        ))}
      <Heading>{editing ? "Editar projeto" : "Novo projeto"}</Heading>
      <Field label="Nome do projeto" value={name} onChangeText={setName} />
      <Field
        label="Descrição"
        value={description}
        onChangeText={setDescription}
        multiline
      />
      <Choices
        label="Evidência ao concluir"
        value={requireEvidence ? "required" : "optional"}
        options={[
          { value: "optional", label: "Opcional" },
          { value: "required", label: "Obrigatória" },
        ]}
        onChange={(value) => setRequireEvidence(value === "required")}
      />
      <Button
        primary
        disabled={busy || !name.trim()}
        onPress={() => {
          void (async () => {
            const ok = await act(
              editing ? `/projects/${editing.id}` : "/projects",
              editing ? "PATCH" : "POST",
              { name: name.trim(), description, requireEvidence },
            );
            if (ok) {
              setName("");
              setDescription("");
              setEditing(null);
              setRequireEvidence(false);
            }
          })();
        }}
      >
        Salvar projeto
      </Button>
      {editing && (
        <Button
          onPress={() => {
            setEditing(null);
            setName("");
            setDescription("");
            setRequireEvidence(false);
          }}
        >
          Cancelar edição
        </Button>
      )}
    </Sheet>
  );
}
function SettingsView({
  data,
  email,
  service,
  onClose,
  onChange,
  onTrash,
}: {
  data: Bootstrap;
  email: string;
  service: Service;
  onClose: () => void;
  onChange: () => Promise<void>;
  onTrash: () => void;
}) {
  type Form = Pick<Settings, "name" | "timezone" | "theme">;
  const pick = (settings: Settings): Form => ({
    name: settings.name,
    timezone: settings.timezone,
    theme: settings.theme,
  });
  const base = useRef<Form>(pick(data.settings));
  const [values, setValues] = useState<Form>(base.current);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const { name, timezone, theme } = values;
  const setName = (value: string) =>
    setValues((current) => ({ ...current, name: value }));
  const setTimezone = (value: string) =>
    setValues((current) => ({ ...current, timezone: value }));
  const setTheme = (value: Settings["theme"]) =>
    setValues((current) => ({ ...current, theme: value }));
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [info, setInfo] = useState("");
  useEffect(() => {
    const latest = pick(data.settings),
      previous = base.current,
      next = { ...values },
      changed: string[] = [];
    for (const key of ["name", "timezone", "theme"] as const) {
      if (values[key] === previous[key]) {
        (next[key] as string) = latest[key];
      } else if (latest[key] !== previous[key] && latest[key] !== values[key])
        changed.push(
          key === "name"
            ? "Nome"
            : key === "timezone"
              ? "Fuso horário"
              : "Tema",
        );
    }
    base.current = latest;
    setValues(next);
    if (changed.length) setConflicts(changed);
  }, [data.settings]);
  async function save() {
    if (conflicts.length) return;
    setBusy(true);
    setError("");
    try {
      new Intl.DateTimeFormat("pt-BR", { timeZone: timezone }).format();
      const fields: Record<string, unknown> = {};
      for (const key of ["name", "timezone", "theme"] as const)
        if (values[key] !== base.current[key]) fields[key] = values[key];
      if (!Object.keys(fields).length) {
        setInfo("As preferências já estão salvas.");
        return;
      }
      await service.request("/settings", "PATCH", fields);
      base.current = { ...base.current, ...fields };
      await onChange();
      setInfo("Preferências salvas.");
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet title="Configurações" onClose={onClose}>
      <Label muted>{email}</Label>
      {conflicts.length > 0 && (
        <Card>
          <Label bold>
            Preferências alteradas em outro dispositivo: {conflicts.join(", ")}
          </Label>
          <Label muted>
            Na conta: {base.current.name} · {base.current.timezone} ·{" "}
            {base.current.theme}
          </Label>
          <Label>Revise os campos abaixo antes de confirmar.</Label>
          <Button onPress={() => setConflicts([])}>
            Revisei, manter meus campos
          </Button>
          <Button
            onPress={() => {
              setValues(base.current);
              setConflicts([]);
            }}
          >
            Usar preferências da conta
          </Button>
        </Card>
      )}
      <Field
        label="Seu nome"
        value={name}
        onChangeText={setName}
        editable={!busy}
      />
      <Field
        label="Fuso horário"
        value={timezone}
        onChangeText={setTimezone}
        autoCapitalize="none"
        hint="Exemplo: America/Sao_Paulo"
        editable={!busy}
      />
      <Choices
        label="Tema"
        value={theme}
        options={[
          { value: "light", label: "Claro" },
          { value: "dark", label: "Escuro" },
          { value: "system", label: "Sistema" },
        ]}
        onChange={setTheme}
        disabled={busy}
      />
      {error && <ErrorBox>{error}</ErrorBox>}
      {info && <Label>{info}</Label>}
      <Button
        primary
        disabled={busy || !!conflicts.length}
        onPress={() => void save()}
      >
        Salvar preferências
      </Button>
      <Button onPress={onTrash}>Lixeira</Button>
      <Button
        disabled={busy}
        onPress={() => {
          setBusy(true);
          setError("");
          void service
            .request<{ id: string }>("/backup", "POST")
            .then((result) => setInfo(`Backup criado na conta: ${result.id}`))
            .catch((failure) => setError(messageOf(failure)))
            .finally(() => setBusy(false));
        }}
      >
        Criar backup na conta
      </Button>
      <Label muted>
        Exportação completa e restauração de arquivos estão disponíveis na
        versão Web. Os rascunhos do Android ficam somente neste dispositivo e
        não são enviados automaticamente.
      </Label>
      <Button
        danger
        disabled={busy}
        onPress={() =>
          Alert.alert(
            "Sair da conta?",
            "Os rascunhos ficam vinculados a esta conta neste dispositivo.",
            [
              { text: "Cancelar", style: "cancel" },
              {
                text: "Sair",
                onPress: () => {
                  setBusy(true);
                  void client!.auth
                    .signOut({ scope: "local" })
                    .then(({ error: failure }) => {
                      if (failure) throw failure;
                    })
                    .catch((failure) => {
                      setError(messageOf(failure));
                      setBusy(false);
                    });
                },
              },
            ],
          )
        }
      >
        Sair da conta
      </Button>
    </Sheet>
  );
}
function Trash({
  data,
  service,
  onChange,
  onClose,
}: {
  data: Bootstrap;
  service: Service;
  onChange: () => Promise<void>;
  onClose: () => void;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const tasks = data.tasks.filter((t) => t.deletedAt),
    projects = data.projects.filter((p) => p.deletedAt);
  async function restore(task: Task | Project, isProject: boolean) {
    setBusy(true);
    setError("");
    try {
      if (isProject)
        await service.request(`/projects/${task.id}`, "PATCH", {
          deleted: false,
        });
      else await service.command(task as Task, { action: "restore" });
      await onChange();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet title="Lixeira" onClose={onClose}>
      <Label muted>
        Itens excluídos podem ser recuperados por 30 dias. Restaure primeiro o
        projeto de uma tarefa excluída.
      </Label>
      {error && <ErrorBox>{error}</ErrorBox>}
      {!tasks.length && !projects.length && (
        <Label>A lixeira está vazia.</Label>
      )}
      {projects.map((project) => (
        <Card key={project.id}>
          <Label bold>{project.name} · projeto</Label>
          <Button disabled={busy} onPress={() => void restore(project, true)}>
            Restaurar projeto
          </Button>
        </Card>
      ))}
      {tasks.map((task) => (
        <Card key={task.id}>
          <Label bold>{task.title}</Label>
          <Label muted>
            Excluída em {formatInstant(task.deletedAt!, data.settings.timezone)}
          </Label>
          <Button
            disabled={busy || projects.some((p) => p.id === task.projectId)}
            onPress={() => void restore(task, false)}
          >
            Restaurar tarefa
          </Button>
        </Card>
      ))}
    </Sheet>
  );
}
