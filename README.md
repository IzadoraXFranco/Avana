# Avana

Aplicativo de organização pessoal com Web e Android, temas lilás claro e escuro e o fluxo **Backlog → Hold → In Progress (Do Today) → Done Today → Done**. A Web existente continua funcionando localmente até a ativação da nuvem. Não depende de uma conta Asana.

Para conectar os dois dispositivos, siga [a configuração do Supabase](SUPABASE.md) e [as instruções do Android, Expo Go e APK](mobile/README.md). As decisões de arquitetura e migração estão em [MULTIPLATAFORMA.md](MULTIPLATAFORMA.md). Nesta instalação, a migração para o projeto Supabase **Avana** foi concluída e verificada em 16/10/2026: um projeto, uma tarefa e quatro eventos foram preservados, com os mesmos IDs e vínculos. A Web usa a nuvem; o SQLite original permanece congelado como arquivo de segurança. O usuário confirmou no Expo Go o login, a mesma tarefa e a sincronização de criação e prioridade nos dois sentidos. O APK `0.1.0` também foi instalado: login pelo Wi-Fi e alteração de prioridade pelo 5G refletida na Web foram confirmados.

## Executar

Requisito: **Node.js 24.14 ou superior**, com npm. No diretório do projeto:

```text
npm install
npm run build
npm start
```

Abra **http://127.0.0.1:4310**. Para desenvolvimento, use `npm run dev` e abra **http://127.0.0.1:5173**; Ctrl+C encerra ambos os processos. `npm test` executa os testes e `npm run typecheck` verifica os tipos.

No Windows, após instalar e compilar, execute `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-shortcut.ps1` para criar o atalho **Avana** na área de trabalho. Ele inicia o servidor oculto, quando necessário, e abre seu navegador. Não instala dependências nem compila automaticamente. Os registros de inicialização ficam em `data/`.

## O que está implementado

- Projetos, favoritos, arquivamento e restauração.
- Lista com cinco seções, criação rápida, edição de prioridade/datas, subtarefas expansíveis, colunas configuráveis, ordenação manual por arraste ou menu, busca por título e filtros de prioridade/atraso.
- Colunas **Motivo da espera**, **Data de conclusão** (data e horário reais, somente leitura) e **Ordem de execução**. Digite 1, 2, 3… na ordem e pressione Enter ou saia da célula para salvar; a lista exibe 1º, 2º, 3º… Clique no cabeçalho para alternar a ordenação ou use o seletor **Ordenar tarefas**. A ordenação vale dentro de cada seção; números repetidos seguem a ordem manual e itens sem número ficam no fim. Ordenar e arrastar não renumeram esse campo.
- Prioridades com bolinhas e texto: **Alta** vermelha, **Média** amarela e **Baixa** azul. Prioridade pode ficar sem definição. A antiga opção Urgente passa a Alta, preservando os eventos históricos.
- Painel de detalhes com responsável, prazo com horário opcional, descrição com formatação básica, subtarefas, comentários, evidências por texto/link e histórico.
- Hold com motivo, pessoa ou item aguardado, próxima ação, histórico de bloqueios e follow-ups. A visão Acompanhamentos reúne vencidos, hoje, próximos e Hold sem follow-up.
- Conclusão com aviso de subtarefas pendentes, exigência opcional de evidência por projeto e reabertura com destino escolhido.
- Preferência de tema persistida, fuso configurável, rascunhos locais no painel e tratamento de alterações concorrentes.

Planejar para hoje não altera o prazo. Tarefas inacabadas permanecem em In progress para revisão. Done Today e Done são calculados pela data real de conclusão no fuso configurado; a virada do dia não altera nem duplica a tarefa.

O Android nativo fica em `mobile/` e compartilha os tipos, as regras e o transporte da nuvem. Temas, projetos, tarefas, subtarefas, Hold, follow-ups, comentários, evidências e histórico utilizam a mesma conta e o mesmo banco da Web. As dependências móveis ficam separadas das dependências da Web. O aplicativo exige conexão para confirmar alterações; o trabalho completo offline está previsto para a próxima etapa.

## Verificação de desenvolvimento

Na raiz, use `npm test`, `npm run typecheck` e `npm run build`. Os testes utilizam bancos temporários; não alteram `data/avana.sqlite`.

Os testes de navegador usam a build isolada e Chrome instalado:

```text
node node_modules/vite/bin/vite.js build --outDir data/qa-cloud-dist
node node_modules/@playwright/test/cli.js test
```

O servidor de teste usa a porta 4312 e um banco temporário. Se necessário, defina `AVANA_QA_CHROME` com o caminho do Chrome. Para Android, execute os comandos de verificação em [mobile/README.md](mobile/README.md). Compilar o bundle não gera APK nem comprova a sincronização em um aparelho: essa validação requer o projeto Supabase e um dispositivo.

## Dados, backups e recuperação

Antes da migração, as tarefas são persistidas em **`data/avana.sqlite`**, no computador. Depois da ativação, ficam no Supabase e o banco local permanece preservado como arquivo da migração. Fechar o navegador não exclui os dados nem encerra o servidor iniciado pelo atalho. Preserve a pasta `data/` ao atualizar o aplicativo.

Em **Configurações → Seus dados**, exporte um **JSON completo** ou crie um backup manual. No modo local, também é possível configurar a pasta de backups; cópias diárias são feitas enquanto o servidor está em execução, com retenção de 30 dias. Cópias manuais e anteriores a restaurações são preservadas. Na nuvem, o backup interno fica no próprio banco: guarde também exportações em outro local e configure a política de backup do provedor.

A restauração pela interface aceita arquivos JSON de até **31 MB** e exige digitar **RESTAURAR**. Ela **substitui os dados atuais**, cria um backup antes da substituição e valida os vínculos entre projetos, tarefas, comentários, subtarefas e histórico. Uma importação inválida não deve substituir os registros existentes.

Projetos e tarefas excluídos podem ser recuperados em **Configurações → Lixeira** durante **30 dias**. Arquivar é diferente de excluir: preserva o projeto para consulta, sem prazo de expiração.

Para restauração técnica de uma instalação **ainda local**, inclusive de arquivos maiores que o limite da interface, **encerre primeiro o servidor Avana** e execute no diretório do projeto:

```text
node scripts/restore.mjs "C:\Backups\avana.json" --replace
```

O comando também cria uma cópia anterior e substitui os dados. O destino padrão é `data/`; opcionalmente, acrescente `--data-dir "D:\Avana\data"` para escolher a pasta de destino. Fechar apenas o navegador não encerra o servidor.

Para uma cópia manual do banco SQLite, encerre o servidor e copie a pasta `data/` inteira, incluindo eventuais arquivos auxiliares. Rascunhos ainda não salvos no painel ficam no navegador e não fazem parte do JSON ou dos backups.

## Limites desta versão

O modo local continua individual e o servidor escuta somente no computador; não o exponha à internet. O modo nuvem utiliza autenticação, RLS e sincronização entre os dispositivos da mesma conta. Colaboração entre contas e trabalho completo offline permanecem para uma próxima etapa.

Quadro, calendário, Caixa de entrada e notificações internas, upload de anexos, colaboração, relatórios, visualizações salvas, seções personalizadas e exportação CSV **não estão implementados**. A exportação disponível é JSON; CSV, quando existir, será para análise e não substituirá o backup completo. O Avana não envia avisos para serviços externos e não possui integração com Slack.
