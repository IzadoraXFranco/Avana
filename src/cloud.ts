import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { scopedStorageKey } from "./api";
import { recoveryCopyCandidates } from "../shared/legacy";

export interface CloudConfig { url: string; publishableKey: string }
export interface CloudReceipt { sourceId: string; hash: string; workspaceId: string; counts?: Record<string, number>; [key: string]: unknown }
export interface CloudStatus {
  state: "local" | "configured" | "frozen" | "cloud";
  config?: CloudConfig;
  targetUserId?: string;
  receipt?: CloudReceipt;
  hosted?: boolean;
}
export interface FrozenMigration { migrationId: string; sourceId: string; hash: string; data: unknown }
export interface BrowserRecovery {
  format: "avana-browser-recovery";
  version: 1;
  exportedAt: string;
  origin: string;
  entries: Record<string, string>;
}
export interface CloudUiState { mode: "local" | "cloud"; email?: string; workspaceId?: string; connection?: string; hosted?: boolean }
let uiState: CloudUiState = { mode: "local" };
export function getCloudUiState() { return uiState; }
export function setCloudUiState(value: CloudUiState) {
  uiState = value;
  window.dispatchEvent(new Event("avana:cloud-status"));
}

export function validateCloudConfig(config: CloudConfig): CloudConfig {
  const url = new URL(config.url.trim());
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) throw new Error("Use a URL HTTPS do projeto Supabase.");
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("Informe apenas a URL do projeto, sem caminho ou credenciais.");
  const key = config.publishableKey.trim();
  if (!key) throw new Error("Informe a chave publicável do projeto.");
  if (key.startsWith("sb_secret_")) throw new Error("Essa é uma chave secreta. Use a chave publishable ou anon.");
  if (key.split(".").length === 3) {
    try {
      const payload = JSON.parse(atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      if (payload.role !== "anon") throw new Error("Use a chave anon, nunca uma chave de serviço.");
    } catch (error) {
      if (error instanceof Error && /chave/.test(error.message)) throw error;
      throw new Error("A chave anon informada é inválida.");
    }
  } else if (!key.startsWith("sb_publishable_")) throw new Error("Informe uma chave publishable ou anon válida.");
  return { url: url.origin, publishableKey: key };
}

export function createWebCloudClient(config: CloudConfig): SupabaseClient {
  const valid = validateCloudConfig(config);
  return createClient(valid.url, valid.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
}

export async function cloudControl<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/cloud/${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch { throw new Error("Não foi possível acessar o servidor local. Nenhuma fonte de dados foi trocada."); }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error || "Não foi possível consultar a configuração de sincronização.");
  return data as T;
}

export async function loadCloudStatus(): Promise<CloudStatus> {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
  if (url || publishableKey) {
    if (!url || !publishableKey) throw new Error("A configuração hospedada precisa de VITE_SUPABASE_URL e VITE_SUPABASE_PUBLISHABLE_KEY.");
    return { state: "cloud", config: validateCloudConfig({ url, publishableKey }), hosted: true };
  }
  const status = await cloudControl<CloudStatus>("status");
  if (!["local", "configured", "frozen", "cloud"].includes(status.state)) throw new Error("Estado de sincronização desconhecido. Seus dados permanecem protegidos.");
  if (status.state !== "local" && !status.config) throw new Error("A sincronização foi configurada, mas os dados de conexão estão ausentes.");
  if (status.config) status.config = validateCloudConfig(status.config);
  return status;
}

export function downloadJson(value: unknown, filename: string) {
  const href = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = href; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}

const isLegacyAvanaKey = (key: string) => (key === "avana" || key.startsWith("avana.") || key.startsWith("avana:")) && !key.startsWith("avana:scope:") && !key.startsWith("avana:pending-requests:");
export function collectBrowserRecovery(): BrowserRecovery {
  const entries: Record<string, string> = {};
  const currentScope = scopedStorageKey("");
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key) continue;
    const currentDraft = currentScope && key.startsWith(currentScope) &&
      /^avana:(task-draft|execution-order-draft|unrecognized-task-draft):/.test(key.slice(currentScope.length));
    if (!isLegacyAvanaKey(key) && !currentDraft) continue;
    const value = localStorage.getItem(key);
    if (value !== null) entries[key] = value;
  }
  return { format: "avana-browser-recovery", version: 1, exportedAt: new Date().toISOString(), origin: location.origin, entries };
}

export function copyRecoveryDrafts(recovery: BrowserRecovery, sourceId: string, taskIds?: Set<string>): { copied: number; conflicts: number; skipped: number } {
  const candidates = recoveryCopyCandidates(recovery.entries, taskIds);
  const marker = scopedStorageKey(`avana:migration-browser:${sourceId}`);
  if (localStorage.getItem(marker)) return { copied: 0, conflicts: 0, skipped: candidates.skipped };
  let copied = 0; let conflicts = 0;
  for (const { key, value } of candidates.entries) {
    const target = scopedStorageKey(key);
    if (target === key) throw new Error("Não foi possível identificar o armazenamento da conta de destino.");
    const existing = localStorage.getItem(target);
    if (existing !== null && existing !== value) { conflicts += 1; continue; }
    localStorage.setItem(target, value); copied += 1;
  }
  if (!conflicts && !candidates.skipped) localStorage.setItem(marker, JSON.stringify({ sourceId, copied, conflicts, completedAt: new Date().toISOString() }));
  return { copied, conflicts, skipped: candidates.skipped };
}
