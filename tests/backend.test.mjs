import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createStore, localDate } from "../server/store.mjs";
import { createServer } from "../server/index.mjs";

function fixture(t, initial = "2026-10-16T15:00:00.000Z", extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "avana-backend-"));
  let time = initial;
  const file = join(dir, "test.sqlite");
  const config = {
    clock: () => time,
    backupDirectory: join(dir, "backups"),
    ...extra,
  };
  let store = createStore(file, config);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    dir,
    file,
    setTime: (value) => {
      time = value;
    },
    reopen: () => {
      store.close();
      store = createStore(file, config);
      return store;
    },
  };
}
const act = (store, detail, action, fields = {}) =>
  store.command(detail.task.id, {
    action,
    version: detail.task.version,
    commandId: randomUUID(),
    ...fields,
  });
const errorCode = (expected) => (error) => error.code === expected;

test("creates an empty workspace and persists title-only tasks and preferences", (t) => {
  const f = fixture(t);
  const first = f.store.bootstrap();
  assert.equal(first.projects.length, 1);
  assert.equal(first.projects[0].name, "Meu trabalho");
  assert.equal(first.projects[0].favorite, true);
  assert.equal(first.tasks.length, 0);
  const created = f.store.createTask({ title: "Organizar meu dia" });
  assert.equal(created.task.section, "backlog");
  assert.equal(created.task.version, 1);
  f.store.updateSettings({ theme: "dark" });
  f.reopen();
  const restored = f.store.getTask(created.task.id);
  assert.equal(restored.task.title, "Organizar meu dia");
  assert.equal(f.store.bootstrap().settings.theme, "dark");
});

test("planning preserves deadline and yesterday remains in today until explicit review", (t) => {
  const f = fixture(t);
  let task = f.store.createTask({ title: "Planejamento" });
  task = act(f.store, task, "edit", {
    fields: { dueDate: "2026-10-20", dueTime: "16:00" },
  });
  task = act(f.store, task, "plan");
  assert.equal(task.task.section, "today");
  assert.equal(task.task.plannedDate, "2026-10-16");
  assert.equal(task.task.dueDate, "2026-10-20");
  f.setTime("2026-10-17T12:00:00.000Z");
  task = f.store.getTask(task.task.id);
  assert.equal(task.task.section, "today");
  assert.equal(task.task.plannedDate, "2026-10-16");
  task = act(f.store, task, "plan");
  assert.equal(task.task.plannedDate, "2026-10-17");
  assert.equal(task.task.dueTime, "16:00");
});

test("Hold keeps responsibility, deadline, pending follow-up and historical episodes", (t) => {
  const f = fixture(t);
  let task = f.store.createTask({ title: "Aguardar confirmação" });
  task = act(f.store, task, "edit", {
    fields: { dueDate: "2026-10-15", assignee: "Você" },
  });
  task = act(f.store, task, "move", {
    section: "hold",
    reason: "Aguardando informação",
    waitingFor: "Fornecedor de exemplo",
    nextAction: "Conferir retorno",
    followUpDate: "2026-10-17",
  });
  assert.equal(task.task.assignee, "Você");
  assert.equal(task.task.waitingFor, "Fornecedor de exemplo");
  assert.equal(task.task.dueDate, "2026-10-15");
  assert.ok(task.task.holdSince);
  task = act(f.store, task, "hold", { reason: "Aguardando documento" });
  assert.equal(task.task.waitingFor, "Fornecedor de exemplo");
  assert.equal(task.task.followUpDate, "2026-10-17");
  task = act(f.store, task, "move", { section: "backlog" });
  assert.equal(task.task.followUpDate, "2026-10-17");
  assert.equal(task.holds.length, 1);
  assert.ok(task.holds[0].endedAt);
  task = act(f.store, task, "move", { section: "hold" });
  assert.equal(task.holds.length, 2);
  assert.equal(task.task.holdReason, "");
  task = act(f.store, task, "followupDone", {
    note: "Acompanhamento realizado",
    nextDate: "2026-10-19",
  });
  assert.equal(task.task.followUpDate, "2026-10-19");
  assert.equal(task.followUps[0].status, "done");
  assert.equal(task.followUps[0].note, "Acompanhamento realizado");
});

