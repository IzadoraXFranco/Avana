import React, { useEffect, useRef, useState } from "react";
import { Alert, View } from "react-native";
import { ApiError } from "../../shared/service";
import type {
  ActiveSection,
  Project,
  Settings,
  Subtask,
  Task,
  TaskCommand,
  TaskDetail,
} from "../../shared/types";
import {
  formatDate,
  formatInstant,
  isOverdue,
  sectionLabels,
  sectionOf,
  today,
} from "../../shared/dates";
import { sortTasks } from "../../shared/taskOrder";
import { messageOf, type Service } from "./client";
import { draftStorage } from "./storage";
import {
  Button,
  Card,
  Choices,
  Divider,
  ErrorBox,
  Field,
  Heading,
  Label,
  LinkedText,
  Loading,
  PriorityChoices,
  Row,
  Sheet,
  validDate,
} from "./ui";

import {
  mainOf,
  holdOf,
  subOf,
  initialDraft,
  dirtyMain,
  hasText,
  reconcile,
  parseDraft,
  fieldLabels,
  type Draft,
  type MainFields,
  type HoldFields,
  type SubFields,
} from "./drafts";
export default function TaskScreen({
  taskId,
  scope,
  service,
  tasks,
  projects,
  settings,
  revision,
  onChanged,
  onClose,
  getNow,
}: {
  taskId: string;
  scope: string;
  service: Service;
  tasks: Task[];
  projects: Project[];
  settings: Settings;
  revision: number;
  onChanged: () => Promise<void>;
  onClose: () => void;
  getNow: () => Date;
}) {
  const storageKey = `avana:mobile:${scope}:task:${taskId}`;
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [detail, setDetail] = useState<TaskDetail | null>(null),
    [draft, setDraft] = useState<Draft | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [storageError, setStorageError] = useState(""),
    [flow, setFlow] = useState<"complete" | "reopen" | "hold" | null>(null),
    [destination, setDestination] = useState<ActiveSection>("today"),
    [confirmPending, setConfirmPending] = useState(false);
  const alive = useRef(true),
    busyRef = useRef(false),
    queued = useRef(false),
    fetchGeneration = useRef(0),
    detailRef = useRef<TaskDetail | null>(null),
    draftRef = useRef<Draft | null>(null);
  const flowRef = useRef(flow);
  flowRef.current = flow;
  function replaceDraft(next: Draft) {
    draftRef.current = next;
    setDraft(next);
  }
  function change(patch: Partial<Draft>) {
    if (draftRef.current) replaceDraft({ ...draftRef.current, ...patch });
  }
  const conflicts = draft?.pendingReview || [];
  function setConflicts(value: string[]) {
    change({ pendingReview: value });
  }
  function field<K extends keyof MainFields>(key: K, value: MainFields[K]) {
    if (draftRef.current)
      change({ fields: { ...draftRef.current.fields, [key]: value } });
  }
  function hold(key: keyof HoldFields, value: string) {
    if (draftRef.current)
      change({ hold: { ...draftRef.current.hold, [key]: value } });
  }
  async function refresh() {
    if (busyRef.current) {
      queued.current = true;
      return;
    }
    const own = ++fetchGeneration.current;
    try {
      const next = await service.getDetail(taskId);
      if (!alive.current || own !== fetchGeneration.current) return;
      const current = draftRef.current;
      if (current) {
        const merged = reconcile(current, detailRef.current, next);
        replaceDraft(merged.draft);
        if (merged.conflicts.length) {
          setConflicts(merged.conflicts);
          setNotice(
            "Esta tarefa mudou em outro dispositivo. Seu texto foi preservado. Revise os campos antes de salvar.",
          );
        }
      } else replaceDraft(initialDraft(next));
      detailRef.current = next;
      setDetail(next);
    } catch (failure) {
      if (alive.current && own === fetchGeneration.current)
        setError(messageOf(failure));
    }
  }
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    alive.current = true;
    const own = ++fetchGeneration.current;
    void (async () => {
      try {
        const [next, raw] = await Promise.all([
          service.getDetail(taskId),
          draftStorage.get(storageKey),
        ]);
        if (!alive.current || own !== fetchGeneration.current) return;
        let nextDraft = initialDraft(next);
        if (raw) {
          const saved = parseDraft(raw);
          const merged = reconcile(saved, null, next);
          nextDraft = merged.draft;
          if (saved.version !== next.task.version) {
            nextDraft.pendingReview = merged.conflicts.length
              ? merged.conflicts
              : ["Rascunho de uma versão anterior"];
          }
          setNotice(
            "Rascunho recuperado deste dispositivo. Revise antes de salvar.",
          );
        }
        detailRef.current = next;
        setDetail(next);
        replaceDraft(nextDraft);
        setReady(true);
      } catch (failure) {
        if (alive.current && own === fetchGeneration.current)
          setError(messageOf(failure));
      }
    })();
    return () => {
      alive.current = false;
      fetchGeneration.current++;
    };
  }, [taskId, storageKey, service, loadAttempt]);
  useEffect(() => {
    if (ready && draft)
      void draftStorage
        .set(storageKey, JSON.stringify(draft))
        .then(() => {
          if (alive.current) setStorageError("");
        })
        .catch(() => {
          if (alive.current)
            setStorageError(
              "Não foi possível guardar este rascunho no dispositivo. Mantenha esta tela aberta e tente novamente.",
            );
        });
  }, [draft, ready, storageKey]);
  useEffect(() => {
    if (ready) void refreshRef.current();
  }, [revision, ready]);
  async function close() {
    if (busyRef.current) {
      setNotice("Aguarde a resposta antes de fechar.");
      return;
    }
    const current = draftRef.current;
    if (current) {
      try {
        await draftStorage.set(storageKey, JSON.stringify(current));
      } catch {
        if (alive.current)
          setStorageError(
            "Não foi possível guardar seu texto. Mantenha a tela aberta e tente novamente.",
          );
        return;
      }
    }
    if (alive.current) onClose();
  }
  function requestClose() {
    if (flowRef.current) {
      setFlow(null);
      return;
    }
    if (draftRef.current && hasText(draftRef.current))
      Alert.alert(
        "Manter rascunho?",
        "Seu texto ficará neste dispositivo e nesta conta. Nada será enviado automaticamente.",
        [
          { text: "Continuar editando", style: "cancel" },
          { text: "Fechar e manter", onPress: () => void close() },
        ],
      );
    else void close();
  }
  async function run(
    action: TaskCommand,
    after?: (current: Draft, next: TaskDetail) => Draft,
  ) {
    if (busyRef.current || !detailRef.current || !draftRef.current)
      return false;
    busyRef.current = true;
    setBusy(true);
    setError("");
    fetchGeneration.current++;
    try {
      const next = await service.command(detailRef.current.task, action);
      if (!alive.current) return false;
      const merged = reconcile(draftRef.current, detailRef.current, next);
      const result = after ? after(merged.draft, next) : merged.draft;
      detailRef.current = next;
      setDetail(next);
      replaceDraft(result);
      setNotice("Salvo na sua conta.");
      await draftStorage.set(storageKey, JSON.stringify(result)).catch(() => {
        if (alive.current)
          setStorageError(
            "A alteração foi salva, mas o rascunho local não pôde ser atualizado.",
          );
      });
      if (!alive.current) return false;
      await onChanged();
      return alive.current;
    } catch (failure) {
      if (alive.current) {
        setError(messageOf(failure));
        if (
          failure instanceof ApiError &&
          failure.code === "VERSION_CONFLICT"
        ) {
          queued.current = true;
          setNotice(
            "Outra alteração foi salva primeiro. Vamos atualizar a tarefa mantendo seu texto para revisão.",
          );
        }
      }
      return false;
    } finally {
      busyRef.current = false;
      if (alive.current) {
        setBusy(false);
        if (queued.current) {
          queued.current = false;
          void refreshRef.current();
        }
      }
    }
  }
  function readyForAction() {
    if (!draftRef.current) return false;
    if (conflicts.length) {
      setError("Revise os campos em conflito antes de continuar.");
      return false;
    }
    if (dirtyMain(draftRef.current).length) {
      setError(
        "Salve os campos principais antes desta ação. O texto continua preservado.",
      );
      return false;
    }
    return true;
  }
  async function saveFields() {
    const current = draftRef.current;
    if (!current) return;
    const values = current.fields;
    if (!values.title.trim()) {
      setError("Informe o nome da tarefa.");
      return;
    }
    if (!validDate(values.plannedDate) || !validDate(values.dueDate)) {
      setError("Use datas válidas no formato AAAA-MM-DD.");
      return;
    }
    if (
      values.dueTime &&
      (!/^([01]\d|2[0-3]):[0-5]\d$/.test(values.dueTime) || !values.dueDate)
    ) {
      setError("O horário usa HH:MM e exige uma data de prazo.");
      return;
    }
    if (
      values.executionOrder &&
      (!/^\d+$/.test(values.executionOrder) ||
        Number(values.executionOrder) < 1 ||
        Number(values.executionOrder) > 99999)
    ) {
      setError(
        "Ordem de execução deve ser um inteiro entre 1 e 99999, ou ficar vazia.",
      );
      return;
    }
    const fields: Record<string, unknown> = {};
    for (const key of dirtyMain(current))
      fields[key] =
        key === "executionOrder"
          ? values[key]
            ? Number(values[key])
            : null
          : ["plannedDate", "dueDate", "dueTime"].includes(key)
            ? values[key] || null
            : values[key];
    if (!Object.keys(fields).length) {
      setNotice("Os campos já estão salvos.");
      return;
    }
    await run({ action: "edit", fields }, (d, next) => ({
      ...d,
      base: mainOf(next.task),
      fields: mainOf(next.task),
    }));
  }
  async function saveHold(move = false) {
    if (!draftRef.current || !readyForAction()) return;
    const values = draftRef.current.hold;
    if (!validDate(values.followUpDate)) {
      setError("Use uma data de follow-up válida no formato AAAA-MM-DD.");
      return;
    }
    const ok = await run(
      {
        action: move ? "move" : "hold",
        ...(move ? { section: "hold" } : {}),
        ...values,
        followUpDate: values.followUpDate || null,
      },
      (d, next) => ({ ...d, hold: holdOf(next.task) }),
    );
    if (ok) setFlow(null);
  }
  async function complete() {
    if (!draftRef.current || !readyForAction()) return;
    const { completionNote: note, completionLink: link } = draftRef.current;
    if (link && !/^https?:\/\/\S+$/i.test(link.trim())) {
      setError("A evidência por link deve começar com https:// ou http://.");
      return;
    }
    const ok = await run(
      {
        action: "complete",
        note: note.trim(),
        link: link.trim(),
        confirmPending,
      },
      (d) => ({ ...d, completionNote: "", completionLink: "" }),
    );
    if (ok) {
      setFlow(null);
      setConfirmPending(false);
    }
  }
  function updateSub(id: string, key: keyof SubFields, value: string) {
    const current = draftRef.current;
    if (current)
      change({
        sub: { ...current.sub, [id]: { ...current.sub[id], [key]: value } },
      });
  }
  const day = today(settings.timezone, getNow());
  const task = detail?.task,
    project = projects.find((p) => p.id === task?.projectId);
  const readOnly = !!(
    project?.archivedAt ||
    project?.deletedAt ||
    task?.deletedAt
  );
  const disabled = busy || readOnly;
  const siblings = task
    ? sortTasks(
        tasks.filter(
          (t) =>
            t.projectId === task.projectId &&
            !t.deletedAt &&
            !t.completedAt &&
            t.section === task.section,
        ),
        "manual",
        task.section || "backlog",
      )
    : [];
  const index = siblings.findIndex((t) => t.id === task?.id);
  const orphans = draft
    ? Object.keys(draft.sub).filter(
        (id) => !detail?.subtasks.some((t) => t.id === id),
      )
    : [];
  return (
    <Sheet title="Detalhes da tarefa" onClose={requestClose}>
      {error && <ErrorBox>{error}</ErrorBox>}
      {storageError && (
        <ErrorBox>
          {storageError}
          <Button
            onPress={() => {
              if (draftRef.current)
                void draftStorage
                  .set(storageKey, JSON.stringify(draftRef.current))
                  .then(() => setStorageError(""))
                  .catch(() => undefined);
            }}
          >
            Tentar guardar rascunho
          </Button>
        </ErrorBox>
      )}
      {notice && <Label muted>{notice}</Label>}
      {!ready || !task || !detail || !draft ? (
        <>
          <Loading />
          <Button
            onPress={() => {
              setError("");
              setLoadAttempt((value) => value + 1);
            }}
          >
            Tentar carregar novamente
          </Button>
        </>
      ) : (
        <>
          <Row>
            <Label bold>
              {sectionLabels[sectionOf(task, day, settings.timezone)]}
            </Label>
            {isOverdue(task, day, getNow()) && <Label>Atrasada</Label>}
            {task.completedAt && (
              <Label muted>
                {formatInstant(task.completedAt, settings.timezone)}
              </Label>
            )}
          </Row>
          {readOnly && (
            <Card>
              <Label>
                {task.deletedAt
                  ? "Tarefa na lixeira."
                  : project?.deletedAt
                    ? "Projeto na lixeira."
                    : "Projeto arquivado. Restaure o projeto para editar."}
              </Label>
              {task.deletedAt &&
                !project?.archivedAt &&
                !project?.deletedAt && (
                  <Button
                    disabled={busy}
                    onPress={() => void run({ action: "restore" })}
                  >
                    Restaurar tarefa
                  </Button>
                )}
            </Card>
          )}
          {conflicts.length > 0 && (
            <Card>
              <Heading>Revisar alterações</Heading>
              <Label>
                Campos: {conflicts.join(", ")}. Seu texto foi mantido. Compare
                com os valores atuais da conta abaixo antes de salvar.
              </Label>
              {dirtyMain(draft).map((key) => (
                <View key={key}>
                  <Label bold>{fieldLabels[key]}</Label>
                  <Label muted>Na conta: {draft.base[key] || "vazio"}</Label>
                  <Label>Seu rascunho: {draft.fields[key] || "vazio"}</Label>
                </View>
              ))}
              {conflicts.includes("Bloqueio e follow-up") && (
                <View>
                  <Label bold>Bloqueio atual na conta</Label>
                  <Label muted>
                    {task.holdReason || "Sem motivo"} ·{" "}
                    {task.waitingFor || "Sem terceiro informado"} ·{" "}
                    {task.nextAction || "Sem próxima ação"} ·{" "}
                    {task.followUpDate || "Sem follow-up"}
                  </Label>
                  <Label>
                    Seu rascunho: {draft.hold.reason} · {draft.hold.waitingFor}{" "}
                    · {draft.hold.nextAction} · {draft.hold.followUpDate}
                  </Label>
                </View>
              )}
              {detail.subtasks
                .filter(
                  (sub) =>
                    JSON.stringify(draft.sub[sub.id]) !==
                    JSON.stringify(draft.subBase[sub.id]),
                )
                .map((sub) => (
                  <View key={sub.id}>
                    <Label bold>Subtarefa: {sub.title}</Label>
                    <Label muted>
                      Na conta: {sub.title} · {sub.assignee} ·{" "}
                      {sub.dueDate || "Sem prazo"}
                    </Label>
                    <Label>
                      Seu rascunho: {draft.sub[sub.id]?.title} ·{" "}
                      {draft.sub[sub.id]?.assignee} ·{" "}
                      {draft.sub[sub.id]?.dueDate}
                    </Label>
                  </View>
                ))}
              <Button
                disabled={busy}
                onPress={() => {
                  setConflicts([]);
                  setError("");
                  setNotice(
                    "Revisão confirmada. Toque em Salvar para enviar os campos do seu rascunho.",
                  );
                }}
              >
                Revisei, manter meu rascunho
              </Button>
              <Button
                disabled={busy}
                onPress={() =>
                  Alert.alert(
                    "Usar os dados atuais?",
                    "Isso descarta suas edições dos campos principais e das subtarefas. Comentários ainda não enviados continuam preservados.",
                    [
                      { text: "Cancelar", style: "cancel" },
                      {
                        text: "Usar dados atuais",
                        onPress: () => {
                          const fresh = initialDraft(detail);
                          replaceDraft({
                            ...draft,
                            fields: fresh.fields,
                            base: fresh.base,
                            hold: fresh.hold,
                            sub: fresh.sub,
                            subBase: fresh.subBase,
                          });
                          setConflicts([]);
                        },
                      },
                    ],
                  )
                }
              >
                Usar dados atuais da conta
              </Button>
            </Card>
          )}
          <Row>
            <Button
              primary
              disabled={disabled}
              onPress={() => {
                if (readyForAction()) {
                  setError("");
                  setFlow(task.completedAt ? "reopen" : "complete");
                  setDestination("today");
                }
              }}
            >
              {task.completedAt ? "Reabrir" : "Concluir tarefa"}
            </Button>
            {!task.completedAt && (
              <Button
                disabled={disabled}
                onPress={() => {
                  if (readyForAction()) void run({ action: "plan" });
                }}
              >
                Planejar para hoje
              </Button>
            )}
          </Row>
          <Card>
            <Field
              label="Nome da tarefa"
              value={draft.fields.title}
              onChangeText={(value) => field("title", value)}
              editable={!disabled}
            />
            <Field
              label="Descrição"
              value={draft.fields.description}
              onChangeText={(value) => field("description", value)}
              multiline
              editable={!disabled}
              style={{ minHeight: 100 }}
              hint="Texto e links. O conteúdo também pode ser editado na Web."
            />
            <Field
              label="Responsável"
              value={draft.fields.assignee}
              onChangeText={(value) => field("assignee", value)}
              editable={!disabled}
            />
            <PriorityChoices
              value={draft.fields.priority}
              onChange={(value) => field("priority", value)}
              disabled={disabled}
            />
            <Field
              label="Ordem de execução"
              value={draft.fields.executionOrder}
              onChangeText={(value) => field("executionOrder", value)}
              keyboardType="number-pad"
              editable={!disabled}
              hint={
                draft.fields.executionOrder
                  ? `${draft.fields.executionOrder}º · opcional, de 1 a 99999`
                  : "Opcional · de 1 a 99999"
              }
            />
            <Field
              label="Data planejada"
              value={draft.fields.plannedDate}
              onChangeText={(value) => field("plannedDate", value)}
              placeholder="AAAA-MM-DD"
              maxLength={10}
              keyboardType="numbers-and-punctuation"
              editable={!disabled}
            />
            <Field
              label="Prazo final"
              value={draft.fields.dueDate}
              onChangeText={(value) => field("dueDate", value)}
              placeholder="AAAA-MM-DD"
              maxLength={10}
              keyboardType="numbers-and-punctuation"
              editable={!disabled}
            />
            <Field
              label="Horário do prazo"
              value={draft.fields.dueTime}
              onChangeText={(value) => field("dueTime", value)}
              placeholder="HH:MM (opcional)"
              maxLength={5}
              keyboardType="numbers-and-punctuation"
              editable={!disabled}
              hint={`Fuso do prazo: ${task.dueTimezone}`}
            />
            <Choices
              label="Projeto"
              value={draft.fields.projectId}
              options={projects
                .filter(
                  (p) =>
                    (!p.deletedAt && !p.archivedAt) || p.id === task.projectId,
                )
                .map((p) => ({ value: p.id, label: p.name }))}
              onChange={(value) => field("projectId", value)}
              disabled={disabled}
            />
            {draft.fields.projectId !== task.projectId && (
              <Label muted>
                A mudança de projeto mantém o histórico. Uma tarefa ativa fora
                de Hold volta ao Backlog.
              </Label>
            )}
            <Button
              primary
              disabled={disabled || !!conflicts.length}
              onPress={() => void saveFields()}
            >
              {busy ? "Salvando…" : "Salvar campos"}
            </Button>
          </Card>
          {!task.completedAt && (
            <Card>
              <Heading>Organização</Heading>
              <Choices
                label="Mover para"
                value={task.section || "backlog"}
                options={(["backlog", "hold", "today"] as ActiveSection[]).map(
                  (value) => ({ value, label: sectionLabels[value] }),
                )}
                disabled={disabled}
                onChange={(value) => {
                  if (!readyForAction()) return;
                  if (value === "hold") {
                    setFlow("hold");
                    return;
                  }
                  void run({ action: "move", section: value });
                }}
              />
              <Label muted>
                Selecionar hoje altera apenas a data planejada. O prazo final
                permanece igual.
              </Label>
              <Row>
                <Button
                  disabled={disabled || index <= 0}
                  onPress={() => {
                    if (readyForAction())
                      void run({
                        action: "reorder",
                        beforeId: siblings[index - 1].id,
                      });
                  }}
                >
                  ↑ Ordem manual
                </Button>
                <Button
                  disabled={
                    disabled || index < 0 || index >= siblings.length - 1
                  }
                  onPress={() => {
                    if (readyForAction())
                      void run({
                        action: "reorder",
                        beforeId: siblings[index + 2]?.id || null,
                      });
                  }}
                >
                  ↓ Ordem manual
                </Button>
              </Row>
              <Label muted>
                As setas alteram a ordem manual da seção. Selecione “Ordem
                manual” na lista para vê-la.
              </Label>
            </Card>
          )}
          {!task.completedAt && (
            <Card>
              <Heading>
                {task.section === "hold"
                  ? "Bloqueio e acompanhamento"
                  : "Acompanhamento"}
              </Heading>
              {task.section === "hold" && (
                <>
                  <Label muted>
                    Em espera desde{" "}
                    {task.holdSince
                      ? formatInstant(task.holdSince, settings.timezone)
                      : "agora"}
                  </Label>
                  <HoldInputs
                    value={draft.hold}
                    onChange={hold}
                    disabled={disabled}
                  />
                  <Button
                    disabled={disabled || !!conflicts.length}
                    onPress={() => void saveHold()}
                  >
                    Salvar bloqueio e follow-up
                  </Button>
                </>
              )}
              {task.section !== "hold" && (
                <>
                  <Field
                    label="Data de follow-up"
                    value={draft.hold.followUpDate}
                    onChangeText={(value) => hold("followUpDate", value)}
                    placeholder="AAAA-MM-DD"
                    editable={!disabled}
                  />
                  <Button
                    disabled={disabled}
                    onPress={() => {
                      if (!validDate(draft.hold.followUpDate)) {
                        setError("Informe uma data válida.");
                        return;
                      }
                      if (readyForAction())
                        void run(
                          {
                            action: "followup",
                            date: draft.hold.followUpDate || null,
                          },
                          (d, next) => ({ ...d, hold: holdOf(next.task) }),
                        );
                    }}
                  >
                    Salvar follow-up
                  </Button>
                </>
              )}
              <Divider />
              <Field
                label="Acompanhamento realizado"
                value={draft.followNote}
                onChangeText={(value) => change({ followNote: value })}
                multiline
                editable={!disabled}
              />
              <Field
                label="Próximo follow-up"
                value={draft.nextFollow}
                onChangeText={(value) => change({ nextFollow: value })}
                placeholder="AAAA-MM-DD (opcional)"
                editable={!disabled}
              />
              <Button
                disabled={disabled}
                onPress={() => {
                  if (!validDate(draft.nextFollow)) {
                    setError("Informe uma data válida.");
                    return;
                  }
                  if (readyForAction())
                    void run(
                      {
                        action: "followupDone",
                        note: draft.followNote,
                        nextDate: draft.nextFollow || null,
                      },
                      (d, next) => ({
                        ...d,
                        hold: holdOf(next.task),
                        followNote: "",
                        nextFollow: "",
                      }),
                    );
                }}
              >
                Registrar acompanhamento
              </Button>
            </Card>
          )}
          <Card>
            <Heading>
              Subtarefas · {detail.subtasks.filter((s) => s.completedAt).length}{" "}
              de {detail.subtasks.length}
            </Heading>
            <Label muted>
              Concluir subtarefas não conclui a tarefa principal.
            </Label>
            {detail.subtasks.map((sub, subIndex) => {
              const fields = draft.sub[sub.id] || subOf(sub);
              return (
                <View key={sub.id} style={{ gap: 8 }}>
                  <Divider />
                  <Row>
                    <Button
                      disabled={disabled}
                      label={`${sub.completedAt ? "Reabrir" : "Concluir"} subtarefa ${sub.title}`}
                      onPress={() => {
                        if (readyForAction())
                          void run({
                            action: "subtaskEdit",
                            subtaskId: sub.id,
                            fields: { completed: !sub.completedAt },
                          });
                      }}
                    >
                      {sub.completedAt ? "✓ Concluída" : "○ Pendente"}
                    </Button>
                    <Button
                      small
                      disabled={disabled || subIndex === 0}
                      label={`Subir ${sub.title}`}
                      onPress={() => {
                        if (readyForAction())
                          void run({
                            action: "subtaskReorder",
                            subtaskId: sub.id,
                            beforeId: detail.subtasks[subIndex - 1].id,
                          });
                      }}
                    >
                      ↑
                    </Button>
                    <Button
                      small
                      disabled={
                        disabled || subIndex === detail.subtasks.length - 1
                      }
                      label={`Descer ${sub.title}`}
                      onPress={() => {
                        if (readyForAction())
                          void run({
                            action: "subtaskReorder",
                            subtaskId: sub.id,
                            beforeId: detail.subtasks[subIndex + 2]?.id || null,
                          });
                      }}
                    >
                      ↓
                    </Button>
                  </Row>
                  <Field
                    label="Nome da subtarefa"
                    value={fields.title}
                    onChangeText={(value) => updateSub(sub.id, "title", value)}
                    editable={!disabled}
                  />
                  <Field
                    label="Responsável pela subtarefa"
                    value={fields.assignee}
                    onChangeText={(value) =>
                      updateSub(sub.id, "assignee", value)
                    }
                    editable={!disabled}
                  />
                  <Field
                    label="Prazo da subtarefa"
                    value={fields.dueDate}
                    onChangeText={(value) =>
                      updateSub(sub.id, "dueDate", value)
                    }
                    placeholder="AAAA-MM-DD (opcional)"
                    editable={!disabled}
                  />
                  <Row>
                    <Button
                      small
                      disabled={disabled || !!conflicts.length}
                      onPress={() => {
                        if (
                          !fields.title.trim() ||
                          !validDate(fields.dueDate)
                        ) {
                          setError("Confira o título e a data da subtarefa.");
                          return;
                        }
                        if (readyForAction())
                          void run(
                            {
                              action: "subtaskEdit",
                              subtaskId: sub.id,
                              fields: {
                                ...fields,
                                dueDate: fields.dueDate || null,
                              },
                            },
                            (d, next) => {
                              const updated = subOf(
                                next.subtasks.find((s) => s.id === sub.id)!,
                              );
                              return {
                                ...d,
                                sub: { ...d.sub, [sub.id]: updated },
                                subBase: { ...d.subBase, [sub.id]: updated },
                              };
                            },
                          );
                      }}
                    >
                      Salvar subtarefa
                    </Button>
                    <Button
                      small
                      danger
                      disabled={disabled}
                      onPress={() =>
                        Alert.alert(
                          "Excluir subtarefa?",
                          "A exclusão é registrada no histórico da tarefa.",
                          [
                            { text: "Cancelar", style: "cancel" },
                            {
                              text: "Excluir",
                              style: "destructive",
                              onPress: () => {
                                if (readyForAction())
                                  void run(
                                    {
                                      action: "subtaskDelete",
                                      subtaskId: sub.id,
                                    },
                                    (d) => {
                                      const subDraft = { ...d.sub },
                                        base = { ...d.subBase };
                                      delete subDraft[sub.id];
                                      delete base[sub.id];
                                      return {
                                        ...d,
                                        sub: subDraft,
                                        subBase: base,
                                      };
                                    },
                                  );
                              },
                            },
                          ],
                        )
                      }
                    >
                      Excluir
                    </Button>
                  </Row>
                </View>
              );
            })}
            {orphans.map((id) => (
              <Card key={id}>
                <Label bold>
                  Texto de subtarefa removida em outro dispositivo
                </Label>
                <Label>{draft.sub[id].title}</Label>
                <Label>
                  {draft.sub[id].assignee} {draft.sub[id].dueDate}
                </Label>
                <Button
                  disabled={disabled}
                  onPress={() =>
                    change({
                      comment: [
                        draft.comment,
                        `Subtarefa recuperada: ${draft.sub[id].title}\n${draft.sub[id].assignee} ${draft.sub[id].dueDate}`,
                      ]
                        .filter(Boolean)
                        .join("\n\n"),
                    })
                  }
                >
                  Copiar para comentário
                </Button>
                <Button
                  disabled={disabled}
                  onPress={() =>
                    Alert.alert(
                      "Descartar texto recuperado?",
                      "Esta ação remove somente o rascunho desta subtarefa no dispositivo.",
                      [
                        { text: "Cancelar", style: "cancel" },
                        {
                          text: "Descartar",
                          style: "destructive",
                          onPress: () => {
                            const sub = { ...draft.sub },
                              subBase = { ...draft.subBase };
                            delete sub[id];
                            delete subBase[id];
                            change({ sub, subBase });
                          },
                        },
                      ],
                    )
                  }
                >
                  Descartar rascunho
                </Button>
              </Card>
            ))}
            <Field
              label="Nova subtarefa"
              value={draft.newSubtask}
              onChangeText={(value) => change({ newSubtask: value })}
              editable={!disabled}
            />
            <Button
              disabled={disabled || !draft.newSubtask.trim()}
              onPress={() => {
                if (readyForAction())
                  void run(
                    { action: "subtaskAdd", title: draft.newSubtask.trim() },
                    (d) => ({ ...d, newSubtask: "" }),
                  );
              }}
            >
              Adicionar subtarefa
            </Button>
          </Card>
          <Card>
            <Heading>Comentários e evidências</Heading>
            {detail.comments.length === 0 && (
              <Label muted>Nenhum registro ainda.</Label>
            )}
            {detail.comments.map((comment) => (
              <View key={comment.id} style={{ gap: 4 }}>
                <Divider />
                <Label bold>
                  {comment.author} ·{" "}
                  {comment.kind === "evidence" ? "Evidência" : "Comentário"}
                </Label>
                <Label muted>
                  {formatInstant(comment.createdAt, settings.timezone)}
                </Label>
                <LinkedText text={comment.body} />
              </View>
            ))}
            <Choices
              label="Tipo de registro"
              value={draft.commentKind}
              options={[
                { value: "comment", label: "Comentário" },
                { value: "evidence", label: "Evidência" },
              ]}
              onChange={(value) => change({ commentKind: value })}
              disabled={disabled}
            />
            <Field
              label="Texto ou link"
              value={draft.comment}
              onChangeText={(value) => change({ comment: value })}
              multiline
              editable={!disabled}
              style={{ minHeight: 90 }}
            />
            <Button
              disabled={disabled || !draft.comment.trim()}
              onPress={() => {
                if (readyForAction())
                  void run(
                    {
                      action: "comment",
                      body: draft.comment.trim(),
                      kind: draft.commentKind,
                    },
                    (d) => ({ ...d, comment: "" }),
                  );
              }}
            >
              Publicar registro
            </Button>
          </Card>
          <Card>
            <Heading>Histórico de atividade</Heading>
            {detail.activity.map((event) => (
              <View key={event.id} style={{ gap: 4 }}>
                <Divider />
                <Label>{event.summary}</Label>
                <Label muted>
                  {event.author} ·{" "}
                  {formatInstant(event.createdAt, settings.timezone)}
                </Label>
                {event.before !== null && event.after !== null && (
                  <Label muted>
                    {JSON.stringify(event.before)} →{" "}
                    {JSON.stringify(event.after)}
                  </Label>
                )}
              </View>
            ))}
            {detail.holds.length > 0 && (
              <>
                <Divider />
                <Label bold>Bloqueios anteriores</Label>
                {detail.holds.map((episode) => (
                  <View key={episode.id}>
                    <Label>
                      {episode.reason || "Sem motivo registrado"}
                      {episode.waitingFor ? ` · ${episode.waitingFor}` : ""}
                    </Label>
                    <Label muted>
                      {formatInstant(episode.startedAt, settings.timezone)} →{" "}
                      {episode.endedAt
                        ? formatInstant(episode.endedAt, settings.timezone)
                        : "Em aberto"}
                    </Label>
                  </View>
                ))}
              </>
            )}
            {detail.followUps.length > 0 && (
              <>
                <Divider />
                <Label bold>Acompanhamentos</Label>
                {detail.followUps.map((follow) => (
                  <View key={follow.id}>
                    <Label>
                      {formatDate(follow.date)} ·{" "}
                      {follow.status === "done"
                        ? "Realizado"
                        : follow.status === "cancelled"
                          ? "Encerrado"
                          : "Pendente"}
                    </Label>
                    {follow.note && <Label muted>{follow.note}</Label>}
                  </View>
                ))}
              </>
            )}
          </Card>
          {!task.deletedAt && (
            <Button
              danger
              disabled={disabled}
              onPress={() =>
                Alert.alert(
                  "Excluir tarefa?",
                  "Você poderá recuperá-la na lixeira durante 30 dias.",
                  [
                    { text: "Cancelar", style: "cancel" },
                    {
                      text: "Excluir",
                      style: "destructive",
                      onPress: () => {
                        if (readyForAction()) void run({ action: "delete" });
                      },
                    },
                  ],
                )
              }
            >
              Excluir tarefa
            </Button>
          )}
          <Label muted>
            {busy
              ? "Salvando…"
              : "Alterações são enviadas pelos botões de salvar. Rascunhos ficam neste dispositivo."}
          </Label>
          {flow === "hold" && (
            <Sheet
              title="Colocar em Hold"
              onClose={() => {
                if (!busy) setFlow(null);
              }}
            >
              <Label>
                A responsabilidade pela tarefa continua igual. Registre quem ou
                o que você está aguardando.
              </Label>
              <HoldInputs value={draft.hold} onChange={hold} disabled={busy} />
              {error && <ErrorBox>{error}</ErrorBox>}
              <Button
                primary
                disabled={busy}
                onPress={() => void saveHold(true)}
              >
                Mover para Hold
              </Button>
            </Sheet>
          )}
          {flow === "complete" && (
            <Sheet
              title="Concluir tarefa"
              onClose={() => {
                if (!busy) setFlow(null);
              }}
            >
              <Label>
                {project?.requireEvidence
                  ? "Este projeto exige uma evidência em texto ou link."
                  : "Registre o resultado ou uma evidência, se desejar."}
              </Label>
              <Field
                label="Resultado ou evidência"
                value={draft.completionNote}
                onChangeText={(value) => change({ completionNote: value })}
                multiline
                editable={!busy}
              />
              <Field
                label="Link da evidência"
                value={draft.completionLink}
                onChangeText={(value) => change({ completionLink: value })}
                autoCapitalize="none"
                keyboardType="url"
                editable={!busy}
              />
              {detail.subtasks.some((s) => !s.completedAt) && (
                <Choices
                  label="Há subtarefas pendentes. Elas continuarão pendentes."
                  value={confirmPending ? "yes" : "no"}
                  options={[
                    { value: "no", label: "Revisar antes" },
                    { value: "yes", label: "Concluir mesmo assim" },
                  ]}
                  onChange={(value) => setConfirmPending(value === "yes")}
                  disabled={busy}
                />
              )}
              <Label muted>
                A conclusão usa a data e o horário do servidor. A tarefa
                aparecerá em Done Today e, nos próximos dias, em Done.
              </Label>
              {error && <ErrorBox>{error}</ErrorBox>}
              <Button
                primary
                disabled={
                  busy ||
                  (detail.subtasks.some((s) => !s.completedAt) &&
                    !confirmPending)
                }
                onPress={() => void complete()}
              >
                Confirmar conclusão
              </Button>
            </Sheet>
          )}
          {flow === "reopen" && (
            <Sheet
              title="Reabrir tarefa"
              onClose={() => {
                if (!busy) setFlow(null);
              }}
            >
              <Choices
                label="Destino"
                value={destination}
                options={(["today", "backlog", "hold"] as ActiveSection[]).map(
                  (value) => ({ value, label: sectionLabels[value] }),
                )}
                onChange={setDestination}
                disabled={busy}
              />
              <Label>As conclusões anteriores permanecem no histórico.</Label>
              {error && <ErrorBox>{error}</ErrorBox>}
              <Button
                primary
                disabled={busy}
                onPress={() => {
                  void (async () => {
                    if (!readyForAction()) return;
                    const ok = await run({
                      action: "reopen",
                      section: destination,
                    });
                    if (ok) setFlow(destination === "hold" ? "hold" : null);
                  })();
                }}
              >
                Reabrir
              </Button>
            </Sheet>
          )}
        </>
      )}
    </Sheet>
  );
}
function HoldInputs({
  value,
  onChange,
  disabled,
}: {
  value: HoldFields;
  onChange: (key: keyof HoldFields, value: string) => void;
  disabled: boolean;
}) {
  return (
    <>
      <Field
        label="Motivo da espera"
        value={value.reason}
        onChangeText={(text) => onChange("reason", text)}
        multiline
        editable={!disabled}
      />
      <Field
        label="Aguardando quem ou o quê"
        value={value.waitingFor}
        onChangeText={(text) => onChange("waitingFor", text)}
        editable={!disabled}
      />
      <Field
        label="Próxima ação"
        value={value.nextAction}
        onChangeText={(text) => onChange("nextAction", text)}
        multiline
        editable={!disabled}
      />
      <Field
        label="Data de follow-up"
        value={value.followUpDate}
        onChangeText={(text) => onChange("followUpDate", text)}
        placeholder="AAAA-MM-DD (opcional)"
        editable={!disabled}
      />
    </>
  );
}
