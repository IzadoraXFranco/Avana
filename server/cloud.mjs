import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "./store.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tables = ["projects", "tasks", "subtasks", "comments", "activity", "holds", "followUps", "completions"];
const canonical = (value) => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const fail = (message, status = 400, code = "VALIDATION_ERROR") => { throw new AppError(message, status, code); };
const digest = (data) => createHash("sha256").update(canonical(data)).digest("hex");

export function validateCloudConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("Configuração inválida.");
  let url;
  try { url = new URL(input.url); } catch { fail("Informe a URL HTTPS do projeto Supabase."); }
  if (url.protocol !== "https:" || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) ||
      url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash)
    fail("Use a URL HTTPS hospedada do projeto Supabase, sem caminhos ou credenciais.");
  const key = input.publishableKey;
  if (typeof key !== "string" || key.length > 8192 || key !== key.trim())
    fail("Informe somente a chave pública publicável ou anon.");
  let valid = /^sb_publishable_[A-Za-z0-9_-]{12,}$/.test(key);
  if (!valid && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) {
    try {
      const claims = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8"));
      valid = claims.role === "anon" && (!claims.ref || claims.ref === url.hostname.split(".")[0]);
    } catch { /* A secret, service-role token or malformed JWT is never accepted. */ }
  }
  if (!valid) fail("Use somente a chave pública publicável ou anon. Chaves secretas e service_role são proibidas.", 400, "INVALID_PUBLIC_KEY");
  return { url: url.origin, publishableKey: key };
}

function atomicJSON(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx", flush: true });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function normalized(value, key = "") {
  if (typeof value === "string" && (key === "before" || key === "after")) {
    try { return normalized(JSON.parse(value)); } catch { return value; }
  }
  if (typeof value === "string" && /(?:At|Since)$/.test(key) &&
      /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(value) && Number.isFinite(Date.parse(value)))
    return new Date(value).toISOString();
  if (["favorite", "requireEvidence"].includes(key) && (value === 0 || value === 1)) return Boolean(value);
  if (Array.isArray(value)) return value.map((item) => normalized(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([field]) => !["workspaceId", "userId", "backupDirectory"].includes(field))
    .map(([field, item]) => [field, normalized(item, field)]));
  return value;
}

function verifiedReceipt(value, sourceId) {
  if (!value || value.sourceId !== sourceId || !uuid.test(value.workspaceId || "") ||
      !/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(value.hash || "") || !value.counts || typeof value.counts !== "object" || Array.isArray(value.counts) ||
      Object.values(value.counts).some((count) => !Number.isSafeInteger(count) || count < 0))
    fail("O recibo de importação não corresponde à origem congelada.", 409, "IMPORT_VERIFICATION_FAILED");
  const receipt = { sourceId: value.sourceId, hash: value.hash, workspaceId: value.workspaceId, counts: value.counts };
  if (value.settingsApplied !== undefined) {
    if (typeof value.settingsApplied !== "boolean") fail("Recibo de importação inválido.", 409, "IMPORT_VERIFICATION_FAILED");
    receipt.settingsApplied = value.settingsApplied;
  }
  return receipt;
}

function verifyExport(snapshot, remote, receipt, userId) {
  const mismatch = (label) => fail(`A verificação da migração encontrou diferenças em ${label}. A base local continua preservada e congelada.`, 409, "IMPORT_VERIFICATION_FAILED");
  if (remote?.format !== "avana" || remote.version !== 1 || !remote.data) mismatch("formato da exportação");
  const data = remote.data;
  if (data.workspaces?.length !== 1 || data.workspaces[0].id !== receipt.workspaceId ||
      data.users?.length !== 1 || data.users[0].id !== userId ||
      !data.memberships?.some((row) => row.workspaceId === receipt.workspaceId && row.userId === userId && row.role === "owner"))
    mismatch("identidade e workspace");
  for (const table of tables) {
    if (!Array.isArray(data[table])) mismatch(table);
    const imported = snapshot.data[table];
    const byId = new Map(data[table].map((row) => [row.id, row]));
    if (byId.size !== data[table].length) mismatch(`${table}: identificadores duplicados`);
    if (receipt.counts[table] !== undefined && receipt.counts[table] !== imported.length) mismatch(`${table}: contagem`);
    for (const expected of imported) {
      const actual = byId.get(expected.id);
      if (!actual || (actual.workspaceId !== undefined && actual.workspaceId !== receipt.workspaceId) ||
          canonical(normalized(expected)) !== canonical(normalized(actual))) mismatch(`${table}: ${expected.id}`);
    }
  }
  if (!Number.isSafeInteger(receipt.counts.tasks) || !Number.isSafeInteger(receipt.counts.projects)) mismatch("contagens do recibo");
  if (receipt.settingsApplied !== false) {
    if (data.settings?.length !== 1 || canonical(normalized(snapshot.data.settings[0])) !== canonical(normalized(data.settings[0]))) mismatch("preferências");
  }
}