test("completion across midnight is derived without modifying history or timestamps", (t) => {
  const f = fixture(t, "2026-10-17T02:59:59.000Z");
  let task = f.store.createTask({ title: "Entrega" });
  task = act(f.store, task, "complete", {
    note: "Resultado registrado",
    link: "https://example.com/evidencia",
  });
  const completed = task.task.completedAt;
  const activityCount = task.activity.length;
  assert.equal(localDate(completed, "America/Sao_Paulo"), "2026-10-16");
  assert.equal(f.store.bootstrap().today, "2026-10-16");
  assert.equal(task.task.section, null);
  f.setTime("2026-10-17T03:00:01.000Z");
  f.reopen();
  task = f.store.getTask(task.task.id);
  assert.equal(f.store.bootstrap().today, "2026-10-17");
  assert.equal(task.task.completedAt, completed);
  assert.equal(task.activity.length, activityCount);
  assert.equal(task.completions.length, 1);
  assert.equal(task.comments[0].kind, "evidence");
  assert.throws(() => act(f.store, task, "move", { section: "done" }));
  assert.throws(() =>
    act(f.store, task, "edit", { fields: { completedAt: "2026-01-01" } }),
  );
});

test("subtasks do not complete parent and completion requires an explicit pending decision", (t) => {
  const f = fixture(t);
  let task = f.store.createTask({ title: "Principal" });
  task = act(f.store, task, "subtaskAdd", { title: "Primeira" });
  task = act(f.store, task, "subtaskAdd", { title: "Segunda" });
  task = act(f.store, task, "subtaskEdit", {
    subtaskId: task.subtasks[0].id,
    fields: { completed: true },
  });
  assert.equal(task.task.subtaskDone, 1);
  assert.equal(task.task.completedAt, null);
  assert.throws(
    () => act(f.store, task, "complete"),
    errorCode("PENDING_SUBTASKS"),
  );
  task = act(f.store, task, "complete", { confirmPending: true });
  assert.ok(task.task.completedAt);
  assert.equal(task.task.subtaskDone, 1);
  assert.equal(task.subtasks[1].completedAt, null);
  task = act(f.store, task, "reopen");
  assert.equal(task.task.section, "today");
  assert.equal(task.task.completedAt, null);
  assert.equal(task.completions.length, 1);
  f.setTime("2026-10-17T15:00:00.000Z");
  task = act(f.store, task, "complete", { confirmPending: true });
  assert.equal(task.completions.length, 2);
  assert.notEqual(task.completions[0].id, task.completions[1].id);
});

test("completion closes blockers and follow-ups, evidence policy is enforced", (t) => {
  const f = fixture(t);
  let task = f.store.createTask({ title: "Entrega com evidência" });
  f.store.updateProject(task.task.projectId, { requireEvidence: true });
  task = act(f.store, task, "move", {
    section: "hold",
    reason: "Aprovação",
    followUpDate: "2026-10-18",
  });
  assert.throws(
    () => act(f.store, task, "complete"),
    errorCode("EVIDENCE_REQUIRED"),
  );
  assert.throws(() =>
    act(f.store, task, "complete", { link: "javascript:alert(1)" }),
  );
  task = act(f.store, task, "complete", { note: "Conferido e entregue" });
  assert.equal(task.task.followUpDate, null);
  assert.ok(task.holds[0].endedAt);
  assert.equal(task.followUps[0].status, "cancelled");
  assert.equal(task.comments[0].completionId, task.task.completionId);
  task = act(f.store, task, "reopen");
  assert.throws(
    () => act(f.store, task, "complete"),
    errorCode("EVIDENCE_REQUIRED"),
  );
  task = act(f.store, task, "comment", {
    body: "Evidência do novo ciclo",
    kind: "evidence",
  });
  task = act(f.store, task, "complete");
  assert.equal(task.comments[1].completionId, task.task.completionId);
  assert.notEqual(task.comments[0].completionId, task.task.completionId);
});

