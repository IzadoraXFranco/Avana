/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import { initialDraft, reconcile, parseDraft } from "../src/drafts.ts";
import type { TaskDetail } from "../../shared/types.ts";

function fixture(): TaskDetail {
  return {
    task: {
      id: "t1",
      projectId: "p1",
      title: "Tarefa",
      description: "",
      section: "backlog",
      completionId: null,
      completedAt: null,
      position: 1024,
      executionOrder: null,
      assignee: "",
      priority: "",
      plannedDate: null,
      dueDate: null,
      dueTime: null,
      dueTimezone: "America/Sao_Paulo",
      createdAt: "2026-10-16T12:00:00Z",
      updatedAt: "2026-10-16T12:00:00Z",
      deletedAt: null,
      version: 1,
      subtaskCount: 1,
      subtaskDone: 0,
      commentCount: 0,
      followUpDate: null,
      holdReason: "",
      waitingFor: "",
      holdSince: null,
      nextAction: "",
    },
    subtasks: [
      {
        id: "s1",
        taskId: "t1",
        title: "Subtarefa",
        completedAt: null,
        assignee: "",
        dueDate: null,
        position: 1024,
      },
    ],
    comments: [],
    activity: [],
    holds: [],
    followUps: [],
    completions: [],
  };
}
test("preserva campos digitados e mescla alterações independentes sem mutar o rascunho", () => {
  const old = fixture(),
    draft = initialDraft(old),
    next = structuredClone(old);
  draft.fields = { ...draft.fields, title: "Meu texto" };
  next.task.version = 2;
  next.task.priority = "high";
  next.subtasks[0].assignee = "Responsável";
  const snapshot = JSON.stringify(draft),
    result = reconcile(draft, old, next);
  assert.equal(JSON.stringify(draft), snapshot);
  assert.equal(result.draft.fields.title, "Meu texto");
  assert.equal(result.draft.fields.priority, "high");
  assert.equal(result.draft.sub.s1.assignee, "Responsável");
  assert.deepEqual(result.conflicts, []);
});
test("conflito permanece obrigatório depois de persistir e reabrir na mesma versão", () => {
  const old = fixture(),
    draft = initialDraft(old),
    next = structuredClone(old);
  draft.fields = { ...draft.fields, title: "Meu texto" };
  next.task.title = "Texto remoto";
  next.task.version = 2;
  const first = reconcile(draft, old, next);
  assert.deepEqual(first.draft.pendingReview, ["Nome"]);
  const restored = reconcile(
    JSON.parse(JSON.stringify(first.draft)),
    null,
    next,
  );
  assert.deepEqual(restored.draft.pendingReview, ["Nome"]);
  assert.equal(restored.draft.fields.title, "Meu texto");
  assert.equal(restored.draft.base.title, "Texto remoto");
  const acknowledged = reconcile(
    { ...restored.draft, pendingReview: [] },
    next,
    next,
  );
  assert.deepEqual(acknowledged.conflicts, []);
});
test("subtarefa removida com texto editado permanece recuperável, a intacta desaparece", () => {
  const old = fixture(),
    draft = initialDraft(old),
    next = structuredClone(old);
  next.subtasks = [];
  next.task.version = 2;
  draft.sub = {
    ...draft.sub,
    s1: { ...draft.sub.s1, title: "Texto não enviado" },
  };
  assert.equal(
    reconcile(draft, old, next).draft.sub.s1.title,
    "Texto não enviado",
  );
  assert.deepEqual(reconcile(initialDraft(old), old, next).draft.sub, {});
});
test("conflito de subtarefa mantém texto digitado e valor atual da conta", () => {
  const old = fixture(),
    draft = initialDraft(old),
    next = structuredClone(old);
  draft.sub = {
    ...draft.sub,
    s1: { ...draft.sub.s1, title: "Título digitado" },
  };
  next.subtasks[0].title = "Título remoto";
  next.task.version = 2;
  const result = reconcile(draft, old, next);
  assert.equal(result.draft.sub.s1.title, "Título digitado");
  assert.equal(result.draft.subBase.s1.title, "Título remoto");
  assert.equal(result.draft.pendingReview.length, 1);
});
test("rascunhos de comentário e evidência não são enviados nem apagados por refresh", () => {
  const old = fixture(),
    draft = initialDraft(old),
    next = structuredClone(old);
  next.task.version = 2;
  draft.comment = "Meu comentário";
  draft.completionNote = "Minha entrega";
  draft.completionLink = "https://example.test/evidencia";
  const result = reconcile(draft, old, next).draft;
  assert.equal(result.comment, draft.comment);
  assert.equal(result.completionNote, draft.completionNote);
  assert.equal(result.completionLink, draft.completionLink);
});
test("hold alterado em dois dispositivos exige revisão sem apagar acompanhamento", () => {
  const old = fixture(),
    draft = initialDraft(old),
    next = structuredClone(old);
  draft.hold = { ...draft.hold, reason: "Motivo digitado" };
  next.task.holdReason = "Motivo remoto";
  next.task.version = 2;
  const result = reconcile(draft, old, next);
  assert.equal(result.draft.hold.reason, "Motivo digitado");
  assert.ok(result.draft.pendingReview.includes("Bloqueio e follow-up"));
});

