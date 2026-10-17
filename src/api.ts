import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError, createAvanaService } from "../shared/service.ts";
import type { Transport } from "../shared/service.ts";
import { createSupabaseTransport } from "../shared/supabaseTransport.ts";
import type { Task, TaskCommand, TaskDetail } from "./types";
import { browserRetryStorage } from "./retryStorage";

export { ApiError };
type Mode = "local" | "cloud" | "paused";
let mode: Mode = "local";
let scope = "local";
const localTransport: Transport = async <T>({ path, method, body, requestId }: Parameters<Transport>[0]): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      ...(method !== "GET" ? { body: JSON.stringify(body) } : {}),
      headers: {
        ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
        ...(requestId ? { "Idempotency-Key": requestId } : {}),
      },
    });
  } catch {
    throw new ApiError("Não foi possível conectar. Seu conteúdo foi preservado; tente novamente.", 0, "NETWORK_ERROR");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (data.code === "LOCAL_FROZEN") window.dispatchEvent(new Event("avana:cloud-state-changed"));
    throw new ApiError(data.error || "Não foi possível salvar. Tente novamente.", response.status, data.code);
  }
  return data as T;
};
const makeService = (transport: Transport, dataScope: string) => createAvanaService({
  transport, scope: dataScope, storage: browserRetryStorage, uuid: () => crypto.randomUUID(),
  fingerprint: async value => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
    .map(byte => byte.toString(16).padStart(2, "0")).join(""),
});
let service = makeService(localTransport, scope);
export function configureCloudApi(client: SupabaseClient, dataScope: string, expectedUserId: string) {
  service.dispose();
  mode = "cloud";
  scope = dataScope;
  service = makeService(createSupabaseTransport(client, expectedUserId), scope);
}
export function configureLocalApi() {
  service.dispose();
  mode = "local";
  scope = "local";
  service = makeService(localTransport, scope);
}
export function suspendApi() { mode = "paused"; service.dispose(); }
export function getApiMode(): Mode { return mode; }
export function getDataScope(): string { return scope; }
export function scopedStorageKey(key: string): string { return scope === "local" ? key : `avana:scope:${encodeURIComponent(scope)}:${key}`; }
function requireService() {
  if (mode === "paused") throw new ApiError("Entre na sua conta para continuar.", 401, "AUTH_REQUIRED");
  return service;
}
export function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const body = typeof options.body === "string" && options.body ? JSON.parse(options.body) : {};
  return requireService().request<T>(path, options.method || "GET", body);
}
export function command(task: Task, action: TaskCommand): Promise<TaskDetail> { return requireService().command(task, action); }
export function getDetail(id: string): Promise<TaskDetail> { return requireService().getDetail(id); }