test("commands are durable, idempotent, versioned and rollback failed actions", (t) => {
  const f = fixture(t);
  let task = f.store.createTask({ title: "Versões" });
  const input = {
    action: "complete",
    version: task.task.version,
    commandId: randomUUID(),
    note: "Evidência",
  };
  task = f.store.command(task.task.id, input);
  const replay = f.store.command(task.task.id, input);
  assert.deepEqual(replay, task);
  f.reopen();
  assert.deepEqual(f.store.command(task.task.id, input), task);
  assert.throws(
    () => f.store.command(task.task.id, { ...input, note: "Outra" }),
    errorCode("IDEMPOTENCY_CONFLICT"),
  );
  assert.throws(
    () =>
      f.store.command(task.task.id, {
        action: "reopen",
        version: 1,
        commandId: randomUUID(),
      }),
    errorCode("VERSION_CONFLICT"),
  );
  const again = act(f.store, task, "complete");
  assert.equal(again.completions.length, 1);
  assert.equal(again.task.version, task.task.version);
  assert.throws(() =>
    act(f.store, task, "edit", {
      fields: { title: "Título diferente", dueDate: "2026-02-30" },
    }),
  );
  assert.equal(f.store.getTask(task.task.id).task.title, "Versões");
});

test("manual ordering stays independent of section and deadline", (t) => {
  const f = fixture(t);
  const first = f.store.createTask({ title: "Primeira", section: "today" });
  let second = f.store.createTask({ title: "Segunda", section: "today" });
  const third = f.store.createTask({ title: "Terceira" });
  second = act(f.store, second, "reorder", { beforeId: first.task.id });
  assert.equal(
    f.store.bootstrap().tasks.filter((task) => task.section === "today")[0].id,
    second.task.id,
  );
  assert.throws(() =>
    act(f.store, second, "reorder", { beforeId: third.task.id }),
  );
  second = act(f.store, second, "reorder", { beforeId: null });
  assert.ok(second.task.position > first.task.position);
});

test("execution sequence is optional, bounded, allows ties and does not change manual position", (t) => {
  const f = fixture(t);
  let first = f.store.createTask({ title: "Primeira", section: "today" });
  let second = f.store.createTask({ title: "Segunda", section: "today" });
  assert.equal(first.task.executionOrder, null);
  const initialPosition = first.task.position;
  first = act(f.store, first, "edit", { fields: { executionOrder: 2 } });
  assert.equal(first.task.executionOrder, 2);
  assert.equal(first.task.position, initialPosition);
  second = act(f.store, second, "edit", { fields: { executionOrder: 2 } });
  assert.equal(second.task.executionOrder, 2);
  assert.ok(first.task.position < second.task.position);
  const history = first.activity.find((event) => event.type === "edit");
  assert.equal(history.before.executionOrder, null);
  assert.equal(history.after.executionOrder, 2);
  for (const invalid of [
    0,
    -1,
    100000,
    1.5,
    "1",
    "",
    true,
    undefined,
    NaN,
    Infinity,
  ]) {
    assert.throws(
      () =>
        act(f.store, first, "edit", { fields: { executionOrder: invalid } }),
      errorCode("VALIDATION_ERROR"),
    );
    assert.equal(f.store.getTask(first.task.id).task.executionOrder, 2);
  }
  for (const valid of [1, 99999, null]) {
    first = act(f.store, first, "edit", { fields: { executionOrder: valid } });
    assert.equal(first.task.executionOrder, valid);
    assert.equal(first.task.position, initialPosition);
  }
  assert.throws(
    () => act(f.store, first, "edit", { fields: { priority: "urgent" } }),
    errorCode("VALIDATION_ERROR"),
  );
  for (const priority of ["high", "medium", "low", ""]) {
    first = act(f.store, first, "edit", { fields: { priority } });
    assert.equal(first.task.priority, priority);
  }
});

