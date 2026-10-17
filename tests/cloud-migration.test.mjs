import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "../server/index.mjs";
import { AppError } from "../server/store.mjs";

const config = { url: "https://avana-test.supabase.co", publishableKey: "sb_publishable_testpublickey123456789" };
const token = "test-private-access-token-never-persist";
const domain = ["projects", "tasks", "completions", "subtasks", "comments", "activity", "holds", "followUps"];
const code = (expected) => (error) => error.code === expected;

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "avana-cloud-migration-"));
  const owner = randomUUID(), workspace = randomUUID();
  let instant = "2026-10-20T12:00:00.000Z";
  let server, receipt, exported, authOwner = owner, remoteFailure;
  const calls = [];
  const options = {
    dataDir: directory,
    storeOptions: { autoBackup: false, clock: () => instant, backupDirectory: join(directory, "backups") },
    fetch: async (url, input) => {
      assert.equal(input.headers.Authorization, `Bearer ${token}`);
      assert.equal(input.headers.apikey, config.publishableKey);
      assert.equal(input.redirect, "error");
      calls.push(url);
      if (remoteFailure) return remoteFailure(url, input);
      if (url.endsWith("/auth/v1/user")) return Response.json({ id: authOwner });
      const payload = JSON.parse(input.body);
      assert.equal(payload.p_method, "GET");
      assert.ok(payload.p_request_id);
      if (payload.p_path.startsWith("/api/imports/")) return Response.json(receipt);
      if (payload.p_path === "/api/export") return Response.json(exported);
      throw Error("Unexpected remote route");
    },
  };
  const open = async () => {
    server = createServer(options);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  };
  const close = async () => { if (server.listening) await new Promise((resolve) => server.close(resolve)); };
  await open();
  t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
  const request = async (path, method = "GET", value) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { "Content-Type": "application/json" }, ...(value !== undefined && { body: JSON.stringify(value) }),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  return {
    directory, owner, workspace, request, calls,
    get server() { return server; }, get receipt() { return receipt; }, get exported() { return exported; },
    setTime: (value) => { instant = value; },
    setAuthOwner: (value) => { authOwner = value; },
    setRemoteFailure: (value) => { remoteFailure = value; },
    restart: async () => { await close(); await open(); },
    configure: () => request("/api/cloud/config", "POST", config),
    freeze: () => request("/api/cloud/freeze", "POST", { userId: owner }),
    activate: () => request("/api/cloud/activate", "POST", { accessToken: token, receipt }),
    prepareRemote(snapshot) {
      receipt = { sourceId: snapshot.sourceId, hash: "a".repeat(32), workspaceId: workspace,
        counts: Object.fromEntries(domain.map((table) => [table, snapshot.data.data[table].length])), settingsApplied: true };
      exported = structuredClone(snapshot.data);
      exported.exportedAt = "2026-10-21T10:00:00+00:00";
      exported.data.workspaces = [{ id: workspace, name: "Conta remota", createdAt: exported.exportedAt }];
      exported.data.users = [{ id: owner, name: "Usuário remoto" }];
      exported.data.memberships = [{ workspaceId: workspace, userId: owner, role: "owner" }];
      exported.data.commands = [];
      exported.data.requests = [];
      for (const table of [...domain, "settings"]) for (const row of exported.data[table]) {
        row.workspaceId = workspace;
        for (const [key, value] of Object.entries(row)) {
          if (["favorite", "requireEvidence"].includes(key)) row[key] = Boolean(value);
          if (typeof value === "string" && key.endsWith("At")) row[key] = value.replace(".000Z", "+00:00");
          if (["before", "after"].includes(key)) row[key] = JSON.parse(value);
        }
      }
      exported.data.settings[0].backupDirectory = null;
      return receipt;
    },
  };
}

function filledTask(store) {
  let detail = store.createTask({ title: "Tarefa de migração" });
  const act = (action, fields = {}) => detail = store.command(detail.task.id, {
    action, version: detail.task.version, commandId: randomUUID(), ...fields,
  });
  act("edit", { fields: { executionOrder: 2, priority: "high", dueDate: "2026-10-22" } });
  act("subtaskAdd", { title: "Conferir documento" });
  act("comment", { body: "Evidência de acompanhamento" });
  act("complete", { note: "Entrega inicial", confirmPending: true });
  act("reopen", { section: "today" });
  act("move", { section: "hold", reason: "Aguardando retorno", waitingFor: "Fornecedor fictício", followUpDate: "2026-10-21" });
  return detail;
}

