import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  writeFileSync,
  renameSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve, join, isAbsolute } from "node:path";

export class AppError extends Error {
  constructor(message, status = 400, code = "VALIDATION_ERROR") {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (message, status = 400, code) => {
  throw new AppError(message, status, code);
};
const sections = ["backlog", "hold", "today"];
const priorities = ["", "low", "medium", "high"];
const TABLES = [
  "workspaces",
  "users",
  "memberships",
  "settings",
  "projects",
  "tasks",
  "completions",
  "subtasks",
  "comments",
  "activity",
  "holds",
  "followUps",
  "commands",
  "requests",
];
const bool = (value) => Boolean(value);
const iso = (value) => new Date(value).toISOString();
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
function object(value, label = "Dados") {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} inválidos.`);
  return value;
}
function string(value, label, max = 10000, required = false) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim())
  )
    fail(`${label} inválido${max ? ` (máximo ${max} caracteres)` : ""}.`);
  return value;
}
function date(value, label = "Data") {
  if (value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T12:00:00Z`)) ||
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value
  )
    fail(`${label} inválida.`);
  return value;
}
function timezone(value) {
  string(value, "Fuso", 100, true);
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: value }).format();
  } catch {
    fail("Fuso horário inválido.");
  }
  return value;
}
function timestamp(value, nullable = false) {
  if (nullable && value === null) return;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    iso(value) !== value
  )
    fail("Data e horário inválidos na exportação.");
}
function boolean(value, label) {
  if (typeof value !== "boolean")
    fail(`${label} deve ser verdadeiro ou falso.`);
  return Number(value);
}
function integer(value, label, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) fail(`${label} inválido.`);
  return value;
}
function executionOrder(value) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > 99999)
    fail(
      "A sequência de execução deve ser um número inteiro entre 1 e 99999, ou ficar vazia.",
    );
  return value;
}
function cleanKeys(value, allowed) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`Campo não permitido: ${key}.`);
}

export function localDate(instant, zone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  return ["year", "month", "day"]
    .map((type) => parts.find((part) => part.type === type).value)
    .join("-");
}