test("execution sequence survives moves, reordering, completion, reopen and backup round trip", (t) => {
  const f = fixture(t);
  let task = f.store.createTask({ title: "Ordem persistente" });
  task = act(f.store, task, "edit", {
    fields: { executionOrder: 3, dueDate: "2026-10-20" },
  });
  for (const section of ["today", "hold", "backlog"]) {
    task = act(f.store, task, "move", { section });
    assert.equal(task.task.executionOrder, 3);
  }
  const other = f.store.createTask({ title: "Outra" });
  task = act(f.store, task, "reorder", { beforeId: other.task.id });
  assert.equal(task.task.executionOrder, 3);
  task = act(f.store, task, "complete");
  assert.equal(task.task.executionOrder, 3);
  task = act(f.store, task, "reopen");
  assert.equal(task.task.executionOrder, 3);
  const project = f.store.createProject({ name: "Outro projeto" });
  task = act(f.store, task, "edit", { fields: { projectId: project.id } });
  assert.equal(task.task.executionOrder, 3);
  f.reopen();
  assert.equal(f.store.getTask(task.task.id).task.executionOrder, 3);
  const backup = JSON.parse(readFileSync(f.store.backup().path, "utf8"));
  assert.equal(
    backup.data.tasks.find((row) => row.id === task.task.id).executionOrder,
    3,
  );
  task = act(f.store, task, "edit", { fields: { executionOrder: null } });
  f.store.restore(backup);
  assert.equal(f.store.getTask(task.task.id).task.executionOrder, 3);
  assert.equal(f.store.getTask(task.task.id).task.dueDate, "2026-10-20");
});

test("legacy v1 exports default sequence to null and normalize urgent without rewriting history", (t) => {
  const f = fixture(t);
  let task = f.store.createTask({ title: "Legada" });
  task = act(f.store, task, "edit", {
    fields: { executionOrder: 4, priority: "high" },
  });
  const legacy = f.store.exportData();
  const row = legacy.data.tasks.find((row) => row.id === task.task.id);
  delete row.executionOrder;
  row.priority = "urgent";
  const historical = legacy.data.activity.find(
    (event) => event.taskId === task.task.id && event.type === "edit",
  );
  historical.after = JSON.stringify({ priority: "urgent" });
  f.store.restore(legacy);
  const restored = f.store.getTask(task.task.id);
  assert.equal(restored.task.executionOrder, null);
  assert.equal(restored.task.priority, "high");
  assert.equal(
    restored.activity.find((event) => event.id === historical.id).after
      .priority,
    "urgent",
  );
  assert.equal("executionOrder" in row, false);
  assert.equal(row.priority, "urgent");
  assert.equal(f.store.exportData().data.tasks[0].priority, "high");
  for (const value of [0, 100000, 1.2, "2"]) {
    const invalid = structuredClone(legacy);
    invalid.data.tasks[0].executionOrder = value;
    assert.throws(
      () => f.store.restore(invalid),
      errorCode("VALIDATION_ERROR"),
    );
    assert.deepEqual(f.store.getTask(task.task.id), restored);
  }
});