test("configuration rejects secret keys and unsafe URLs, exposes only public config, and updates CSP", async (t) => {
  const f = await fixture(t);
  const jwt = (role) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ role, ref: "avana-test" })).toString('base64url')}.signature`;
  for (const publishableKey of ["sb_secret_sensitive", jwt("service_role"), token]) {
    const response = await f.request("/api/cloud/config", "POST", { ...config, publishableKey });
    assert.equal(response.status, 400);
    assert.equal(response.data.code, "INVALID_PUBLIC_KEY");
  }
  for (const url of ["http://avana-test.supabase.co", "https://127.0.0.1", "https://avana-test.supabase.co.evil.example", "https://user:pass@avana-test.supabase.co", `${config.url}/rest/v1`, `${config.url}?a=b`])
    assert.equal((await f.request("/api/cloud/config", "POST", { ...config, url })).status, 400);
  assert.equal((await f.request("/api/cloud/config", "POST", { ...config, publishableKey: jwt("anon") })).status, 200);
  assert.equal((await f.configure()).data.state, "configured");
  const status = await f.request("/api/cloud/status");
  assert.deepEqual(status.data, { state: "configured", config });
  assert.match(status.headers.get("content-security-policy"), /connect-src 'self' https:\/\/avana-test\.supabase\.co wss:\/\/avana-test\.supabase\.co/);
  assert.equal((await f.request("/api/cloud/cancel", "POST", {})).data.state, "local");
  assert.equal((await f.request("/api/cloud/status")).data.config, undefined);
});

test("freeze persists an immutable backup and locks every local mutation, including direct store writes", async (t) => {
  const f = await fixture(t);
  const task = filledTask(f.server.store);
  await f.configure();
  const frozen = await f.freeze();
  assert.equal(frozen.status, 200);
  assert.match(frozen.data.hash, /^[a-f0-9]{64}$/);
  assert.equal(readdirSync(join(f.directory, "backups")).filter((name) => name.includes("before-cloud")).length, 1);
  f.setTime("2026-10-21T12:00:00.000Z");
  assert.deepEqual((await f.freeze()).data, frozen.data);
  for (const [path, method] of [["/api/tasks", "POST"], ["/api/projects", "POST"], ["/api/settings", "PATCH"],
    [`/api/tasks/${task.task.id}/command`, "POST"], [`/api/projects/${task.task.projectId}`, "PATCH"],
    ["/api/restore", "POST"], ["/api/backup", "POST"], ["/api/future-mutation", "POST"], ["/api/cloud/cancel", "POST"], ["/api/cloud/config", "POST"]]) {
    const response = await f.request(path, method, {});
    assert.equal(response.status, 409, path);
    assert.equal(response.data.code, "LOCAL_FROZEN", path);
  }
  assert.throws(() => f.server.store.createTask({ title: "Não deve entrar" }), code("LOCAL_FROZEN"));
  assert.equal((await f.request("/api/bootstrap")).data.tasks.length, 1);
  assert.equal((await f.request(`/api/tasks/${task.task.id}`)).data.task.title, task.task.title);
  assert.equal((await f.request("/api/cloud/freeze", "POST", { userId: randomUUID() })).data.code, "MIGRATION_ACCOUNT_MISMATCH");
});

test("frozen restart skips purge, startup migrations and daily backup while preserving deleted records", async (t) => {
  const f = await fixture(t);
  const task = f.server.store.createTask({ title: "Histórico excluído" });
  f.server.store.command(task.task.id, { action: "delete", version: task.task.version, commandId: randomUUID() });
  await f.configure();
  const frozen = (await f.freeze()).data;
  const original = f.server.store.exportData().data;
  f.setTime("2026-12-25T12:00:00.000Z");
  await f.restart();
  assert.equal((await f.request("/api/cloud/status")).data.state, "frozen");
  f.server.store.maintenance();
  await f.request("/api/bootstrap");
  assert.deepEqual(f.server.store.exportData().data, original);
  assert.deepEqual((await f.freeze()).data, frozen);
  assert.throws(() => f.server.store.updateSettings({ theme: "dark" }), code("LOCAL_FROZEN"));
  assert.equal(readdirSync(join(f.directory, "backups")).length, 1);
});

test("a failed backup leaves a durable lock and retry uses the same migration identity", async (t) => {
  const f = await fixture(t);
  f.server.store.createTask({ title: "Preservar durante falha" });
  await f.configure();
  const backup = f.server.store.backup;
  f.server.store.backup = () => { throw new AppError("Falha simulada", 503, "BACKUP_FAILED"); };
  assert.equal((await f.freeze()).data.code, "BACKUP_FAILED");
  const failedState = JSON.parse(readFileSync(join(f.directory, "cloud-state.json"), "utf8"));
  assert.equal(failedState.state, "frozen");
  assert.equal((await f.request("/api/tasks", "POST", { title: "Bloqueada" })).status, 409);
  f.server.store.backup = backup;
  await f.restart();
  const retry = await f.freeze();
  assert.equal(retry.status, 200);
  assert.equal(retry.data.migrationId, failedState.migrationId);
  assert.equal(retry.data.sourceId, failedState.sourceId);
});

test("activation authenticates the target account and receipt instead of trusting client data", async (t) => {
  const f = await fixture(t);
  filledTask(f.server.store);
  await f.configure();
  f.prepareRemote((await f.freeze()).data);
  f.setAuthOwner(randomUUID());
  assert.equal((await f.activate()).data.code, "MIGRATION_ACCOUNT_MISMATCH");
  assert.equal(f.calls.length, 1);
  f.setAuthOwner(f.owner);
  const forged = await f.request("/api/cloud/activate", "POST", { accessToken: token, receipt: { ...f.receipt, hash: "b".repeat(32) } });
  assert.equal(forged.data.code, "IMPORT_VERIFICATION_FAILED");
  assert.equal((await f.request("/api/cloud/status")).data.state, "frozen");
  assert.equal((await f.activate()).data.state, "cloud");
  assert.ok(!readFileSync(join(f.directory, "cloud-state.json"), "utf8").includes(token));
});

test("activation verifies every imported row and link, tolerates identity/time/bool normalization, and preserves remote extras", async (t) => {
  const f = await fixture(t);
  filledTask(f.server.store);
  await f.configure();
  f.prepareRemote((await f.freeze()).data);
  f.exported.data.projects.push({ ...f.exported.data.projects[0], id: randomUUID(), name: "Projeto já na nuvem" });
  for (const [table, field, changed] of [["tasks", "title", "Conteúdo divergente"], ["tasks", "projectId", randomUUID()],
    ["comments", "body", "Evidência divergente"], ["activity", "before", { altered: true }], ["subtasks", "taskId", randomUUID()]]) {
    const previous = f.exported.data[table][0][field];
    f.exported.data[table][0][field] = changed;
    assert.equal((await f.activate()).data.code, "IMPORT_VERIFICATION_FAILED", `${table}.${field}`);
    assert.equal(f.server.cloud.status().state, "frozen");
    f.exported.data[table][0][field] = previous;
  }
  assert.equal((await f.activate()).data.state, "cloud");
  assert.throws(() => f.server.store.createTask({ title: "Outra fonte" }), code("LOCAL_FROZEN"));
  await f.restart();
  assert.equal((await f.request("/api/cloud/status")).data.state, "cloud");
  f.exported.data.tasks[0].title = "Edição legítima posterior na nuvem";
  assert.equal((await f.activate()).data.state, "cloud", "lost activation response may be retried after cloud edits");
});

test("existing remote preferences are accepted only when the authenticated receipt says they were preserved", async (t) => {
  const f = await fixture(t);
  await f.configure();
  f.prepareRemote((await f.freeze()).data);
  f.exported.data.settings[0].theme = "dark";
  assert.equal((await f.activate()).data.code, "IMPORT_VERIFICATION_FAILED");
  f.receipt.settingsApplied = false;
  assert.equal((await f.activate()).data.state, "cloud");
});

test("network and structured SQL errors keep the source frozen and allow a safe retry", async (t) => {
  const f = await fixture(t);
  await f.configure();
  f.prepareRemote((await f.freeze()).data);
  f.setRemoteFailure(() => { throw new Error("network failure with private internals"); });
  assert.equal((await f.activate()).data.code, "CLOUD_UNAVAILABLE");
  f.setRemoteFailure((url) => url.endsWith("/auth/v1/user") ? Response.json({ id: f.owner }) : Response.json({
    code: "P0001", message: JSON.stringify({ error: "Importação ainda não encontrada.", code: "NOT_FOUND", status: 404 }),
  }, { status: 400 }));
  const missing = await f.activate();
  assert.equal(missing.status, 404);
  assert.equal(missing.data.code, "NOT_FOUND");
  assert.equal(f.server.cloud.status().state, "frozen");
  f.setRemoteFailure(null);
  assert.equal((await f.activate()).data.state, "cloud");
});

test("a corrupted snapshot cannot be silently regenerated or activated", async (t) => {
  const f = await fixture(t);
  f.server.store.createTask({ title: "Snapshot imutável" });
  await f.configure();
  const frozen = (await f.freeze()).data;
  f.prepareRemote(frozen);
  const corrupted = structuredClone(frozen.data);
  corrupted.data.tasks[0].title = "Alteração indevida";
  writeFileSync(join(f.directory, `migration-${frozen.migrationId}.json`), JSON.stringify(corrupted));
  assert.equal((await f.freeze()).data.code, "MIGRATION_SNAPSHOT_INVALID");
  assert.equal((await f.activate()).data.code, "MIGRATION_SNAPSHOT_INVALID");
  assert.equal(f.server.cloud.status().state, "frozen");
});

test("invalid durable migration metadata fails closed before SQLite can be opened", async (t) => {
  const f = await fixture(t);
  await f.configure();
  await f.freeze();
  const path = join(f.directory, "cloud-state.json");
  const frozen = JSON.parse(readFileSync(path, "utf8"));
  for (const invalid of [
    { ...frozen, hash: "corrupted" },
    { ...frozen, state: "cloud" },
    { ...frozen, state: "local" },
    { ...frozen, accessToken: "must-not-be-stored" },
  ]) {
    writeFileSync(path, JSON.stringify(invalid));
    assert.throws(() => createServer({ dataDir: f.directory }), code("CLOUD_STATE_INVALID"));
  }
  writeFileSync(path, JSON.stringify(frozen));
  assert.equal(f.server.cloud.status().state, "frozen");
});
