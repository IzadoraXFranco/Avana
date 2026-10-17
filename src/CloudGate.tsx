import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { Check, Cloud, Download, LoaderCircle, LockKeyhole, LogOut, RefreshCw, ShieldCheck } from "lucide-react";
import App from "./App";
import Modal from "./Modal";
import { api, configureCloudApi, configureLocalApi, suspendApi } from "./api";
import { subscribeWorkspace } from "../shared/realtime";
import { inspectLegacyEntries } from "../shared/legacy";
import { cloudControl, collectBrowserRecovery, copyRecoveryDrafts, createWebCloudClient, downloadJson, loadCloudStatus, setCloudUiState, validateCloudConfig, type BrowserRecovery, type CloudReceipt, type CloudStatus, type FrozenMigration } from "./cloud";
import "./cloud.css";

type CloudBootstrap = { workspaceId?: string; workspace?: { id: string }; settings?: { workspaceId?: string }; tasks?: Array<{ id: string }> };
const messageOf = (error: unknown) => error instanceof Error ? error.message : "Não foi possível concluir. Tente novamente.";

export default function CloudGate() {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [ready, setReady] = useState<{ userId: string; scope: string; workspaceId: string } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [bootError, setBootError] = useState("");
  const [bootAttempt, setBootAttempt] = useState(0);
  const [configure, setConfigure] = useState(false);
  const [configUrl, setConfigUrl] = useState("");
  const [configKey, setConfigKey] = useState("");
  const [configError, setConfigError] = useState("");
  const [busy, setBusy] = useState(false);
  const [signup, setSignup] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [migrationError, setMigrationError] = useState("");
  const [migrationStep, setMigrationStep] = useState("");
  const [recovery, setRecovery] = useState<BrowserRecovery | null>(null);
  const [recoveryWarning, setRecoveryWarning] = useState("");
  const [connection, setConnection] = useState("");
  const currentUser = useRef<string | null>(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const frozenRef = useRef<FrozenMigration | null>(null);
  const recoveryRef = useRef<BrowserRecovery | null>(null);
  const statusRef = useRef<CloudStatus | null>(status); statusRef.current = status;
  const statusGeneration = useRef(0);
  const url = status?.config?.url;
  const publicKey = status?.config?.publishableKey;

  async function refreshStatus(background = false) {
    const generation = ++statusGeneration.current;
    try {
      const next = await loadCloudStatus();
      if (!mounted.current || generation !== statusGeneration.current) return;
      const previous = statusRef.current;
      if (background && previous && JSON.stringify(previous) === JSON.stringify(next)) return;
      if (previous && next.config?.url && previous.config?.url !== next.config.url) { window.location.reload(); return; }
      setLoadError("");
      if (next.state === "local") { configureLocalApi(); setCloudUiState({ mode: "local" }); }
      else { suspendApi(); setReady(null); setBootAttempt(value => value + 1); }
      setStatus(next);
    } catch (error) { if (mounted.current && !background && generation === statusGeneration.current) { suspendApi(); setReady(null); setLoadError(messageOf(error)); } }
  }

  useEffect(() => {
    mounted.current = true;
    void refreshStatus();
    const open = () => { setConfigError(""); setConfigure(true); };
    const sourceChanged = () => { void refreshStatus(); };
    const checkSource = () => { if (!busyRef.current && !statusRef.current?.hosted) void refreshStatus(true); };
    window.addEventListener("avana:configure-cloud", open);
    window.addEventListener("avana:cloud-state-changed", sourceChanged);
    window.addEventListener("focus", checkSource);
    return () => { mounted.current = false; statusGeneration.current += 1; window.removeEventListener("avana:configure-cloud", open); window.removeEventListener("avana:cloud-state-changed", sourceChanged); window.removeEventListener("focus", checkSource); };
  }, []);

  useEffect(() => {
    setReady(null); setSession(null); setAuthReady(false); setBootError(""); currentUser.current = null;
    if (!url || !publicKey) { setClient(null); return; }
    const cloudClient = createWebCloudClient({ url, publishableKey: publicKey });
    setClient(cloudClient);
    let disposed = false;
    const apply = (next: Session | null) => {
      if (disposed) return;
      const userId = next?.user.id || null;
      if (currentUser.current !== userId) { suspendApi(); setReady(null); setBootError(""); }
      currentUser.current = userId;
      setSession(next); setAuthReady(true);
    };
    const { data: listener } = cloudClient.auth.onAuthStateChange((_event, next) => apply(next));
    void cloudClient.auth.getSession().then(({ data, error }) => {
      if (error && !disposed) { setAuthError(error.message); setAuthReady(true); }
      else apply(data.session);
    });
    return () => { disposed = true; listener.subscription.unsubscribe(); void cloudClient.removeAllChannels(); };
  }, [url, publicKey]);

  const userId = session?.user.id;
  const wrongAccount = !!(status?.targetUserId && userId && status.targetUserId !== userId);

  useEffect(() => {
    if (!session || wrongAccount || !["configured", "frozen"].includes(status?.state || "")) return;
    try {
      const collected = collectBrowserRecovery();
      recoveryRef.current = collected; setRecovery(collected);
    } catch { setMigrationError("O navegador não permitiu coletar os rascunhos. Mantenha esta instalação até conseguir exportá-los."); }
  }, [userId, status?.state, wrongAccount]);

  useEffect(() => {
    if (!client || !userId || !status || status.state !== "cloud" || wrongAccount || loadError) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    setConnecting(true); setBootError(""); setReady(null);
    const connect = async () => {
      const provisionalScope = `cloud:${new URL(status.config!.url).host}:${userId}`;
      configureCloudApi(client, provisionalScope, userId);
      try {
        const bootstrap = await api<CloudBootstrap>("/bootstrap");
        if (cancelled || currentUser.current !== userId) return;
        const workspaceId = bootstrap.workspaceId || bootstrap.workspace?.id || bootstrap.settings?.workspaceId;
        if (!workspaceId) throw new Error("O servidor não informou o espaço de trabalho autenticado.");
        const scope = `${provisionalScope}:${workspaceId}`;
        configureCloudApi(client, scope, userId);
        if (status.receipt && !status.hosted) {
          try {
            const browserData = recoveryRef.current || collectBrowserRecovery();
            setRecovery(browserData); recoveryRef.current = browserData;
            const result = copyRecoveryDrafts(browserData, status.receipt.sourceId, new Set((bootstrap.tasks || []).map(task => task.id)));
            if (result.conflicts || result.skipped) setRecoveryWarning(`${result.conflicts + result.skipped} item(ns) precisam de revisão antes de copiar para esta conta. Os originais continuam no pacote de recuperação.`);
          } catch { setRecoveryWarning("Os dados confirmados estão na nuvem. Não foi possível copiar todos os rascunhos neste navegador; baixe o pacote de recuperação."); }
        }
        setCloudUiState({ mode: "cloud", email: session?.user.email, workspaceId, hosted: status.hosted, connection: "Conectando" });
        unsubscribe = subscribeWorkspace(client, workspaceId,
          () => window.dispatchEvent(new Event("avana:remote-change")),
          (state) => {
            if (cancelled) return;
            const text = String(state);
            setConnection(text);
            setCloudUiState({ mode: "cloud", email: session?.user.email, workspaceId, hosted: status.hosted, connection: text });
          });
        setReady({ userId, scope, workspaceId });
      } catch (error) {
        if (!cancelled) { suspendApi(); setBootError(messageOf(error)); }
      } finally { if (!cancelled) setConnecting(false); }
    };
    void connect();
    return () => { cancelled = true; unsubscribe?.(); };
  }, [client, userId, status?.state, status?.targetUserId, wrongAccount, bootAttempt, loadError]);

  async function signOut() {
    if (!client || busyRef.current) return;
    setAuthError("");
    const { error } = await client.auth.signOut({ scope: "local" });
    if (error) { setAuthError(error.message); return; }
    suspendApi(); setReady(null); setSession(null); setPassword("");
  }
  useEffect(() => {
    const leave = () => { void signOut(); };
    window.addEventListener("avana:signout", leave);
    return () => window.removeEventListener("avana:signout", leave);
  }, [client]);

  async function saveConfig(event: FormEvent) {
    event.preventDefault(); setBusy(true); setConfigError("");
    try {
      const config = validateCloudConfig({ url: configUrl, publishableKey: configKey });
      await cloudControl("config", "POST", config);
      // Reload to receive the server CSP authorizing the configured Supabase origin.
      window.location.reload();
    } catch (error) { setConfigError(messageOf(error)); }
    finally { setBusy(false); }
  }

  async function authenticate(event: FormEvent) {
    event.preventDefault(); if (!client) return;
    setBusy(true); setAuthError(""); setAuthNotice("");
    try {
      if (signup) {
        const { data, error } = await client.auth.signUp({ email: email.trim(), password });
        if (error) throw error;
        if (!data.session) setAuthNotice("Conta solicitada. Se o projeto exigir confirmação, abra a mensagem de confirmação antes de entrar.");
      } else {
        const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
      }
      setPassword("");
    } catch (error) { setAuthError(messageOf(error)); }
    finally { setBusy(false); }
  }

  function downloadRecovery() {
    try {
      const data = recoveryRef.current || collectBrowserRecovery();
      recoveryRef.current = data; setRecovery(data);
      downloadJson(data, `avana-rascunhos-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (error) { setMigrationError(`Não foi possível coletar os rascunhos: ${messageOf(error)}`); }
  }

  async function migrate() {
    if (!client || !session || !status || wrongAccount || busyRef.current) return;
    const migratingUserId = session.user.id;
    const ensureMigrationIdentity = () => {
      if (!mounted.current || currentUser.current !== migratingUserId) throw new Error("A conta mudou. Entre na conta original para retomar a migração protegida.");
    };
    statusGeneration.current += 1;
    busyRef.current = true; setBusy(true); setMigrationError("");
    try {
      const browserData = collectBrowserRecovery();
      recoveryRef.current = browserData; setRecovery(browserData);
      setMigrationStep("Preparando uma cópia estável dos dados locais…");
      const frozen = frozenRef.current || await cloudControl<FrozenMigration>("freeze", "POST", { userId: session.user.id });
      frozenRef.current = frozen;
      ensureMigrationIdentity();
      setStatus(previous => previous ? { ...previous, state: "frozen", targetUserId: session.user.id } : previous);
      setMigrationStep("Importando projetos, tarefas, evidências e histórico…");
      configureCloudApi(client, `cloud:${new URL(status.config!.url).host}:${migratingUserId}`, migratingUserId);
      const result = await api<CloudReceipt | { receipt: CloudReceipt }>("/import", { method: "POST", body: JSON.stringify({ data: frozen.data, sourceId: frozen.sourceId }) });
      ensureMigrationIdentity();
      const receipt = "receipt" in result ? result.receipt as CloudReceipt : result as CloudReceipt;
      if (!receipt || receipt.sourceId !== frozen.sourceId || !receipt.workspaceId || !receipt.hash) throw new Error("O recibo da importação não corresponde à cópia local. A ativação foi interrompida.");
      const { data: activeAuth, error } = await client.auth.getSession();
      ensureMigrationIdentity();
      if (error || activeAuth.session?.user.id !== session.user.id) throw new Error("Entre novamente na mesma conta para finalizar a migração. A cópia local continua protegida.");
      setMigrationStep("Verificando a cópia na nuvem antes de ativar…");
      await cloudControl("activate", "POST", { accessToken: activeAuth.session.access_token, receipt });
      await refreshStatus();
      setMigrationStep("");
    } catch (error) {
      suspendApi(); setMigrationError(messageOf(error)); setMigrationStep("");
      // Activation can have succeeded even if its HTTP response was lost.
      try {
        const current = await loadCloudStatus();
        if (current.state === "cloud" && current.targetUserId === session.user.id) { setStatus(current); setMigrationError(""); }
        else setStatus(current);
      } catch { /* Keep the frozen state visible and retryable. */ }
    } finally { busyRef.current = false; setBusy(false); }
  }

  async function cancelConfiguration() {
    if (busy || status?.state !== "configured") return;
    setBusy(true); setAuthError("");
    try { await cloudControl("cancel", "POST"); await refreshStatus(); }
    catch (error) { setAuthError(messageOf(error)); }
    finally { setBusy(false); }
  }

  if (status?.state === "local" && !loadError) return <><App key="local" />{configure && <Modal title="Configurar sincronização" onClose={() => { if (!busy) setConfigure(false); }}><form className="modal-body cloud-config" onSubmit={saveConfig}><p>Conecte seu projeto Supabase. Você entrará na sua conta e revisará a migração antes de trocar a fonte dos dados.</p><label>URL do projeto<input type="url" required value={configUrl} onChange={event => setConfigUrl(event.target.value)} placeholder="https://seu-projeto.supabase.co" /></label><label>Chave publicável<textarea required rows={3} value={configKey} onChange={event => setConfigKey(event.target.value)} placeholder="sb_publishable_… ou chave anon" spellCheck={false} /></label><p className="hint">Use a chave publishable ou anon. Chaves secret e service_role não pertencem ao aplicativo.</p>{configError && <p role="alert" className="error-message">{configError}</p>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setConfigure(false)}>Cancelar</button><button className="primary-button" disabled={busy}>{busy ? "Salvando…" : "Continuar"}</button></div></form></Modal>}</>;

  if (ready && ready.userId === userId && status?.state === "cloud" && !wrongAccount) return <><App key={ready.scope} />{recoveryWarning && <div className="cloud-recovery-banner" role="status"><span>{recoveryWarning}</span><button onClick={downloadRecovery}>Baixar recuperação</button><button onClick={() => setRecoveryWarning("")} aria-label="Dispensar aviso de recuperação">×</button></div>}</>;

  return <main className="cloud-gate"><section className="cloud-card"><div className="cloud-brand"><span className="brand-mark">a</span><span>avana</span></div>
    {loadError ? <><h1>A conexão precisa de atenção</h1><p>O Avana manteve a fonte de dados atual. Verifique o servidor e tente novamente.</p><p className="error-message" role="alert">{loadError}</p><button className="primary-button" onClick={() => void refreshStatus()}><RefreshCw size={16} />Tentar novamente</button></> : !status || !authReady ? <div className="cloud-progress" role="status"><LoaderCircle size={22} className="cloud-spin" /><p>Preparando seu espaço…</p></div> : !session ? <>
      <div className="cloud-kicker"><LockKeyhole size={15} />Seu espaço, com acesso seguro</div><h1>{signup ? "Crie sua conta" : "Entre no Avana"}</h1><p>{status.state === "frozen" ? "A migração está protegida. Entre na mesma conta para continuar." : "Use sua conta para acessar seus projetos e tarefas."}</p>
      <form className="cloud-auth-form" onSubmit={authenticate}><label>E-mail<input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} /></label><label>Senha<input type="password" autoComplete={signup ? "new-password" : "current-password"} minLength={signup ? 8 : undefined} required value={password} onChange={event => setPassword(event.target.value)} /></label>{authError && <p className="error-message" role="alert">{authError}</p>}{authNotice && <p className="cloud-info" role="status">{authNotice}</p>}<button className="primary-button" disabled={busy}>{busy ? "Aguarde…" : signup ? "Criar conta" : "Entrar"}</button></form><button className="text-button cloud-switch" disabled={busy} onClick={() => { setSignup(!signup); setAuthError(""); setAuthNotice(""); }}>{signup ? "Já tenho conta" : "Criar uma conta"}</button>{status.state === "configured" && <button className="text-button" disabled={busy} onClick={() => void cancelConfiguration()}>Cancelar configuração e continuar localmente</button>}
    </> : wrongAccount ? <><ShieldCheck size={28} className="cloud-symbol" /><h1>Esta migração pertence a outra conta</h1><p>Você entrou como {session.user.email}. Para proteger seus dados, entre na conta escolhida quando a migração começou.</p><button className="secondary-button" disabled={busy} onClick={() => void signOut()}><LogOut size={15} />Trocar de conta</button>{authError && <p className="error-message" role="alert">{authError}</p>}</> : status.state === "configured" || status.state === "frozen" ? <>
      <div className="cloud-kicker"><Cloud size={16} />Sincronização entre dispositivos</div><h1>{status.state === "frozen" ? "Continuar sua migração" : "Levar seu trabalho para a nuvem"}</h1><p>Destino: <strong>{session.user.email}</strong>.</p><ol className="cloud-migration-list"><li><Check size={15} />Projetos, tarefas, comentários e histórico preservados.</li><li><Check size={15} />A fonte muda somente após verificar a importação.</li><li><Check size={15} />O banco local permanece como arquivo de segurança.</li></ol><div className="cloud-recovery"><strong>Seus textos ainda não enviados</strong><p>Guarde as preferências, rascunhos e dados de versões antigas deste navegador. Rascunhos continuam privados e não são publicados como comentários.</p><button className="secondary-button" disabled={busy} onClick={downloadRecovery}><Download size={15} />Baixar pacote do navegador</button>{recovery && <small>{Object.keys(recovery.entries).length} registro(s) do navegador coletados.</small>}<RecoverySummary recovery={recovery} /></div>{status.state === "frozen" && <p className="cloud-info">A edição local está bloqueada para manter uma única versão dos dados. Uma tentativa interrompida pode ser retomada com segurança.</p>}{migrationError && <p className="error-message" role="alert">{migrationError}</p>}{migrationStep && <p className="cloud-progress-inline" role="status"><LoaderCircle size={15} className="cloud-spin" />{migrationStep}</p>}<button className="primary-button" disabled={busy} onClick={() => void migrate()}>{busy ? "Migrando…" : status.state === "frozen" ? "Retomar e verificar migração" : "Migrar e ativar sincronização"}</button><div className="cloud-footer-actions">{status.state === "configured" && <button className="text-button" disabled={busy} onClick={() => void cancelConfiguration()}>Continuar localmente</button>}<button className="text-button" disabled={busy} onClick={() => void signOut()}>Sair da conta</button></div>
    </> : <><Cloud size={28} className="cloud-symbol" /><h1>{connecting ? "Abrindo seu espaço" : "Não foi possível abrir seu espaço"}</h1>{connecting ? <p className="cloud-progress-inline" role="status"><LoaderCircle size={17} className="cloud-spin" />Carregando projetos e tarefas…</p> : <><p className="error-message" role="alert">{bootError || "Aguarde ou tente novamente."}</p><button className="primary-button" onClick={() => setBootAttempt(value => value + 1)}><RefreshCw size={15} />Tentar novamente</button></>}<button className="text-button" onClick={() => void signOut()}>Sair da conta</button>{authError && <p className="error-message" role="alert">{authError}</p>}</>}
  </section></main>;
}

function RecoverySummary({ recovery }: { recovery: BrowserRecovery | null }) {
  if (!recovery) return null;
  const report = inspectLegacyEntries(recovery.entries);
  if (!report.unknown.length && !report.exports.length) return null;
  return <div className="cloud-legacy-report"><p>{report.exports.length > 0 ? `${report.exports.length} exportação(ões) completa(s) de versões antigas foram preservadas. Você pode revisá-las em Configurações → Seus dados após a migração. ` : ""}Conteúdos desconhecidos não serão publicados automaticamente.</p>{report.unknown.length > 0 && <details><summary>{report.unknown.length} conteúdo(s) precisam de revisão</summary><ul>{report.unknown.map(item => <li key={item.key}><strong>{item.key}</strong><p>{item.reason}</p></li>)}</ul></details>}</div>;
}