test("opening an existing database migrates sequence and urgent priority without losing task data", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "avana-legacy-"));
  const file = join(dir, "test.sqlite");
  const config = {
    autoBackup: false,
    backupDirectory: join(dir, "backups"),
    clock: () => "2026-10-16T15:00:00.000Z",
  };
  let store = createStore(file, config);
  t.after(() => {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let task = store.createTask({ title: "Preservar tarefa legada" });
  task = act(store, task, "comment", { body: "Comentário preservado" });
  const originalPosition = task.task.position;
  const originalVersion = task.task.version;
  store.close();
  store = null;
  const legacy = new DatabaseSync(file);
  try {
    legacy.exec("PRAGMA foreign_keys = OFF");
    legacy.exec("ALTER TABLE tasks DROP COLUMN executionOrder");
    // Rebuild only this temporary fixture with the original priority CHECK.
    const previousSchema = legacy
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type='table' AND name='tasks'",
      )
      .get()
      .sql.replace("CREATE TABLE tasks", "CREATE TABLE legacy_tasks")
      .replace(
        "priority IN ('','low','medium','high')",
        "priority IN ('','low','medium','high','urgent')",
      );
    legacy.exec("BEGIN");
    legacy.exec(previousSchema);
    legacy.exec("INSERT INTO legacy_tasks SELECT * FROM tasks");
    legacy.exec("DROP TABLE tasks");
    legacy.exec("ALTER TABLE legacy_tasks RENAME TO tasks");
    legacy
      .prepare("UPDATE tasks SET priority='urgent' WHERE id=?")
      .run(task.task.id);
    legacy
      .prepare(
        "INSERT INTO activity (id,taskId,type,summary,before,after,createdAt,author) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        task.task.id,
        "edit",
        "Prioridade legada",
        "{}",
        '{"priority":"urgent"}',
        "2026-10-16T14:00:00.000Z",
        "Você",
      );
    legacy.exec("COMMIT");
  } finally {
    legacy.close();
  }
  store = createStore(file, config);
  const migrated = store.getTask(task.task.id);
  assert.equal(migrated.task.executionOrder, null);
  assert.equal(migrated.task.priority, "high");
  assert.equal(migrated.task.position, originalPosition);
  assert.equal(migrated.task.version, originalVersion + 1);
  assert.equal(migrated.comments[0].body, "Comentário preservado");
  assert.ok(
    migrated.activity.some(
      (event) => event.type === "edit" && event.after.priority === "urgent",
    ),
  );
  assert.equal(
    migrated.activity.filter((event) => event.type === "priorityNormalized")
      .length,
    1,
  );
  store.close();
  store = createStore(file, config);
  assert.equal(
    store
      .getTask(task.task.id)
      .activity.filter((event) => event.type === "priorityNormalized").length,
    1,
  );
  task = act(store, store.getTask(task.task.id), "edit", {
    fields: { executionOrder: 1 },
  });
  assert.equal(task.task.executionOrder, 1);
});

test("archiving preserves records and rejects mutations; deleting and restoring retain history", (t) => {
  const f = fixture(t);
  let task = f.store.createTask({ title: "Preservar" });
  const projectId = task.task.projectId;
  task = act(f.store, task, "comment", { body: "Observação importante" });
  f.store.updateProject(projectId, { archived: true });
  assert.equal(f.store.getTask(task.task.id).comments.length, 1);
  assert.throws(
    () => act(f.store, task, "complete"),
    errorCode("PROJECT_ARCHIVED"),
  );
  assert.throws(
    () => f.store.createTask({ title: "Nova", projectId }),
    errorCode("PROJECT_ARCHIVED"),
  );
  f.store.updateProject(projectId, { archived: false });
  task = act(f.store, task, "delete");
  assert.ok(task.task.deletedAt);
  assert.throws(
    () => act(f.store, task, "comment", { body: "Bloqueada" }),
    errorCode("TASK_DELETED"),
  );
  task = act(f.store, task, "restore");
  assert.equal(task.task.deletedAt, null);
  assert.equal(task.comments.length, 1);
  f.store.updateProject(projectId, { deleted: true });
  assert.equal(f.store.bootstrap().tasks.length, 1);
  f.store.updateProject(projectId, { deleted: false });
  assert.equal(f.store.getTask(task.task.id).comments.length, 1);
});

