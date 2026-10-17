import type { Task, TaskCommand, TaskDetail } from "./types.ts";

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 0, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}
export interface RetryStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  withLock?<T>(key: string, action: () => Promise<T>): Promise<T>;
}
const processLocks = new Map<string, Promise<unknown>>();
export function withProcessLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = processLocks.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(action);
  processLocks.set(key, current);
  void current.finally(() => { if (processLocks.get(key) === current) processLocks.delete(key); }).catch(() => undefined);
  return current;
}
export interface ServiceRequest {
  method: string;
  path: string;
  body: Record<string, unknown>;
  requestId?: string;
}
export type Transport = <T>(request: ServiceRequest) => Promise<T>;
type PendingOperation = { id: string; version?: number };
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
      : item,
  );
}

// Persiste somente operações de resultado incerto. Não é uma fila offline:
// nenhuma operação é enviada sem uma tentativa explícita do usuário.
export function createAvanaService(options: {
  transport: Transport;
  scope: string;
  storage?: RetryStorage;
  uuid: () => string;
  fingerprint: (value: string) => string | Promise<string>;
}) {
  const storageKey = `avana:pending-requests:${options.scope}`;
  let disposed = false;
  let pending: Record<string, PendingOperation> = {};
  let serial: Promise<unknown> = Promise.resolve();
  const inFlight = new Map<string, Promise<unknown>>();
  const ensureActive = () => {
    if (disposed) throw new ApiError("A sessão mudou. Abra a tarefa novamente.", 401, "SESSION_CHANGED");
  };
  function updateLedger<T>(fn: () => T): Promise<T> {
    const locked = options.storage?.withLock || withProcessLock;
    const operation = serial.catch(() => undefined).then(() => locked(storageKey, async () => {
      if (options.storage) {
        const raw = await options.storage?.getItem(storageKey);
        if (raw) {
          const parsed: unknown = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
            Object.values(parsed).some(value => !value || typeof value !== "object" || typeof value.id !== "string" ||
              (value.version !== undefined && !Number.isInteger(value.version))))
            throw new Error("Registro de tentativas inválido.");
          pending = parsed as Record<string, PendingOperation>;
        } else pending = {};
      }
      const value = fn();
      await options.storage?.setItem(storageKey, JSON.stringify(pending));
      return value;
    }));
    serial = operation;
    return operation.catch(() => {
      throw new ApiError("Não foi possível guardar a tentativa neste dispositivo. Preserve seu texto e tente novamente.", 0, "RETRY_STORAGE_ERROR");
    });
  }
  async function perform<T>(request: ServiceRequest, signature: string): Promise<T> {
    ensureActive();
    const mutation = request.method !== "GET";
    const operation = mutation
      ? await updateLedger(() => pending[signature] ||= {
        id: options.uuid(),
        ...(request.path.endsWith("/command") && typeof request.body.version === "number" ? { version: request.body.version } : {}),
      })
      : undefined;
    ensureActive();
    const body = request.path.endsWith("/command")
      ? { ...request.body, version: operation?.version ?? request.body.version, commandId: operation?.id }
      : request.body;
    let result: T;
    try {
      result = await options.transport<T>({ ...request, body, requestId: operation?.id });
    } catch (error) {
      // Auth expiry/rate limiting must retain the key of a previous uncertain commit.
      if (mutation && error instanceof ApiError && error.status >= 400 && error.status < 500 &&
        ![401, 403, 408, 429].includes(error.status)) {
        await updateLedger(() => { delete pending[signature]; });
      }
      throw error;
    }
    if (mutation) {
      // A known successful commit stays successful even if local cleanup fails.
      await updateLedger(() => { delete pending[signature]; }).catch(() => undefined);
    }
    ensureActive();
    return result;
  }
  async function request<T>(path: string, method = "GET", body: Record<string, unknown> = {}): Promise<T> {
    ensureActive();
    const normalized: ServiceRequest = { path: path.startsWith("/api/") ? path : `/api${path}`, method: method.toUpperCase(), body };
    // A lost response followed by a refresh must replay the original version.
    // Rebasing an uncertain comment/subtask onto a new version could duplicate it.
    const signatureBody = normalized.path.endsWith("/command")
      ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "version" && key !== "commandId"))
      : body;
    const signature = await options.fingerprint(canonical({ ...normalized, body: signatureBody }));
    const existing = inFlight.get(signature);
    if (existing) return existing as Promise<T>;
    const promise = perform<T>(normalized, signature).finally(() => inFlight.delete(signature));
    inFlight.set(signature, promise);
    return promise;
  }
  return {
    request,
    command: (task: Task, action: TaskCommand) => request<TaskDetail>(`/tasks/${task.id}/command`, "POST", { ...action, version: task.version }),
    getDetail: (id: string) => request<TaskDetail>(`/tasks/${id}`),
    dispose: () => { disposed = true; },
  };
}