/** Keeps the SQLite source locked from the first migration attempt, including after a restart. */
export function createCloudCoordinator(dataDir, options = {}) {
  const statePath = join(dataDir, "cloud-state.json");
  const fetchRemote = options.fetch || globalThis.fetch;
  let state = { version: 1, state: "local" };
  if (existsSync(statePath)) {
    try {
      state = JSON.parse(readFileSync(statePath, "utf8"));
      if (state.version !== 1 || !["local", "configured", "frozen", "cloud"].includes(state.state)) throw Error();
      if (Object.keys(state).some((key) => !["version", "state", "config", "sourceId", "migrationId", "targetUserId", "hash", "receipt"].includes(key))) throw Error();
      if (state.sourceId !== undefined && !uuid.test(state.sourceId)) throw Error();
      if (state.hash !== undefined && !/^[a-f0-9]{64}$/.test(state.hash)) throw Error();
      if (state.state === "local" && (state.config || state.migrationId || state.targetUserId || state.hash || state.receipt)) throw Error();
      if (state.state === "configured" && (state.migrationId || state.targetUserId || state.hash || state.receipt)) throw Error();
      if (state.state !== "local") state.config = validateCloudConfig(state.config);
      if (["frozen", "cloud"].includes(state.state) &&
          (![state.sourceId, state.migrationId, state.targetUserId].every((id) => uuid.test(id || "")))) throw Error();
      if (state.state === "cloud") {
        if (!state.hash) throw Error();
        state.receipt = verifiedReceipt(state.receipt, state.sourceId);
      }
    } catch { fail("O estado da migração local está inválido. A base não foi aberta para escrita.", 503, "CLOUD_STATE_INVALID"); }
  }
  const isLocked = () => ["frozen", "cloud"].includes(state.state);
  function status() {
    return { state: state.state, ...(state.config && { config: state.config }),
      ...(state.targetUserId && { targetUserId: state.targetUserId }), ...(state.receipt && { receipt: state.receipt }) };
  }
  function persist(next) {
    // Keep the in-memory lock even if persistence fails; no import payload is released before durable state.
    state = next;
    try { mkdirSync(dataDir, { recursive: true }); atomicJSON(statePath, state); }
    catch { fail("Não foi possível gravar o estado da migração. Tente novamente; a base permanece protegida.", 503, "CLOUD_STATE_WRITE_FAILED"); }
  }
  function assertWritable() {
    if (isLocked()) fail("A base local está congelada. Retome a migração ou use a nuvem.", 409, "LOCAL_FROZEN");
  }
  function configure(input) {
    assertWritable();
    const config = validateCloudConfig(input);
    persist({ version: 1, state: "configured", config, sourceId: state.sourceId || randomUUID() });
    return status();
  }
  function cancel() {
    assertWritable();
    persist({ version: 1, state: "local", ...(state.sourceId && { sourceId: state.sourceId }) });
    return status();
  }
  const snapshotPath = () => join(dataDir, `migration-${state.migrationId}.json`);
  function snapshot() {
    try {
      const value = JSON.parse(readFileSync(snapshotPath(), "utf8"));
      if (value.format !== "avana" || value.version !== 1 || !value.data || (state.hash && digest(value) !== state.hash)) throw Error();
      return value;
    } catch { fail("O snapshot de migração está ausente ou inválido. A base local continua congelada.", 503, "MIGRATION_SNAPSHOT_INVALID"); }
  }
  function freeze(input, store) {
    if (!uuid.test(input?.userId || "")) fail("Usuário autenticado inválido.");
    if (state.state === "local") fail("Configure primeiro o destino da nuvem.", 409, "CLOUD_NOT_CONFIGURED");
    if (isLocked() && state.targetUserId !== input.userId) fail("A migração está vinculada a outra conta. Entre na conta original.", 409, "MIGRATION_ACCOUNT_MISMATCH");
    store.setFrozenGuard?.(isLocked);
    persist({ ...state, state: state.state === "cloud" ? "cloud" : "frozen", targetUserId: input.userId,
      migrationId: state.migrationId || randomUUID(), sourceId: state.sourceId || randomUUID() });
    if (!existsSync(snapshotPath())) {
      if (state.hash || state.state === "cloud") return snapshot();
      store.backup("before-cloud");
      try { atomicJSON(snapshotPath(), store.exportData()); }
      catch { fail("Não foi possível gravar o snapshot. Tente novamente; a base continua congelada.", 503, "MIGRATION_SNAPSHOT_WRITE_FAILED"); }
    }
    const data = snapshot();
    const hash = digest(data);
    if (!state.hash) persist({ ...state, hash });
    return { migrationId: state.migrationId, sourceId: state.sourceId, hash, data };
  }
  async function remote(path, accessToken, payload) {
    let response;
    try {
      response = await fetchRemote(`${state.config.url}${path}`, {
        method: payload ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(15000),
        headers: { apikey: state.config.publishableKey, Authorization: `Bearer ${accessToken}`, ...(payload && { "Content-Type": "application/json" }) },
        ...(payload && { body: JSON.stringify(payload) }),
      });
    } catch { fail("Não foi possível verificar a nuvem. Tente novamente; a base continua congelada.", 503, "CLOUD_UNAVAILABLE"); }
    let result;
    try { result = await response.json(); } catch { fail("A nuvem retornou uma resposta inválida.", 502, "CLOUD_INVALID_RESPONSE"); }
    if (!response.ok) {
      let detail;
      if (result?.code === "P0001") { try { detail = JSON.parse(result.message); } catch {} }
      if (detail && typeof detail.error === "string" && typeof detail.code === "string" && Number.isInteger(detail.status) && detail.status >= 400 && detail.status <= 599)
        fail(detail.error, detail.status, detail.code);
      fail(response.status === 401 || response.status === 403 ? "A sessão da nuvem expirou ou não tem acesso. Entre novamente." : "A nuvem não confirmou a migração. Tente novamente.",
        response.status === 401 || response.status === 403 ? 401 : 502, response.status === 401 || response.status === 403 ? "CLOUD_UNAUTHORIZED" : "CLOUD_REQUEST_FAILED");
    }
    return result;
  }
  const rpc = (path, accessToken) => remote("/rest/v1/rpc/avana_api", accessToken,
    { p_method: "GET", p_path: path, p_body: {}, p_request_id: randomUUID() });
  let activating = false;
  async function activate(input) {
    if (!isLocked()) fail("Congele a origem antes de ativar a nuvem.", 409, "MIGRATION_NOT_FROZEN");
    if (typeof input?.accessToken !== "string" || input.accessToken.length < 10 || input.accessToken.length > 16384 || /\s/.test(input.accessToken))
      fail("Sessão da nuvem inválida.", 401, "CLOUD_UNAUTHORIZED");
    if (activating) fail("A verificação da migração já está em andamento.", 409, "MIGRATION_BUSY");
    activating = true;
    try {
      const user = await remote("/auth/v1/user", input.accessToken);
      if (user?.id !== state.targetUserId) fail("A sessão pertence a outra conta. Entre na conta usada ao congelar a base.", 403, "MIGRATION_ACCOUNT_MISMATCH");
      const supplied = verifiedReceipt(input.receipt, state.sourceId);
      const authenticated = verifiedReceipt(await rpc(`/api/imports/${state.sourceId}`, input.accessToken), state.sourceId);
      if (canonical(supplied) !== canonical(authenticated)) fail("O recibo informado não corresponde à importação autenticada.", 409, "IMPORT_VERIFICATION_FAILED");
      // A lost activation response can be retried after subsequent legitimate cloud edits.
      if (state.state === "cloud") {
        if (canonical(state.receipt) !== canonical(authenticated)) fail("O recibo da migração foi alterado.", 409, "IMPORT_VERIFICATION_FAILED");
        return status();
      }
      const data = snapshot();
      const exported = await rpc("/api/export", input.accessToken);
      verifyExport(data, exported, authenticated, user.id);
      persist({ ...state, state: "cloud", receipt: authenticated });
      return status();
    } finally { activating = false; }
  }
  return { status, isLocked, assertWritable, configure, cancel, freeze, activate,
    connectSources: () => state.config ? `${state.config.url} ${state.config.url.replace(/^https:/, "wss:")}` : "" };
}