test("expired trash is purged after 30 days without deleting unrelated tasks", (t) => {
  const f = fixture(t);
  let deleted = f.store.createTask({ title: "Excluir" });
  const kept = f.store.createTask({ title: "Manter" });
  deleted = act(f.store, deleted, "complete");
  deleted = act(f.store, deleted, "delete");
  f.setTime("2026-11-16T15:00:00.000Z");
  const result = f.store.bootstrap();
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].id, kept.task.id);
  assert.throws(() => f.store.getTask(deleted.task.id), errorCode("NOT_FOUND"));
});

test("export, backups and restore preserve relational links and reject invalid import atomically", (t) => {
  const f = fixture(t);
  let task = f.store.createTask({ title: "Exportável" });
  task = act(f.store, task, "subtaskAdd", { title: "Detalhe" });
  task = act(f.store, task, "complete", {
    note: "Prova",
    confirmPending: true,
  });
  const exported = f.store.exportData();
  const backup = f.store.backup();
  assert.ok(existsSync(backup.path));
  assert.equal(JSON.parse(readFileSync(backup.path, "utf8")).format, "avana");
  task = act(f.store, task, "reopen");
  f.store.restore(exported);
  const restored = f.store.getTask(task.task.id);
  assert.equal(
    restored.task.completedAt,
    exported.data.completions[0].completedAt,
  );
  assert.equal(restored.comments[0].completionId, restored.task.completionId);
  assert.equal(restored.subtasks.length, 1);
  const broken = structuredClone(exported);
  broken.data.tasks[0].projectId = randomUUID();
  assert.throws(() => f.store.restore(broken));
  assert.deepEqual(f.store.getTask(task.task.id), restored);
  const badHold = structuredClone(exported);
  badHold.data.tasks[0].section = "hold";
  badHold.data.tasks[0].completionId = null;
  assert.throws(() => f.store.restore(badHold));
  assert.deepEqual(f.store.getTask(task.task.id), restored);
});

test("idempotency covers creation and detects reuse for different input", (t) => {
  const f = fixture(t);
  const key = randomUUID(),
    payload = { title: "Criada uma vez" };
  const create = () =>
    f.store.executeRequest(key, "POST /api/tasks", payload, () =>
      f.store.createTask(payload),
    );
  const first = create();
  assert.deepEqual(create(), first);
  assert.equal(f.store.bootstrap().tasks.length, 1);
  f.reopen();
  assert.deepEqual(create(), first);
  assert.throws(
    () =>
      f.store.executeRequest(
        key,
        "POST /api/tasks",
        { title: "Outra" },
        () => null,
      ),
    errorCode("IDEMPOTENCY_CONFLICT"),
  );
});

test("project creation accepts the UI evidence policy and full settings persist backup directory", (t) => {
  const f = fixture(t);
  const project = f.store.createProject({
    name: "Projeto",
    description: "",
    color: "#9470d8",
    requireEvidence: true,
  });
  assert.equal(project.requireEvidence, true);
  assert.equal(
    f.store.createProject({ name: "Padrão" }).requireEvidence,
    false,
  );
  const target = join(f.dir, "separate-backups");
  const settings = f.store.updateSettings({
    ...f.store.bootstrap().settings,
    backupDirectory: target,
  });
  assert.equal(settings.backupDirectory, target);
  assert.ok(f.store.backup().path.startsWith(target));
  f.reopen();
  assert.equal(f.store.bootstrap().settings.backupDirectory, target);
  assert.throws(() =>
    f.store.updateSettings({ backupDirectory: "relative/path" }),
  );
  assert.equal(f.store.bootstrap().settings.backupDirectory, target);
  const exported = f.store.exportData();
  exported.data.settings[0].backupDirectory = join(
    f.dir,
    "other-machine-directory",
  );
  f.store.restore(exported);
  assert.equal(f.store.bootstrap().settings.backupDirectory, target);
  const reset = f.store.updateSettings({ backupDirectory: "" });
  assert.equal(reset.backupDirectory, join(f.dir, "backups"));
  assert.ok(f.store.backup().path.startsWith(join(f.dir, "backups")));
  f.reopen();
  assert.equal(
    f.store.bootstrap().settings.backupDirectory,
    join(f.dir, "backups"),
  );
});