/** A relational, local-owner store. All task mutations and their audit events are atomic. */
export function createStore(filePath, options = {}) {
  let frozenGuard = options.isFrozen || (() => false);
  const isFrozen = () => Boolean(frozenGuard());
  const assertWritable = () => {
    if (isFrozen())
      fail("A base local está congelada para a migração. Continue na nuvem ou retome a verificação.", 409, "LOCAL_FROZEN");
  };
  const file = filePath === ":memory:" ? filePath : resolve(filePath);
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const defaultBackupDirectory = resolve(
    options.backupDirectory ||
      process.env.AVANA_BACKUP_DIR ||
      join(file === ":memory:" ? process.cwd() : dirname(file), "backups"),
  );
  const now = () => iso(options.clock ? options.clock() : new Date());
  const readOnly = isFrozen();
  const db = new DatabaseSync(file, { readOnly });
  db.exec(
    `PRAGMA foreign_keys = ON; ${readOnly ? "" : "PRAGMA journal_mode = WAL;"} PRAGMA busy_timeout = 5000;`,
  );
  if (!readOnly) db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memberships (workspaceId TEXT NOT NULL REFERENCES workspaces(id), userId TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role = 'owner'), PRIMARY KEY(workspaceId, userId));
    CREATE TABLE IF NOT EXISTS settings (workspaceId TEXT PRIMARY KEY REFERENCES workspaces(id), name TEXT NOT NULL, timezone TEXT NOT NULL, theme TEXT NOT NULL CHECK(theme IN ('light','dark','system')), backupDirectory TEXT);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', color TEXT NOT NULL, icon TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1)), archivedAt TEXT, deletedAt TEXT, requireEvidence INTEGER NOT NULL DEFAULT 0 CHECK(requireEvidence IN (0,1)), createdAt TEXT NOT NULL, UNIQUE(id, workspaceId));
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id), projectId TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', section TEXT CHECK(section IN ('backlog','hold','today')), completionId TEXT, position REAL NOT NULL, executionOrder INTEGER CHECK(executionOrder IS NULL OR (typeof(executionOrder) = 'integer' AND executionOrder BETWEEN 1 AND 99999)), assignee TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL DEFAULT '' CHECK(priority IN ('','low','medium','high')), plannedDate TEXT, dueDate TEXT, dueTime TEXT, dueTimezone TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, deletedAt TEXT, version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1), FOREIGN KEY(projectId,workspaceId) REFERENCES projects(id,workspaceId), FOREIGN KEY(completionId,id) REFERENCES completions(id,taskId) DEFERRABLE INITIALLY DEFERRED, CHECK((section IS NOT NULL AND completionId IS NULL) OR (section IS NULL AND completionId IS NOT NULL)), CHECK(dueTime IS NULL OR dueDate IS NOT NULL));
    CREATE TABLE IF NOT EXISTS completions (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED, completedAt TEXT NOT NULL, author TEXT NOT NULL, UNIQUE(id,taskId));
    CREATE TABLE IF NOT EXISTS subtasks (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), title TEXT NOT NULL, completedAt TEXT, assignee TEXT NOT NULL DEFAULT '', dueDate TEXT, position REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), body TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('comment','evidence')), completionId TEXT, createdAt TEXT NOT NULL, author TEXT NOT NULL, FOREIGN KEY(completionId,taskId) REFERENCES completions(id,taskId));
    CREATE TABLE IF NOT EXISTS activity (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), type TEXT NOT NULL, summary TEXT NOT NULL, before TEXT NOT NULL, after TEXT NOT NULL, createdAt TEXT NOT NULL, author TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS holds (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), reason TEXT NOT NULL, waitingFor TEXT NOT NULL, nextAction TEXT NOT NULL, startedAt TEXT NOT NULL, endedAt TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_hold ON holds(taskId) WHERE endedAt IS NULL;
    CREATE TABLE IF NOT EXISTS followUps (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), date TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','done','cancelled')), note TEXT NOT NULL, createdAt TEXT NOT NULL, closedAt TEXT, CHECK((status = 'pending' AND closedAt IS NULL) OR (status != 'pending' AND closedAt IS NOT NULL)));
    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_followup ON followUps(taskId) WHERE status = 'pending';
    CREATE TABLE IF NOT EXISTS commands (commandId TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), requestHash TEXT NOT NULL, response TEXT NOT NULL, createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests (requestId TEXT PRIMARY KEY, requestHash TEXT NOT NULL, response TEXT NOT NULL, createdAt TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS task_project_section ON tasks(projectId,section,position);
    CREATE INDEX IF NOT EXISTS task_due ON tasks(dueDate);
    CREATE INDEX IF NOT EXISTS activity_task ON activity(taskId,createdAt);
    CREATE INDEX IF NOT EXISTS subtask_task ON subtasks(taskId,position);
    CREATE INDEX IF NOT EXISTS comment_task ON comments(taskId,createdAt);
    CREATE INDEX IF NOT EXISTS completion_task ON completions(taskId,completedAt);
    CREATE INDEX IF NOT EXISTS followup_date ON followUps(status,date);
  `);
  const get = (sql, ...args) => {
    const row = db.prepare(sql).get(...args);
    return row ? { ...row } : undefined;
  };
  const all = (sql, ...args) =>
    db
      .prepare(sql)
      .all(...args)
      .map((row) => ({ ...row }));
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  if (
    !readOnly &&
    !all("PRAGMA table_info(settings)").some(
      (column) => column.name === "backupDirectory",
    )
  )
    db.exec("ALTER TABLE settings ADD COLUMN backupDirectory TEXT");
  if (
    !readOnly &&
    !all("PRAGMA table_info(tasks)").some(
      (column) => column.name === "executionOrder",
    )
  )
    db.exec(
      "ALTER TABLE tasks ADD COLUMN executionOrder INTEGER CHECK(executionOrder IS NULL OR (typeof(executionOrder) = 'integer' AND executionOrder BETWEEN 1 AND 99999))",
    );
  let transactionDepth = 0;
  function transaction(fn) {
    assertWritable();
    if (transactionDepth) return fn();
    db.exec("BEGIN IMMEDIATE");
    transactionDepth += 1;
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      transactionDepth -= 1;
    }
  }
  function insert(table, row) {
    const keys = Object.keys(row);
    run(
      `INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
      ...Object.values(row),
    );
  }
  if (!get("SELECT id FROM workspaces"))
    transaction(() => {
      const workspaceId = randomUUID(),
        userId = randomUUID(),
        instant = now();
      insert("workspaces", {
        id: workspaceId,
        name: "Pessoal",
        createdAt: instant,
      });
      insert("users", { id: userId, name: "Você" });
      insert("memberships", { workspaceId, userId, role: "owner" });
      insert("settings", {
        workspaceId,
        name: "Você",
        timezone: "America/Sao_Paulo",
        theme: "system",
        backupDirectory: defaultBackupDirectory,
      });
      insert("projects", {
        id: randomUUID(),
        workspaceId,
        name: "Meu trabalho",
        description: "",
        color: "#9470d8",
        icon: "briefcase",
        favorite: 1,
        archivedAt: null,
        deletedAt: null,
        requireEvidence: 0,
        createdAt: instant,
      });
    });
  const scope = () => get("SELECT id FROM workspaces").id;
  if (!readOnly) run(
    "UPDATE settings SET backupDirectory=? WHERE backupDirectory IS NULL",
    defaultBackupDirectory,
  );
  const preferences = () => {
    const { workspaceId, ...settings } = get(
      "SELECT * FROM settings WHERE workspaceId = ?",
      scope(),
    );
    return {
      ...settings,
      backupDirectory: settings.backupDirectory || defaultBackupDirectory,
    };
  };
  const author = () => preferences().name;
  const today = () => localDate(now(), preferences().timezone);
  const projectRow = (id) =>
    get(
      "SELECT * FROM projects WHERE id = ? AND workspaceId = ?",
      id,
      scope(),
    ) || fail("Projeto não encontrado.", 404, "NOT_FOUND");
  const taskRow = (id) =>
    get("SELECT * FROM tasks WHERE id = ? AND workspaceId = ?", id, scope()) ||
    fail("Tarefa não encontrada.", 404, "NOT_FOUND");
  const projectData = (row) => {
    const { workspaceId, ...rest } = row;
    return {
      ...rest,
      favorite: bool(row.favorite),
      requireEvidence: bool(row.requireEvidence),
    };
  };
  function ensureActive(project) {
    if (project.deletedAt)
      fail(
        "Restaure o projeto antes de editar suas tarefas.",
        409,
        "PROJECT_DELETED",
      );
    if (project.archivedAt)
      fail(
        "Restaure o projeto arquivado antes de editar.",
        409,
        "PROJECT_ARCHIVED",
      );
  }
  function taskData(row) {
    const { workspaceId, ...task } = row;
    const hold = get(
      "SELECT * FROM holds WHERE taskId = ? AND endedAt IS NULL",
      task.id,
    );
    const followUp = get(
      "SELECT date FROM followUps WHERE taskId = ? AND status = 'pending'",
      task.id,
    );
    const counts = get(
      "SELECT COUNT(*) AS total, SUM(completedAt IS NOT NULL) AS done FROM subtasks WHERE taskId = ?",
      task.id,
    );
    return {
      ...task,
      completedAt: task.completionId
        ? get(
            "SELECT completedAt FROM completions WHERE id = ?",
            task.completionId,
          ).completedAt
        : null,
      subtaskCount: counts.total,
      subtaskDone: counts.done || 0,
      commentCount: get(
        "SELECT COUNT(*) AS total FROM comments WHERE taskId = ?",
        task.id,
      ).total,
      followUpDate: followUp?.date || null,
      holdReason: hold?.reason || "",
      waitingFor: hold?.waitingFor || "",
      holdSince: hold?.startedAt || null,
      nextAction: hold?.nextAction || "",
    };
  }
  function detail(id) {
    return {
      task: taskData(taskRow(id)),
      subtasks: all(
        "SELECT * FROM subtasks WHERE taskId = ? ORDER BY position,id",
        id,
      ),
      comments: all(
        "SELECT * FROM comments WHERE taskId = ? ORDER BY createdAt,rowid",
        id,
      ),
      activity: all(
        "SELECT * FROM activity WHERE taskId = ? ORDER BY createdAt DESC,rowid DESC",
        id,
      ).map((row) => ({
        ...row,
        before: JSON.parse(row.before),
        after: JSON.parse(row.after),
      })),
      holds: all(
        "SELECT * FROM holds WHERE taskId = ? ORDER BY startedAt,rowid",
        id,
      ),
      followUps: all(
        "SELECT * FROM followUps WHERE taskId = ? ORDER BY createdAt,rowid",
        id,
      ),
      completions: all(
        "SELECT * FROM completions WHERE taskId = ? ORDER BY completedAt,rowid",
        id,
      ),
    };
  }
  function record(taskId, type, summary, before, after, instant = now()) {
    insert("activity", {
      id: randomUUID(),
      taskId,
      type,
      summary,
      before: JSON.stringify(before ?? null),
      after: JSON.stringify(after ?? null),
      createdAt: instant,
      author: author(),
    });
  }
  function position(projectId, section) {
    return (
      (get(
        "SELECT MAX(position) AS value FROM tasks WHERE projectId = ? AND section IS ? AND deletedAt IS NULL",
        projectId,
        section,
      ).value || 0) + 1024
    );
  }
  function exportData() {
    return {
      format: "avana",
      version: 1,
      exportedAt: now(),
      data: Object.fromEntries(
        TABLES.map((table) => [table, all(`SELECT * FROM "${table}"`)]),
      ),
    };
  }
  function backup(label = "manual") {
    const backupDirectory = preferences().backupDirectory;
    mkdirSync(backupDirectory, { recursive: true });
    const name = `avana-${now().replace(/[:.]/g, "-")}-${label}-${randomUUID().slice(0, 8)}.json`;
    const target = join(backupDirectory, name),
      temporary = `${target}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(exportData()), { mode: 0o600 });
      renameSync(temporary, target);
    } catch (error) {
      try {
        if (existsSync(temporary)) unlinkSync(temporary);
      } catch {}
      throw new AppError(
        `Não foi possível criar o backup: ${error.message}`,
        503,
        "BACKUP_FAILED",
      );
    }
    return { ok: true, path: target };
  }
  let lastMaintenanceDay = null;
  function maintenance() {
    if (isFrozen()) return;
    const day = today();
    if (lastMaintenanceDay === day) return;
    if (options.autoBackup !== false && file !== ":memory:") {
      const backupDirectory = preferences().backupDirectory;
      mkdirSync(backupDirectory, { recursive: true });
      const dailyMarker = join(backupDirectory, `daily-${day}.marker`);
      if (!existsSync(dailyMarker)) {
        const result = backup("daily");
        writeFileSync(dailyMarker, result.path, { mode: 0o600 });
      }
      const cutoff = Date.parse(now()) - 30 * 86400000;
      for (const entry of readdirSync(backupDirectory)) {
        const match = entry.match(
          /^avana-(\d{4}-\d{2}-\d{2})T.*-daily-[a-f0-9]{8}\.json$/,
        );
        const marker = entry.match(/^daily-(\d{4}-\d{2}-\d{2})\.marker$/);
        if (
          (match || marker) &&
          Date.parse(`${(match || marker)[1]}T00:00:00Z`) < cutoff
        )
          unlinkSync(join(backupDirectory, entry));
      }
    }
    const cutoff = iso(Date.parse(now()) - 30 * 86400000);
    transaction(() => {
      const expiredProjects = all(
        "SELECT id FROM projects WHERE deletedAt IS NOT NULL AND deletedAt <= ?",
        cutoff,
      ).map((row) => row.id);
      const expiredTasks = all(
        "SELECT id,projectId,deletedAt FROM tasks",
      ).filter(
        (row) =>
          (row.deletedAt && row.deletedAt <= cutoff) ||
          expiredProjects.includes(row.projectId),
      );
      for (const task of expiredTasks) {
        // Break the current-completion cycle before deleting its immutable history.
        run(
          "UPDATE tasks SET completionId = NULL, section = 'backlog' WHERE id = ?",
          task.id,
        );
        for (const table of [
          "commands",
          "subtasks",
          "comments",
          "activity",
          "holds",
          "followUps",
          "completions",
        ])
          run(`DELETE FROM "${table}" WHERE taskId = ?`, task.id);
        run("DELETE FROM tasks WHERE id = ?", task.id);
      }
      for (const id of expiredProjects)
        run("DELETE FROM projects WHERE id = ?", id);
    });
    lastMaintenanceDay = day;
  }
  function bootstrap() {
    maintenance();
    return {
      projects: all(
        "SELECT * FROM projects WHERE workspaceId = ? ORDER BY createdAt,rowid",
        scope(),
      ).map(projectData),
      tasks: all(
        "SELECT * FROM tasks WHERE workspaceId = ? ORDER BY position,createdAt,id",
        scope(),
      ).map(taskData),
      settings: preferences(),
      today: today(),
      serverTime: now(),
    };
  }
  function createProject(input) {
    object(input);
    cleanKeys(input, [
      "name",
      "description",
      "color",
      "icon",
      "requireEvidence",
    ]);
    maintenance();
    const row = {
      id: randomUUID(),
      workspaceId: scope(),
      name: string(input.name, "Nome", 200, true).trim(),
      description: string(input.description ?? "", "Descrição", 100000),
      color: string(input.color ?? "#9470d8", "Cor", 40, true),
      icon: string(input.icon ?? "folder", "Ícone", 80, true),
      favorite: 0,
      archivedAt: null,
      deletedAt: null,
      requireEvidence: boolean(
        input.requireEvidence ?? false,
        "Exigir evidência",
      ),
      createdAt: now(),
    };
    if (!/^#[a-fA-F0-9]{6}$/.test(row.color)) fail("Cor inválida.");
    transaction(() => insert("projects", row));
    return projectData(row);
  }
  function updateProject(id, input) {
    object(input);
    cleanKeys(input, [
      "name",
      "description",
      "color",
      "icon",
      "favorite",
      "archived",
      "deleted",
      "requireEvidence",
    ]);
    maintenance();
    return transaction(() => {
      const row = projectRow(id);
      if (row.deletedAt && input.deleted !== false)
        fail("Restaure o projeto antes de editá-lo.", 409, "PROJECT_DELETED");
      for (const key of ["name", "description", "color", "icon"])
        if (key in input)
          row[key] = string(
            input[key],
            key,
            key === "description" ? 100000 : 200,
            key !== "description",
          ).trim();
      if (!/^#[a-fA-F0-9]{6}$/.test(row.color)) fail("Cor inválida.");
      for (const key of ["favorite", "requireEvidence"])
        if (key in input) row[key] = boolean(input[key], key);
      if ("archived" in input)
        row.archivedAt = boolean(input.archived, "Arquivado")
          ? row.archivedAt || now()
          : null;
      if ("deleted" in input)
        row.deletedAt = boolean(input.deleted, "Excluído")
          ? row.deletedAt || now()
          : null;
      run(
        "UPDATE projects SET name=?,description=?,color=?,icon=?,favorite=?,requireEvidence=?,archivedAt=?,deletedAt=? WHERE id=?",
        row.name,
        row.description,
        row.color,
        row.icon,
        row.favorite,
        row.requireEvidence,
        row.archivedAt,
        row.deletedAt,
        id,
      );
      return projectData(row);
    });
  }
  function updateSettings(input) {
    object(input);
    cleanKeys(input, ["name", "timezone", "theme", "backupDirectory"]);
    return transaction(() => {
      const settings = preferences();
      if ("name" in input)
        settings.name = string(input.name, "Nome", 200, true).trim();
      if ("timezone" in input) settings.timezone = timezone(input.timezone);
      if ("theme" in input) {
        if (!["light", "dark", "system"].includes(input.theme))
          fail("Tema inválido.");
        settings.theme = input.theme;
      }
      if ("backupDirectory" in input) {
        const requestedDirectory = string(
          input.backupDirectory,
          "Pasta de backups",
          4000,
        ).trim();
        if (
          requestedDirectory &&
          (!isAbsolute(requestedDirectory) || requestedDirectory.includes("\0"))
        )
          fail("Informe um caminho absoluto para a pasta de backups.");
        const target = requestedDirectory
          ? resolve(requestedDirectory)
          : defaultBackupDirectory;
        if (target !== settings.backupDirectory) {
          const probe = join(target, `.avana-write-check-${randomUUID()}.tmp`);
          try {
            mkdirSync(target, { recursive: true });
            writeFileSync(probe, "", { flag: "wx", mode: 0o600 });
            unlinkSync(probe);
          } catch {
            fail(
              "Não foi possível gravar nessa pasta de backups. Verifique o caminho e as permissões.",
              400,
              "BACKUP_DIRECTORY_INVALID",
            );
          }
        }
        settings.backupDirectory = target;
      }
      run(
        "UPDATE settings SET name=?,timezone=?,theme=?,backupDirectory=? WHERE workspaceId=?",
        settings.name,
        settings.timezone,
        settings.theme,
        settings.backupDirectory,
        scope(),
      );
      run(
        "UPDATE users SET name=? WHERE id IN (SELECT userId FROM memberships WHERE workspaceId=?)",
        settings.name,
        scope(),
      );
      lastMaintenanceDay = null;
      return preferences();
    });
  }
  function createTask(input) {
    object(input);
    cleanKeys(input, ["title", "projectId", "section"]);
    maintenance();
    return transaction(() => {
      const projectId =
        input.projectId ||
        get(
          "SELECT id FROM projects WHERE workspaceId = ? AND archivedAt IS NULL AND deletedAt IS NULL ORDER BY createdAt,rowid LIMIT 1",
          scope(),
        )?.id;
      if (!projectId)
        fail("Crie ou restaure um projeto antes de adicionar tarefas.");
      ensureActive(projectRow(projectId));
      const section = input.section || "backlog";
      if (!sections.includes(section)) fail("Seção inválida.");
      const instant = now();
      const row = {
        id: randomUUID(),
        workspaceId: scope(),
        projectId,
        title: string(input.title, "Título", 1000, true).trim(),
        description: "",
        section,
        completionId: null,
        position: position(projectId, section),
        executionOrder: null,
        assignee: author(),
        priority: "",
        plannedDate: section === "today" ? today() : null,
        dueDate: null,
        dueTime: null,
        dueTimezone: preferences().timezone,
        createdAt: instant,
        updatedAt: instant,
        deletedAt: null,
        version: 1,
      };
      insert("tasks", row);
      if (section === "hold")
        insert("holds", {
          id: randomUUID(),
          taskId: row.id,
          reason: "",
          waitingFor: "",
          nextAction: "",
          startedAt: instant,
          endedAt: null,
        });
      record(
        row.id,
        "created",
        "Tarefa criada",
        null,
        { title: row.title, section },
        instant,
      );
      return detail(row.id);
    });
  }
  function changeFollowUp(taskId, value, instant, note = "Reagendado") {
    const nextDate = date(value, "Follow-up");
    const current = get(
      "SELECT * FROM followUps WHERE taskId=? AND status='pending'",
      taskId,
    );
    if (current?.date === nextDate) return;
    if (current)
      run(
        "UPDATE followUps SET status='cancelled',closedAt=?,note=? WHERE id=?",
        instant,
        note,
        current.id,
      );
    if (nextDate)
      insert("followUps", {
        id: randomUUID(),
        taskId,
        date: nextDate,
        status: "pending",
        note: "",
        createdAt: instant,
        closedAt: null,
      });
  }
  function command(id, input) {
    object(input);
    string(input.commandId, "Identificador da ação", 200, true);
    string(input.action, "Ação", 60, true);
    integer(input.version, "Versão", 1);
    maintenance();
    const requestHash = createHash("sha256")
      .update(
        canonical({
          id,
          ...Object.fromEntries(
            Object.entries(input).filter(([key]) => key !== "commandId"),
          ),
        }),
      )
      .digest("hex");
    return transaction(() => {
      const previous = get(
        "SELECT * FROM commands WHERE commandId = ?",
        input.commandId,
      );
      if (previous) {
        if (previous.taskId !== id || previous.requestHash !== requestHash)
          fail(
            "Esta ação já foi usada com outros dados.",
            409,
            "IDEMPOTENCY_CONFLICT",
          );
        return detail(id);
      }
      const task = taskRow(id),
        project = projectRow(task.projectId);
      if (task.version !== input.version)
        fail(
          "Esta tarefa foi alterada. Atualize os dados e tente novamente; seu texto foi preservado.",
          409,
          "VERSION_CONFLICT",
        );
      ensureActive(project);
      if (task.deletedAt && !["restore", "delete"].includes(input.action))
        fail("Restaure a tarefa antes de editá-la.", 409, "TASK_DELETED");
      const before = detail(id),
        instant = now();
      let summary = "",
        changed = true;
      function move(section) {
        if (!sections.includes(section)) fail("Seção inválida.");
        if (task.section === "hold" && section !== "hold")
          run(
            "UPDATE holds SET endedAt=? WHERE taskId=? AND endedAt IS NULL",
            instant,
            id,
          );
        if (section === "hold" && task.section !== "hold")
          insert("holds", {
            id: randomUUID(),
            taskId: id,
            reason: string(input.reason ?? "", "Motivo", 10000),
            waitingFor: string(input.waitingFor ?? "", "Aguardando", 1000),
            nextAction: string(input.nextAction ?? "", "Próxima ação", 10000),
            startedAt: instant,
            endedAt: null,
          });
        if (section === "hold" && task.section === "hold") {
          const hold = get(
            "SELECT * FROM holds WHERE taskId=? AND endedAt IS NULL",
            id,
          );
          for (const key of ["reason", "waitingFor", "nextAction"])
            if (key in input) hold[key] = string(input[key], key, 10000);
          run(
            "UPDATE holds SET reason=?,waitingFor=?,nextAction=? WHERE id=?",
            hold.reason,
            hold.waitingFor,
            hold.nextAction,
            hold.id,
          );
        }
        if (section === "hold" && "followUpDate" in input)
          changeFollowUp(id, input.followUpDate, instant);
        if (task.section !== section || task.completionId)
          task.position = position(task.projectId, section);
        task.section = section;
        task.completionId = null;
        if (section === "today") task.plannedDate = today();
      }
      switch (input.action) {
        case "edit": {
          const fields = object(input.fields, "Campos");
          cleanKeys(fields, [
            "title",
            "description",
            "assignee",
            "priority",
            "plannedDate",
            "dueDate",
            "dueTime",
            "projectId",
            "executionOrder",
          ]);
          for (const key of ["title", "description", "assignee"])
            if (key in fields)
              task[key] = string(
                fields[key],
                key,
                key === "description" ? 100000 : 1000,
                key === "title",
              );
          task.title = task.title.trim();
          if ("executionOrder" in fields)
            task.executionOrder = executionOrder(fields.executionOrder);
          if ("priority" in fields) {
            if (!priorities.includes(fields.priority))
              fail("Prioridade inválida.");
            task.priority = fields.priority;
          }
          for (const key of ["plannedDate", "dueDate"])
            if (key in fields) task[key] = date(fields[key]);
          if ("dueTime" in fields) {
            if (
              fields.dueTime !== null &&
              fields.dueTime !== "" &&
              (typeof fields.dueTime !== "string" ||
                !/^([01]\d|2[0-3]):[0-5]\d$/.test(fields.dueTime))
            )
              fail("Horário inválido.");
            task.dueTime = fields.dueTime || null;
          }
          if (!task.dueDate) task.dueTime = null;
          if ("dueDate" in fields || "dueTime" in fields)
            task.dueTimezone = preferences().timezone;
          if ("projectId" in fields && fields.projectId !== task.projectId) {
            ensureActive(projectRow(fields.projectId));
            task.projectId = fields.projectId;
            if (task.section && task.section !== "hold")
              task.section = "backlog";
            task.position = position(task.projectId, task.section);
          }
          summary = "Campos atualizados";
          break;
        }
        case "move":
        case "plan":
        case "reopen": {
          if (input.action === "reopen" && !task.completionId) {
            changed = false;
            break;
          }
          move(
            input.action === "plan"
              ? "today"
              : input.section || (input.action === "reopen" ? "today" : null),
          );
          summary = before.task.completionId
            ? "Tarefa reaberta"
            : input.action === "plan"
              ? "Planejada para hoje"
              : "Seção alterada";
          break;
        }
        case "complete": {
          if (task.completionId) {
            changed = false;
            break;
          }
          if (
            before.subtasks.some((subtask) => !subtask.completedAt) &&
            input.confirmPending !== true
          )
            fail(
              "Há subtarefas pendentes. Confirme para concluir apenas a tarefa principal.",
              422,
              "PENDING_SUBTASKS",
            );
          const note = string(input.note ?? "", "Evidência", 100000).trim();
          const link = string(input.link ?? "", "Link", 4000).trim();
          if (link) {
            try {
              const parsed = new URL(link);
              if (!["http:", "https:"].includes(parsed.protocol))
                fail("Use um link HTTP ou HTTPS.");
            } catch (error) {
              if (error instanceof AppError) throw error;
              fail("Link inválido.");
            }
          }
          if (
            project.requireEvidence &&
            !note &&
            !link &&
            !before.comments.some(
              (comment) =>
                comment.kind === "evidence" &&
                !comment.completionId &&
                comment.body.trim(),
            )
          )
            fail(
              "Este projeto exige uma nota ou link de evidência para esta conclusão.",
              422,
              "EVIDENCE_REQUIRED",
            );
          const completionId = randomUUID();
          insert("completions", {
            id: completionId,
            taskId: id,
            completedAt: instant,
            author: author(),
          });
          run(
            "UPDATE comments SET completionId=? WHERE taskId=? AND kind='evidence' AND completionId IS NULL",
            completionId,
            id,
          );
          if (note || link)
            insert("comments", {
              id: randomUUID(),
              taskId: id,
              body: [note, link].filter(Boolean).join("\n"),
              kind: "evidence",
              completionId,
              createdAt: instant,
              author: author(),
            });
          run(
            "UPDATE holds SET endedAt=? WHERE taskId=? AND endedAt IS NULL",
            instant,
            id,
          );
          run(
            "UPDATE followUps SET status='cancelled',closedAt=?,note='Tarefa concluída' WHERE taskId=? AND status='pending'",
            instant,
            id,
          );
          task.section = null;
          task.completionId = completionId;
          summary = "Tarefa concluída";
          break;
        }
        case "hold": {
          if (task.section !== "hold")
            fail("O acompanhamento do bloqueio está disponível em Hold.");
          move("hold");
          summary = "Bloqueio atualizado";
          break;
        }
        case "followup": {
          if (task.completionId)
            fail("Reabra a tarefa antes de agendar um acompanhamento.");
          changeFollowUp(
            id,
            input.date,
            instant,
            input.date ? "Reagendado" : "Acompanhamento cancelado",
          );
          summary = "Follow-up atualizado";
          break;
        }
        case "followupDone": {
          const current = get(
            "SELECT * FROM followUps WHERE taskId=? AND status='pending'",
            id,
          );
          if (!current) fail("Não há follow-up pendente.");
          const note = string(input.note, "Observação", 10000);
          const nextDate = date(input.nextDate, "Próximo follow-up");
          run(
            "UPDATE followUps SET status='done',closedAt=?,note=? WHERE id=?",
            instant,
            note,
            current.id,
          );
          if (nextDate) changeFollowUp(id, nextDate, instant);
          summary = "Acompanhamento realizado";
          break;
        }
        case "comment": {
          const kind = input.kind || "comment";
          if (!["comment", "evidence"].includes(kind))
            fail("Tipo de comentário inválido.");
          insert("comments", {
            id: randomUUID(),
            taskId: id,
            body: string(input.body, "Comentário", 100000, true).trim(),
            kind,
            completionId: kind === "evidence" ? task.completionId : null,
            createdAt: instant,
            author: author(),
          });
          summary =
            kind === "evidence"
              ? "Evidência adicionada"
              : "Comentário adicionado";
          break;
        }
        case "subtaskAdd": {
          insert("subtasks", {
            id: randomUUID(),
            taskId: id,
            title: string(input.title, "Título", 1000, true).trim(),
            completedAt: null,
            assignee: "",
            dueDate: null,
            position:
              (get(
                "SELECT MAX(position) AS value FROM subtasks WHERE taskId=?",
                id,
              ).value || 0) + 1024,
          });
          summary = "Subtarefa adicionada";
          break;
        }
        case "subtaskEdit": {
          const subtask = get(
            "SELECT * FROM subtasks WHERE id=? AND taskId=?",
            input.subtaskId,
            id,
          );
          if (!subtask) fail("Subtarefa não encontrada.", 404, "NOT_FOUND");
          const fields = object(input.fields);
          cleanKeys(fields, ["title", "completed", "assignee", "dueDate"]);
          if ("title" in fields)
            subtask.title = string(fields.title, "Título", 1000, true).trim();
          if ("assignee" in fields)
            subtask.assignee = string(fields.assignee, "Responsável", 1000);
          if ("dueDate" in fields) subtask.dueDate = date(fields.dueDate);
          if ("completed" in fields)
            subtask.completedAt = boolean(fields.completed, "Concluída")
              ? subtask.completedAt || instant
              : null;
          run(
            "UPDATE subtasks SET title=?,completedAt=?,assignee=?,dueDate=? WHERE id=?",
            subtask.title,
            subtask.completedAt,
            subtask.assignee,
            subtask.dueDate,
            subtask.id,
          );
          summary = "Subtarefa atualizada";
          break;
        }
        case "subtaskDelete": {
          if (
            !get(
              "SELECT id FROM subtasks WHERE id=? AND taskId=?",
              input.subtaskId,
              id,
            )
          )
            fail("Subtarefa não encontrada.", 404, "NOT_FOUND");
          run(
            "DELETE FROM subtasks WHERE id=? AND taskId=?",
            input.subtaskId,
            id,
          );
          summary = "Subtarefa excluída";
          break;
        }
        case "subtaskReorder": {
          const ordered = all(
            "SELECT id FROM subtasks WHERE taskId=? ORDER BY position,id",
            id,
          ).map((row) => row.id);
          if (
            !ordered.includes(input.subtaskId) ||
            (input.beforeId !== null && !ordered.includes(input.beforeId))
          )
            fail("Destino de ordenação inválido.");
          if (input.beforeId === input.subtaskId) {
            changed = false;
            break;
          }
          ordered.splice(ordered.indexOf(input.subtaskId), 1);
          ordered.splice(
            input.beforeId === null
              ? ordered.length
              : ordered.indexOf(input.beforeId),
            0,
            input.subtaskId,
          );
          ordered.forEach((subtaskId, index) =>
            run(
              "UPDATE subtasks SET position=? WHERE id=?",
              (index + 1) * 1024,
              subtaskId,
            ),
          );
          summary = "Subtarefas reordenadas";
          break;
        }
        case "reorder": {
          if (!task.section)
            fail("A ordenação manual está disponível nas seções ativas.");
          if (input.beforeId === id) {
            changed = false;
            break;
          }
          const ordered = all(
            "SELECT id,position FROM tasks WHERE projectId=? AND section=? AND deletedAt IS NULL AND id!=? ORDER BY position,id",
            task.projectId,
            task.section,
            id,
          );
          const targetIndex =
            input.beforeId === null
              ? ordered.length
              : ordered.findIndex((row) => row.id === input.beforeId);
          if (targetIndex < 0)
            fail("A tarefa de destino deve estar no mesmo projeto e seção.");
          const previousPosition = ordered[targetIndex - 1]?.position ?? 0;
          const nextPosition =
            ordered[targetIndex]?.position ?? previousPosition + 2048;
          task.position = (previousPosition + nextPosition) / 2;
          if (
            !Number.isFinite(task.position) ||
            task.position === previousPosition ||
            task.position === nextPosition
          ) {
            ordered.forEach((row, index) =>
              run(
                "UPDATE tasks SET position=?,version=version+1 WHERE id=?",
                (index + 1) * 1024,
                row.id,
              ),
            );
            const previousRank = targetIndex * 1024,
              nextRank = (targetIndex + 1) * 1024;
            task.position = (previousRank + nextRank) / 2;
          }
          summary = "Ordem alterada";
          break;
        }
        case "delete":
          task.deletedAt = task.deletedAt || instant;
          summary = "Tarefa movida para a lixeira";
          break;
        case "restore":
          task.deletedAt = null;
          summary = "Tarefa restaurada da lixeira";
          break;
        default:
          fail("Ação desconhecida.");
      }
      if (changed) {
        task.version += 1;
        task.updatedAt = instant;
        run(
          "UPDATE tasks SET projectId=?,title=?,description=?,section=?,completionId=?,position=?,executionOrder=?,assignee=?,priority=?,plannedDate=?,dueDate=?,dueTime=?,dueTimezone=?,updatedAt=?,deletedAt=?,version=? WHERE id=?",
          task.projectId,
          task.title,
          task.description,
          task.section,
          task.completionId,
          task.position,
          task.executionOrder,
          task.assignee,
          task.priority,
          task.plannedDate,
          task.dueDate,
          task.dueTime,
          task.dueTimezone,
          task.updatedAt,
          task.deletedAt,
          task.version,
          id,
        );
        const after = detail(id);
        // Keep audit entries useful without recursively embedding prior activity.
        const previousValues = {},
          nextValues = {};
        for (const key of Object.keys(before.task))
          if (canonical(before.task[key]) !== canonical(after.task[key])) {
            previousValues[key] = before.task[key];
            nextValues[key] = after.task[key];
          }
        for (const key of ["subtasks", "holds", "followUps", "comments"]) {
          const previousById = new Map(before[key].map((row) => [row.id, row]));
          const nextById = new Map(after[key].map((row) => [row.id, row]));
          const removedOrChanged = before[key].filter(
            (row) => canonical(row) !== canonical(nextById.get(row.id)),
          );
          const addedOrChanged = after[key].filter(
            (row) => canonical(row) !== canonical(previousById.get(row.id)),
          );
          if (removedOrChanged.length || addedOrChanged.length) {
            previousValues[key] = removedOrChanged;
            nextValues[key] = addedOrChanged;
          }
        }
        record(id, input.action, summary, previousValues, nextValues, instant);
      }
      const response = detail(id);
      insert("commands", {
        commandId: input.commandId,
        taskId: id,
        requestHash,
        response: JSON.stringify({ taskId: id }),
        createdAt: instant,
      });
      return response;
    });
  }

  function validateImport(payload) {
    object(payload, "Exportação");
    if (payload.format !== "avana" || payload.version !== 1)
      fail("Formato ou versão de exportação incompatível.");
    timestamp(payload.exportedAt);
    const data = structuredClone(object(payload.data, "Conteúdo"));
    cleanKeys(data, TABLES);
    // Backup destinations belong to the target installation, including when importing an older export.
    if (Array.isArray(data.settings))
      for (const row of data.settings)
        row.backupDirectory = preferences().backupDirectory;
    if (Array.isArray(data.tasks))
      for (const row of data.tasks) {
        object(row);
        if (!("executionOrder" in row)) row.executionOrder = null;
        if (row.priority === "urgent") row.priority = "high";
      }
    for (const table of TABLES) {
      if (!Array.isArray(data[table]) || data[table].length > 200000)
        fail(`Tabela inválida: ${table}.`);
      const columns = all(`PRAGMA table_info("${table}")`).map(
        (column) => column.name,
      );
      for (const row of data[table]) {
        object(row);
        if (
          columns.length !== Object.keys(row).length ||
          columns.some((column) => !(column in row))
        )
          fail(`Campos incompatíveis em ${table}.`);
        cleanKeys(row, columns);
        for (const [key, value] of Object.entries(row)) {
          if (
            value !== null &&
            typeof value !== "string" &&
            typeof value !== "number"
          )
            fail(`Valor inválido: ${table}.${key}.`);
          if (typeof value === "string" && value.length > 16 * 1024 * 1024)
            fail("Registro muito grande.");
          if (key.endsWith("At")) timestamp(value, true);
        }
      }
    }
    if (
      data.workspaces.length !== 1 ||
      data.users.length !== 1 ||
      data.memberships.length !== 1 ||
      data.settings.length !== 1
    )
      fail(
        "A restauração local requer exatamente um workspace e um proprietário.",
      );
    const workspaceId = data.workspaces[0].id,
      userId = data.users[0].id;
    if (
      data.memberships[0].workspaceId !== workspaceId ||
      data.memberships[0].userId !== userId ||
      data.memberships[0].role !== "owner" ||
      data.settings[0].workspaceId !== workspaceId ||
      data.projects.some((row) => row.workspaceId !== workspaceId) ||
      data.tasks.some((row) => row.workspaceId !== workspaceId)
    )
      fail("Os registros devem pertencer ao mesmo workspace.");
    const settings = data.settings[0];
    timezone(settings.timezone);
    string(settings.name, "Nome", 200, true);
    if (!["light", "dark", "system"].includes(settings.theme))
      fail("Tema inválido na exportação.");
    for (const row of data.projects) {
      string(row.name, "Nome de projeto", 200, true);
      string(row.description, "Descrição", 100000);
      if (!/^#[a-fA-F0-9]{6}$/.test(row.color))
        fail("Cor inválida na exportação.");
    }
    for (const row of data.tasks) {
      string(row.title, "Título", 1000, true);
      string(row.description, "Descrição", 100000);
      string(row.assignee, "Responsável", 1000);
      integer(row.version, "Versão", 1);
      executionOrder(row.executionOrder);
      if (!priorities.includes(row.priority))
        fail("Prioridade inválida na exportação.");
      timezone(row.dueTimezone);
      if (!Number.isFinite(row.position) || row.position <= 0)
        fail("Ordenação inválida.");
      date(row.plannedDate);
      date(row.dueDate);
      if (
        row.dueTime !== null &&
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(row.dueTime)
      )
        fail("Horário inválido na exportação.");
      const openHolds = data.holds.filter(
        (hold) => hold.taskId === row.id && !hold.endedAt,
      );
      if (
        (row.section === "hold" && openHolds.length !== 1) ||
        (row.section !== "hold" && openHolds.length !== 0)
      )
        fail("Episódios de Hold inconsistentes.");
      if (
        row.completionId &&
        data.followUps.some(
          (follow) => follow.taskId === row.id && follow.status === "pending",
        )
      )
        fail("Tarefa concluída com follow-up pendente.");
    }
    for (const row of data.subtasks) {
      string(row.title, "Título da subtarefa", 1000, true);
      date(row.dueDate);
      if (!Number.isFinite(row.position) || row.position <= 0)
        fail("Ordenação inválida.");
    }
    for (const row of data.followUps) {
      if (!date(row.date)) fail("Follow-up sem data.");
    }
    for (const row of data.comments)
      string(row.body, "Comentário", 100000, true);
    for (const row of data.activity) {
      try {
        const compact = compactAudit(
          JSON.parse(row.before),
          JSON.parse(row.after),
        );
        row.before = JSON.stringify(compact.before);
        row.after = JSON.stringify(compact.after);
      } catch {
        fail("Histórico inválido.");
      }
    }
    for (const row of data.commands) {
      string(row.commandId, "Identificador da ação", 200, true);
      if (!/^[a-f0-9]{64}$/.test(row.requestHash))
        fail("Registro de idempotência inválido.");
      try {
        const response = JSON.parse(row.response);
        if ((response.taskId || response.task?.id) !== row.taskId)
          fail("Resposta de ação incompatível.");
        row.response = JSON.stringify({ taskId: row.taskId });
      } catch {
        fail("Histórico de ações inválido.");
      }
    }
    for (const row of data.requests) {
      string(row.requestId, "Identificador da solicitação", 200, true);
      if (!/^[a-f0-9]{64}$/.test(row.requestHash))
        fail("Registro de idempotência inválido.");
      try {
        row.response = JSON.stringify(
          responseReference(object(JSON.parse(row.response))),
        );
      } catch {
        fail("Histórico de solicitações inválido.");
      }
    }
    return data;
  }
  function restore(payload) {
    const data = validateImport(payload);
    // A failed import cannot remove current records; all replacement writes roll back.
    backup("before-restore");
    try {
      transaction(() => {
        db.exec("PRAGMA defer_foreign_keys = ON");
        for (const table of [...TABLES].reverse())
          run(`DELETE FROM "${table}"`);
        for (const table of TABLES)
          for (const row of data[table]) insert(table, row);
        if (all("PRAGMA foreign_key_check").length)
          fail("A exportação contém vínculos ausentes ou incompatíveis.");
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      fail(
        `Exportação inconsistente; nenhum dado foi substituído. ${error.message}`,
        400,
        "INVALID_RESTORE",
      );
    }
    lastMaintenanceDay = null;
    return { ok: true };
  }
  function executeRequest(key, operation, payload, fn) {
    if (!key) return fn();
    string(key, "Chave de idempotência", 200, true);
    const requestHash = createHash("sha256")
      .update(canonical({ operation, payload }))
      .digest("hex");
    return transaction(() => {
      const previous = get("SELECT * FROM requests WHERE requestId=?", key);
      if (previous) {
        if (previous.requestHash !== requestHash)
          fail(
            "Esta ação já foi usada com outros dados.",
            409,
            "IDEMPOTENCY_CONFLICT",
          );
        return resolveResponseReference(JSON.parse(previous.response));
      }
      const response = fn();
      insert("requests", {
        requestId: key,
        requestHash,
        response: JSON.stringify(responseReference(response)),
        createdAt: now(),
      });
      return response;
    });
  }
  function responseReference(response) {
    if (response?.task?.id) return { $avanaRef: "task", id: response.task.id };
    if (
      response?.id &&
      typeof response.requireEvidence === "boolean" &&
      typeof response.favorite === "boolean"
    )
      return { $avanaRef: "project", id: response.id };
    if (
      response?.timezone &&
      response?.theme &&
      typeof response.name === "string"
    )
      return { $avanaRef: "settings" };
    return response;
  }
  function resolveResponseReference(response) {
    const reference = responseReference(response);
    if (reference?.$avanaRef === "task") return detail(reference.id);
    if (reference?.$avanaRef === "project")
      return projectData(projectRow(reference.id));
    if (reference?.$avanaRef === "settings") return preferences();
    return reference;
  }
  function compactAudit(before, after) {
    if (
      !before ||
      !after ||
      typeof before !== "object" ||
      typeof after !== "object"
    )
      return { before, after };
    for (const key of ["subtasks", "holds", "followUps", "comments"]) {
      if (!Array.isArray(before[key]) || !Array.isArray(after[key])) continue;
      const previous = before[key],
        next = after[key];
      const previousById = new Map(previous.map((row) => [row.id, row]));
      const nextById = new Map(next.map((row) => [row.id, row]));
      before[key] = previous.filter(
        (row) => canonical(row) !== canonical(nextById.get(row.id)),
      );
      after[key] = next.filter(
        (row) => canonical(row) !== canonical(previousById.get(row.id)),
      );
    }
    return { before, after };
  }
  // Shrink caches created by early MVP builds without losing their idempotency keys.
  if (!readOnly) transaction(() => {
    for (const row of all("SELECT id FROM tasks WHERE priority='urgent'")) {
      const instant = now();
      run(
        "UPDATE tasks SET priority='high',version=version+1,updatedAt=? WHERE id=?",
        instant,
        row.id,
      );
      insert("activity", {
        id: randomUUID(),
        taskId: row.id,
        type: "priorityNormalized",
        summary: "Prioridade Urgente convertida para Alta",
        before: JSON.stringify({ priority: "urgent" }),
        after: JSON.stringify({ priority: "high" }),
        createdAt: instant,
        author: "Sistema",
      });
    }
    for (const row of all("SELECT commandId,taskId,response FROM commands")) {
      const compact = JSON.stringify({ taskId: row.taskId });
      if (compact !== row.response)
        run(
          "UPDATE commands SET response=? WHERE commandId=?",
          compact,
          row.commandId,
        );
    }
    for (const row of all("SELECT requestId,response FROM requests")) {
      const compact = JSON.stringify(
        responseReference(JSON.parse(row.response)),
      );
      if (compact !== row.response)
        run(
          "UPDATE requests SET response=? WHERE requestId=?",
          compact,
          row.requestId,
        );
    }
    for (const row of all("SELECT id,before,after FROM activity")) {
      const compact = compactAudit(
        JSON.parse(row.before),
        JSON.parse(row.after),
      );
      const before = JSON.stringify(compact.before),
        after = JSON.stringify(compact.after);
      if (before !== row.before || after !== row.after)
        run(
          "UPDATE activity SET before=?,after=? WHERE id=?",
          before,
          after,
          row.id,
        );
    }
  });
  maintenance();
  return {
    bootstrap,
    getTask: detail,
    createProject,
    updateProject,
    createTask,
    command,
    updateSettings,
    exportData,
    restore,
    backup,
    executeRequest,
    maintenance,
    setFrozenGuard: (guard) => { frozenGuard = guard; },
    close: () => db.close(),
    filePath: file,
  };
}
