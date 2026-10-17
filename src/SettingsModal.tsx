import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Download, DatabaseBackup, Moon, Sun, Monitor, RotateCcw, Trash2, ArchiveRestore, Cloud, LogOut } from "lucide-react";
import Modal from "./Modal";
import { api, command, getApiMode } from "./api";
import { copyRecoveryDrafts, downloadJson, getCloudUiState, type BrowserRecovery } from "./cloud";
import { inspectLegacyEntries, isPortableExport, type PortableExport } from "../shared/legacy";
import type { Bootstrap, Settings } from "./types";

const preferenceFields = ["name", "timezone", "theme", "backupDirectory"] as const;
const errorOf = (error: unknown) => error instanceof Error ? error.message : "Não foi possível concluir. Tente novamente.";

export default function SettingsModal({ data, onClose, onChanged, onNotice }: {
  data: Bootstrap; onClose: () => void; onChanged: () => Promise<void>; onNotice: (message: string) => void;
}) {
  const cloud = getApiMode() === "cloud";
  const [tab, setTab] = useState("general");
  const [form, setForm] = useState<Settings>({ ...data.settings });
  const formRef = useRef(form); formRef.current = form;
  const baseline = useRef({ ...data.settings });
  const [settingsConflict, setSettingsConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [restore, setRestore] = useState<{ name: string; data: unknown } | null>(null);
  const [browserRecovery, setBrowserRecovery] = useState<BrowserRecovery | null>(null);
  const [confirm, setConfirm] = useState("");
  const [lastBackup, setLastBackup] = useState("");
  const [sync, setSync] = useState(getCloudUiState);
  useEffect(() => {
    const current = formRef.current;
    const previous = baseline.current;
    const incoming = data.settings;
    const dirtyKeys = preferenceFields.filter(key => current[key] !== previous[key]);
    if (dirtyKeys.some(key => incoming[key] !== previous[key] && incoming[key] !== current[key])) setSettingsConflict(true);
    const merged: Settings = { ...incoming };
    for (const key of dirtyKeys) (merged as Record<string, unknown>)[key] = current[key];
    baseline.current = { ...incoming }; formRef.current = merged; setForm(merged);
  }, [data.settings.name, data.settings.timezone, data.settings.theme, data.settings.backupDirectory]);
  useEffect(() => {
    const change = () => setSync(getCloudUiState());
    window.addEventListener("avana:cloud-status", change);
    return () => window.removeEventListener("avana:cloud-status", change);
  }, []);

  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true); setError("");
    try {
      await fn();
      try { await onChanged(); } catch { onNotice(`${message} A visualização será atualizada quando a conexão voltar.`); return; }
      onNotice(message);
    } catch (error) { setError(errorOf(error)); }
    finally { setBusy(false); }
  };
  const read = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 31 * 1024 * 1024) throw new Error("Arquivo acima de 31 MB.");
      const value = JSON.parse(await file.text());
      if (value?.format === "avana-browser-recovery" && value.version === 1 && value.entries && typeof value.entries === "object" && !Array.isArray(value.entries) && Object.values(value.entries).every(item => typeof item === "string")) {
        setBrowserRecovery(value as BrowserRecovery); setRestore(null);
      } else if (isPortableExport(value)) {
        setRestore({ name: file.name, data: value }); setBrowserRecovery(null);
      } else throw new Error("Formato desconhecido. O arquivo não foi importado; preserve-o para revisar os vínculos e as datas antes da conversão.");
      setConfirm(""); setError("");
    } catch (error) { setError(`Não foi possível ler a exportação: ${errorOf(error)}`); }
    event.target.value = "";
  };
  const report = browserRecovery ? inspectLegacyEntries(browserRecovery.entries) : null;
  const deletedProjects = data.projects.filter(project => project.deletedAt);
  const deletedTasks = data.tasks.filter(task => task.deletedAt && !deletedProjects.some(project => project.id === task.projectId));

  function recoverDrafts() {
    if (!browserRecovery) return;
    try {
      const result = copyRecoveryDrafts(browserRecovery, `file:${browserRecovery.origin}:${browserRecovery.exportedAt}`, new Set(data.tasks.map(task => task.id)));
      const remaining = result.conflicts + result.skipped;
      onNotice(`${result.copied} registro(s) recuperados. ${remaining ? `${remaining} registro(s) conflitantes, desconhecidos ou sem tarefa correspondente continuam no arquivo.` : "Rascunhos continuam privados, sem publicação."}`);
    } catch (error) { setError(errorOf(error)); }
  }

  function importWithoutReplacing(value: PortableExport) {
    if (!cloud) return;
    void run(async () => {
      await api("/import", { method: "POST", body: JSON.stringify({ data: value }) });
      setRestore(null); setConfirm("");
    }, "Importação concluída. Os dados que já estavam neste espaço foram preservados.");
  }

  return <Modal title="Configurações" onClose={() => { if (!busy) onClose(); }} wide>
    <div className="settings-tabs">{[["general", "Preferências"], ["data", "Seus dados"], ["trash", "Lixeira"], ["sync", "Sincronização"]].map(([id, label]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>)}</div>
    <div className="modal-body settings-body">
      {tab === "general" && <form onSubmit={event => {
        event.preventDefault();
        const fields = Object.fromEntries(preferenceFields.filter(key => (!cloud || key !== "backupDirectory") && form[key] !== baseline.current[key]).map(key => [key, form[key]]));
        if (!Object.keys(fields).length) { onNotice("Suas preferências já estão salvas."); return; }
        void run(() => api("/settings", { method: "PATCH", body: JSON.stringify(fields) }), "Preferências salvas.");
      }}>
        {settingsConflict && <div className="warning-box"><p>As preferências mudaram em outro dispositivo. Seus valores digitados foram preservados. Revise antes de salvar.</p><div className="button-row"><button type="button" className="secondary-button" onClick={() => { setForm({ ...data.settings }); setSettingsConflict(false); }}>Usar versão salva</button><button type="button" className="secondary-button" onClick={() => setSettingsConflict(false)}>Manter minha edição</button></div></div>}
        <label>Seu nome<input value={form.name} required maxLength={100} disabled={busy} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
        <label>Fuso do espaço de trabalho<input value={form.timezone} list="timezones" required disabled={busy} onChange={event => setForm({ ...form, timezone: event.target.value })} /><datalist id="timezones"><option>America/Sao_Paulo</option><option>America/Manaus</option><option>America/Recife</option><option>Europe/Lisbon</option><option>UTC</option></datalist></label>
        <p className="hint">O fuso define “hoje”. Alterá-lo pode reagrupar conclusões próximas à meia-noite, preservando seus horários originais.</p>
        <label>Aparência</label><div className="theme-options">{(["light", "dark", "system"] as const).map((mode, index) => { const Icon = [Sun, Moon, Monitor][index]; return <button type="button" key={mode} disabled={busy} className={form.theme === mode ? "selected" : ""} aria-pressed={form.theme === mode} onClick={() => setForm({ ...form, theme: mode })}><Icon size={21} />{["Claro", "Escuro", "Sistema"][index]}</button>; })}</div>
        <div className="modal-actions"><button className="primary-button" disabled={busy || settingsConflict}>{busy ? "Salvando…" : "Salvar preferências"}</button></div>
      </form>}

      {tab === "data" && <>
        <div className="setting-block"><Download size={22} /><div><h3>Uma cópia que é sua</h3><p>Exporte projetos, tarefas, comentários, evidências e histórico em um arquivo completo.</p><button className="secondary-button" disabled={busy} onClick={() => void run(async () => {
          const exported = await api<unknown>("/export");
          downloadJson(exported, `avana-${new Date().toISOString().slice(0, 10)}.json`);
        }, "Exportação preparada para download.")}><Download size={15} />Exportar dados em JSON</button></div></div>
        <div className="setting-block"><DatabaseBackup size={22} /><div><h3>{cloud ? "Backup do espaço" : "Backup local"}</h3><p>{cloud ? "Crie uma cópia dos dados deste espaço no serviço. Guarde também uma exportação sob seu controle." : "Cópias diárias são feitas enquanto o aplicativo está em execução, com retenção de 30 dias. Escolha uma pasta em outro disco para proteção adicional."}</p>
          {!cloud && <label>Pasta de backups (opcional)<input value={form.backupDirectory || ""} disabled={busy} placeholder="Padrão: pasta de dados do Avana" onChange={event => setForm({ ...form, backupDirectory: event.target.value })} /></label>}
          <div className="button-row">{!cloud && <button className="secondary-button" disabled={busy} onClick={() => void run(() => api("/settings", { method: "PATCH", body: JSON.stringify({ backupDirectory: form.backupDirectory || "" }) }), "Destino dos backups salvo.")}>Salvar pasta</button>}<button className="secondary-button" disabled={busy} onClick={() => void run(async () => {
            const result = await api<{ id?: string; path?: string; backupId?: string }>("/backup", { method: "POST" });
            setLastBackup(cloud ? `Backup: ${result.id || result.backupId || "criado no serviço"}` : `Backup criado: ${result.path || "pasta configurada"}`);
          }, "Backup criado com sucesso.")}>Criar backup agora</button></div>{lastBackup && <p className="hint" role="status">{lastBackup}</p>}
        </div></div>
        <div className="setting-block"><RotateCcw size={22} /><div><h3>{cloud ? "Importar ou restaurar uma exportação" : "Restaurar uma exportação"}</h3><p>{cloud ? "Importe uma exportação preservando o conteúdo atual. A opção de restauração substitui os dados deste espaço e cria uma cópia de segurança antes da operação." : "A restauração substitui os dados atuais. Uma cópia de segurança será criada antes da operação."}</p><label className="file-picker">Escolher exportação ou pacote do navegador<input type="file" accept="application/json,.json" disabled={busy} onChange={read} /></label>
          {restore && <div className="restore-confirm"><strong>{restore.name}</strong>{cloud && isPortableExport(restore.data) && <><p>Adicione esta exportação preservando os dados que já existem neste espaço. Identificadores com conteúdo diferente precisam de revisão e não serão sobrescritos.</p><button className="primary-button" disabled={busy} onClick={() => importWithoutReplacing(restore.data as PortableExport)}>Importar sem substituir</button></>}<p>Digite RESTAURAR para substituir os dados {cloud ? "deste espaço" : "atuais"} pelo conteúdo deste arquivo.</p><input aria-label="Confirmar restauração" value={confirm} disabled={busy} onChange={event => setConfirm(event.target.value)} /><button className="danger-button" disabled={busy || confirm !== "RESTAURAR"} onClick={() => void run(async () => {
            await api("/restore", { method: "POST", body: JSON.stringify({ data: restore.data }) }); setRestore(null); setConfirm("");
          }, "Dados restaurados.")}>Restaurar dados</button></div>}
          {browserRecovery && report && <div className="cloud-legacy-report">
            <strong>Pacote do navegador</strong>
            <p>{report.draftCount} rascunho(s), {report.preferenceCount} preferência(s) e {report.exports.length} exportação(ões) completa(s) reconhecida(s).</p>
            <p>Serão recuperados somente rascunhos válidos de tarefas presentes neste espaço. Eles continuam privados, sem publicação como comentário ou conclusão.</p>
            {cloud ? <button className="secondary-button" disabled={busy} onClick={recoverDrafts}>Recuperar rascunhos nesta conta</button> : <p className="hint">Mantenha este pacote para recuperar os rascunhos depois de ativar a sincronização.</p>}
            {report.exports.map(item => <div key={item.key} className="restore-confirm">
              <strong>{item.key}</strong>
              {cloud && <><p>Adicione os registros desta exportação preservando o conteúdo atual do espaço. Depois, você poderá recuperar os rascunhos das tarefas importadas.</p><button className="primary-button" aria-label={`Importar sem substituir: ${item.key}`} disabled={busy} onClick={() => importWithoutReplacing(item.data)}>Importar sem substituir</button></>}
              <button className="secondary-button" disabled={busy} onClick={() => { setRestore({ name: item.key, data: item.data }); setConfirm(""); }}>Revisar substituição dos dados: {item.key}</button>
            </div>)}
            {report.unknown.length > 0 && <details><summary>{report.unknown.length} conteúdo(s) precisam de revisão</summary><ul>{report.unknown.map(item => <li key={item.key}><strong>{item.key}</strong><p>{item.reason}</p></li>)}</ul></details>}
            <button className="text-button" onClick={() => downloadJson(browserRecovery, "avana-recuperacao-preservada.json")}>Baixar o pacote preservado</button>
          </div>}
        </div></div>
      </>}

      {tab === "trash" && <><p className="hint">Itens excluídos podem ser recuperados por 30 dias. Projetos arquivados continuam na página de projetos.</p>{!deletedTasks.length && !deletedProjects.length ? <div className="small-empty"><Trash2 size={28} /><h3>A lixeira está vazia</h3><p>Seus itens excluídos aparecerão aqui.</p></div> : <div className="trash-list">{deletedProjects.map(project => <div key={project.id}><span><strong>{project.name}</strong><small>Projeto · excluído em {new Date(project.deletedAt!).toLocaleDateString("pt-BR")}</small></span><button className="secondary-button" disabled={busy} onClick={() => void run(() => api(`/projects/${project.id}`, { method: "PATCH", body: JSON.stringify({ deleted: false }) }), "Projeto recuperado.")}><ArchiveRestore size={15} />Restaurar</button></div>)}{deletedTasks.map(task => <div key={task.id}><span><strong>{task.title}</strong><small>Tarefa · excluída em {new Date(task.deletedAt!).toLocaleDateString("pt-BR")}</small></span><button className="secondary-button" disabled={busy} onClick={() => void run(() => command(task, { action: "restore" }), "Tarefa recuperada.")}><RotateCcw size={15} />Restaurar</button></div>)}</div>}</>}

      {tab === "sync" && <div className="setting-block"><Cloud size={23} /><div className="cloud-settings-summary"><h3>{cloud ? "Seu espaço está na nuvem" : "Sincronização entre dispositivos"}</h3>{cloud ? <><p>Conta: <strong>{sync.email || "autenticada"}</strong></p><p>{sync.connection === "connected" ? "Conexão em tempo real ativa." : "Reconectando. As alterações serão buscadas ao restabelecer a conexão."} Seus rascunhos ficam separados por conta neste navegador.</p><p>As notificações do Avana continuam internas ao aplicativo.</p><button className="secondary-button" onClick={() => { onClose(); window.dispatchEvent(new Event("avana:signout")); }}><LogOut size={15} />Sair desta conta</button></> : <><p>Conecte seu próprio projeto Supabase para acessar o mesmo espaço na Web e, quando disponível, no Android.</p><p>Você revisará a conta de destino e preservará uma cópia local antes da ativação. Até lá, o Avana continua usando este computador.</p><button className="primary-button" onClick={() => { onClose(); window.dispatchEvent(new Event("avana:configure-cloud")); }}><Cloud size={15} />Configurar sincronização</button></>}</div></div>}
      {error && <p className="error-message" role="alert">{error}</p>}
    </div>
  </Modal>;
}