test("idempotent replay returns current task state and 100 comment exports grow linearly", (t) => {
  const f = fixture(t);
  let task = f.store.createTask({ title: "Histórico compacto" });
  const firstInput = {
    action: "comment",
    body: "Primeiro registro",
    version: task.task.version,
    commandId: randomUUID(),
  };
  const firstKey = randomUUID();
  task = f.store.executeRequest(
    firstKey,
    "POST /api/tasks/command",
    firstInput,
    () => f.store.command(task.task.id, firstInput),
  );
  let halfwayBytes = 0;
  for (let index = 0; index < 100; index += 1) {
    const input = {
      action: "comment",
      body: `${index}: ${"x".repeat(250)}`,
      version: task.task.version,
      commandId: randomUUID(),
    };
    task = f.store.executeRequest(
      randomUUID(),
      "POST /api/tasks/command",
      input,
      () => f.store.command(task.task.id, input),
    );
    if (index === 49)
      halfwayBytes = Buffer.byteLength(JSON.stringify(f.store.exportData()));
  }
  const exported = f.store.exportData();
  const bytes = Buffer.byteLength(JSON.stringify(exported));
  assert.ok(bytes < 600000, `100 comments generated ${bytes} bytes`);
  assert.ok(
    bytes < halfwayBytes * 2.7,
    `Export grew from ${halfwayBytes} to ${bytes}`,
  );
  assert.equal(task.comments.length, 101);
  assert.deepEqual(f.store.command(task.task.id, firstInput), task);
  assert.deepEqual(
    f.store.executeRequest(
      firstKey,
      "POST /api/tasks/command",
      firstInput,
      () => assert.fail("Replay must not run again"),
    ),
    task,
  );
  const commentEvents = task.activity.filter(
    (event) => event.type === "comment",
  );
  assert.ok(
    commentEvents.every(
      (event) =>
        event.before.comments.length === 0 && event.after.comments.length === 1,
    ),
  );
  f.store.restore(exported);
  assert.deepEqual(f.store.getTask(task.task.id), task);
  f.reopen();
  assert.deepEqual(f.store.command(task.task.id, firstInput), task);
});

test("HTTP exposes contract and protects Host and Origin; create retry does not duplicate", async (t) => {
  const f = fixture(t);
  const server = createServer({
    dataDir: f.dir,
    store: f.store,
    distDir: join(f.dir, "absent-dist"),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, app: "avana" });
  const foreign = await fetch(`${base}/api/bootstrap`, {
    headers: { Origin: "https://attacker.example" },
  });
  assert.equal(foreign.status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const request = httpRequest(
      `${base}/api/bootstrap`,
      { headers: { Host: `attacker.example:${server.address().port}` } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(wrongHost, 403);
  const headers = {
    "Content-Type": "application/json",
    "Idempotency-Key": randomUUID(),
    Origin: "http://127.0.0.1:5173",
  };
  const request = () =>
    fetch(`${base}/api/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Via API" }),
    });
  const created = await request();
  assert.equal(created.status, 201);
  const data = await created.json();
  assert.equal(data.task.section, "backlog");
  assert.deepEqual(await (await request()).json(), data);
  assert.equal(f.store.bootstrap().tasks.length, 1);
  const download = await fetch(`${base}/api/export`);
  assert.ok(download.headers.get("content-disposition").includes("attachment"));
  assert.equal((await download.json()).version, 1);
});