test("parseDraft aceita o formato atual sem alterar os textos ou a revisão pendente", () => {
  const draft = initialDraft(fixture());
  draft.comment = "Comentário ainda não enviado";
  draft.hold.reason = "Aguardando revisão";
  draft.pendingReview = ["Nome", "Bloqueio e follow-up"];
  assert.deepEqual(parseDraft(JSON.stringify(draft)), draft);
});

test("parseDraft aceita o legado sem pendingReview, com lista de revisão vazia", () => {
  const draft = initialDraft(fixture());
  draft.completionNote = "Minha entrega";
  const { pendingReview: _unused, ...legacy } = draft;
  const raw = JSON.stringify(legacy);
  const parsed = parseDraft(raw);
  assert.deepEqual(parsed.pendingReview, []);
  assert.equal(parsed.completionNote, "Minha entrega");
  assert.equal(raw, JSON.stringify(legacy));
});

test("parseDraft rejeita dados aninhados inválidos antes de liberar autosave", () => {
  const valid = initialDraft(fixture());
  const invalid = [
    null,
    [],
    {},
    { ...valid, version: 0 },
    { ...valid, version: -1 },
    { ...valid, version: 1.5 },
    { ...valid, version: "1" },
    { ...valid, version: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, comment: {} },
    { ...valid, commentKind: "unknown" },
    { ...valid, completionNote: [] },
    { ...valid, completionLink: {} },
    { ...valid, newSubtask: null },
    { ...valid, followNote: false },
    { ...valid, nextFollow: 42 },
    { ...valid, fields: { ...valid.fields, priority: "urgent" } },
    { ...valid, fields: { ...valid.fields, title: {} } },
    { ...valid, fields: { ...valid.fields, futureField: "unknown" } },
    { ...valid, base: { ...valid.base, assignee: null } },
    { ...valid, hold: { ...valid.hold, reason: {} } },
    { ...valid, hold: [] },
    { ...valid, sub: { s1: { title: "Texto", assignee: [], dueDate: "" } } },
    { ...valid, subBase: { s1: {} } },
    { ...valid, sub: [] },
    { ...valid, pendingReview: "Nome" },
    { ...valid, pendingReview: ["Nome", {}] },
    { ...valid, pendingReview: null },
    { ...valid, futureSchema: {} },
  ];
  for (const value of invalid) {
    const raw = JSON.stringify(value);
    assert.throws(() => parseDraft(raw), /permanece guardado/);
    assert.equal(raw, JSON.stringify(value));
  }
  assert.throws(() => parseDraft('{"comment":'), /permanece guardado/);
});
