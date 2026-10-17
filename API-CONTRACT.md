# Avana MVP — contrato compartilhado

Aplicação Web React/TypeScript/Vite. Modo local Node 24 + SQLite (node:sqlite DatabaseSync), porta 4310 (somente 127.0.0.1); Vite 5173. Tipos canônicos em shared/types.ts (camelCase), reexportados por src/types.ts. Valores SQLite booleanos viram booleanos JSON. Projetos iniciais: Meu trabalho vazio, favorito; usuário Você, fuso America/Sao_Paulo, tema system. Sem dados fictícios na base real.

No modo nuvem, Web e Android usam `public.avana_api(p_method,p_path,p_body,p_request_id,p_expected_user_id)` via Supabase. Os caminhos e comandos de domínio abaixo são preservados. Bootstrap acrescenta workspaceId/revision. O backend valida auth.uid(), identidade esperada da sessão, workspace e versão, dentro da transação. Uma troca de conta invalida operações da sessão anterior antes de acessar dados. Erros P0001 contêm message JSON `{error,code,status}` e são convertidos pelo transporte compartilhado. Realtime observa public.avana_workspaces.revision; somente o servidor altera as tabelas.

Importação aditiva: POST /api/import {data:exportObject,sourceId?} → recibo {sourceId,hash,workspaceId,counts,settingsApplied}. GET /api/imports/:sourceId consulta o recibo da conta. Importação preserva IDs e histórico, remapeia identidades locais e recusa colisões incompatíveis; restauração substitui o workspace autenticado e cria backup anterior. Backup cloud retorna {ok:true,id,createdAt}; backupDirectory permanece exclusivamente local.

## HTTP
GET /api/health → {ok:true, app:'avana'}
GET /api/bootstrap → Bootstrap (inclui projetos e tarefas deletados para lixeira; filtro é da UI)
GET /api/tasks/:id → TaskDetail
POST /api/projects {name,description?,color?,icon?,requireEvidence?} → Project
PATCH /api/projects/:id {name?,description?,color?,icon?,favorite?,archived?,deleted?,requireEvidence?} → Project
POST /api/tasks {title,projectId?,section?:backlog|hold|today} → TaskDetail
POST /api/tasks/:id/command {action,version,commandId,...} → TaskDetail
PATCH /api/settings {name?,timezone?,theme?,backupDirectory?} → Settings; pasta absoluta, vazio volta ao padrão local
GET /api/export → JSON versionado completo (Content-Disposition attachment)
POST /api/backup → {ok:true,path:string}
POST /api/restore {data:exportObject} → {ok:true}; validar tudo, snapshot antes de substituição, transação. UI exige confirmação.

## Comandos
- edit: fields:{title?,description?,assignee?,priority?,plannedDate?,dueDate?,dueTime?,projectId?,executionOrder?:number|null}. Mudança de projeto só entre ativos, destino backlog se aberta e não hold; validar referências. Não permite completedAt/section diretamente.
- move: section:backlog|hold|today. Pode reabrir concluída; today seta data planejada hoje; hold cria episódio; sair encerra. Não altera follow-up pendente em movimentação ativa. Campos opcionais reason,waitingFor,nextAction,followUpDate quando hold.
- plan: data planejada hoje e seção today (equivale move today).
- reorder: beforeId:string|null (mesmo projeto e seção; null final). Apenas abertas.
- complete: note?:string,link?:string,confirmPending?:boolean. Impedir subtarefas pendentes sem confirmação (422 code PENDING_SUBTASKS); evidência conforme projeto (422 EVIDENCE_REQUIRED). Não mudar subtarefas. Fecha hold e follow-up pendente cancelado com nota Tarefa concluída. Conclusão imutável nova só se aberta; se já concluída retornar existente.
- reopen: section:backlog|hold|today (padrão today).
- hold: reason,waitingFor,nextAction,followUpDate? (edita episódio atual, apenas Hold).
- followup: date:string|null (reagenda/cancela anterior, novo pendente se data).
- followupDone: note:string,nextDate:string|null.
- comment: body:string,kind?:comment|evidence.
- subtaskAdd: title:string.
- subtaskEdit: subtaskId,fields:{title?,completed?:boolean,assignee?,dueDate?}.
- subtaskDelete: subtaskId.
- subtaskReorder: subtaskId,beforeId:string|null.
- delete / restore: exclusão lógica 30 dias e restauração.

Requer versão e commandId em todos comandos task; idempotência transacional. Erros JSON {error:string,code?:string}, 409 VERSION_CONFLICT. Retornos completedAt e campos agregados de Hold/follow-up calculados dos vínculos/tabelas; sem estado duplicado. Todo horário real atribuído no servidor. Data de agrupamento não persiste. Fonte única task.section OU task.completionId, FK mesma task, nunca ambos. Dados ligados a workspace local e owner. Export preserva relações e histórico, sem credenciais. Backups diários 30 dias e antes restore; pasta independente configurável.

## Sequência de execução e prioridades

Task.executionOrder é sempre retornado como número inteiro entre 1 e 99999, ou null quando não definido. Novas tarefas começam com null. Alterar pelo comando edit com fields.executionOrder; limpar envia null, sem converter strings ou valores fracionários. É independente de position (ordem manual visual), prioridade, datas e seção. Alterar executionOrder não reordena position; movimentos, conclusão, reabertura e troca de projeto preservam executionOrder. Empates são permitidos; a visualização usa position como desempate e mantém a ordenação como escolha de consulta. Não há renumeração automática.

Prioridades disponíveis: low (Baixa), medium (Média), high (Alta), além de "" para não definida. Novas escritas com urgent são rejeitadas. Tarefas legadas urgent são convertidas para high ao abrir a base ou restaurar; eventos históricos mantêm seus valores originais. A migração de base registra a conversão uma única vez como atividade do Sistema.

Exports continuam na versão 1 e incluem executionOrder. Importações v1 anteriores sem esse campo recebem null, preservando os demais vínculos e valores. Campos executionOrder presentes são validados antes da substituição transacional. A adição da coluna é automática na abertura de bases existentes e não altera a ordem manual.
