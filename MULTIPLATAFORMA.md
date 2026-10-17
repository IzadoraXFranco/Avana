# Avana Web + Android

## Análise da aplicação existente

A Web utiliza React, TypeScript e Vite. A API local utiliza Node.js e SQLite em `data/avana.sqlite`, acessível somente pelo computador. Os registros já possuem UUIDs, versões, histórico e comandos idempotentes. As tarefas confirmadas ficam no SQLite; o navegador guarda preferências e rascunhos. Não havia autenticação nem um backend acessível pelo Android.

Essa aplicação é preservada. A migração não recria tarefas nem reconstrói a interface. O Android é uma aplicação nativa React Native/Expo em `mobile`, com dependências próprias. A pasta `shared` reúne os tipos, as regras de datas/seções, a ordenação e os serviços usados pelos dois clientes.

## Fonte única de dados

Antes da configuração, a instalação continua local. Depois da migração, Web e Android utilizam o mesmo projeto Supabase e a mesma conta. O SQLite passa a ser um arquivo preservado da migração, sem receber novas alterações. A aplicação não alterna para SQLite quando a conexão com a nuvem falha.

Supabase fornece PostgreSQL, Auth e Realtime. As tabelas relacionais possuem identificação de workspace, chaves estrangeiras e RLS. O acesso direto dos clientes às tabelas é somente leitura; alterações passam pela função transacional `public.avana_api`. Ela valida a conta autenticada, os vínculos, a versão da tarefa e a identidade da operação. Funções auxiliares ficam em um schema privado.

O modelo começa com um proprietário por workspace. O responsável textual de uma tarefa e a pessoa aguardada continuam sendo campos diferentes. Eles não concedem acesso aos dados. Participantes e permissões colaborativas serão uma evolução explícita, não uma política aberta antecipadamente.

## Sincronização e conflitos

- Cada alteração confirmada aumenta a revisão do workspace. Os dois clientes assinam essa revisão pelo Realtime e consultam os dados autorizados novamente.
- Ao reconectar, a consulta é repetida; uma atualização periódica protege contra eventos perdidos.
- As tarefas têm uma versão. Uma edição baseada em uma versão antiga é recusada com `VERSION_CONFLICT`, preservando o texto local para revisão.
- Tentativas com resposta perdida conservam o mesmo identificador no dispositivo. Repetir a tentativa consulta o resultado da mesma operação, sem duplicar uma tarefa, comentário ou conclusão.
- Os registros de tentativas e rascunhos são separados por conta/projeto. Trocar de conta desmonta a interface anterior.
- Cada chamada envia a identidade esperada da conta. Se a sessão mudar durante uma operação, o banco recusa a chamada antes de acessar ou importar dados.
- A restauração na nuvem avança as versões das tarefas, inclusive de IDs removidos anteriormente. Um registro operacional de versões impede que formulários antigos sobrescrevam os dados restaurados; ele não faz parte do backup portátil. Datas reais de conclusão permanecem intactas.
- Nenhuma notificação é enviada a Slack ou a serviços externos de mensagens.

O Realtime não constitui uma segunda base e não executa regras de negócio. O PostgreSQL é a autoridade sobre alterações e horários reais.

## Regras preservadas

As cinco seções continuam Backlog, Hold, In Progress (Do Today), Done Today e Done. A tarefa aberta tem uma seção operacional; a concluída aponta para um evento de conclusão. A data exibida vem desse evento. Done Today e Done são calculados pela data de conclusão no fuso configurado, inicialmente America/Sao_Paulo. Não existe rotina de meia-noite movendo ou duplicando registros.

Planejar para hoje altera a seleção e a data planejada, sem mudar o prazo. Tarefas não terminadas permanecem no planejamento para revisão. Hold preserva responsável, prazo, acompanhamento e episódios anteriores. Reabrir preserva todas as conclusões anteriores. Subtarefas não concluem automaticamente a tarefa principal.

Prioridades: Alta/vermelha, Média/amarela e Baixa/azul, sempre com texto. A ordem de execução é um número opcional, independente da prioridade e da posição manual.

## Migração protegida

1. Criar o projeto Supabase e aplicar a migração SQL incluída no repositório.
2. Na Web local, configurar URL e chave pública e entrar na conta que também será usada no Android.
3. Baixar o pacote do navegador. Preferências e rascunhos reconhecidos serão copiados para o espaço dessa conta; não serão publicados como comentários ou tarefas confirmadas.
4. Ao iniciar a migração, o servidor faz um backup e congela a origem. O mesmo snapshot e identificador são utilizados nas novas tentativas.
5. A importação transacional preserva IDs, subtarefas, comentários, evidências, bloqueios, follow-ups, conclusões e atividade. Identidades locais de usuário/workspace são associadas à conta autenticada. Não há sobrescrita silenciosa de colisões de IDs.
6. O servidor local verifica a identidade da conta, o recibo autenticado e os dados exportados da nuvem antes de ativá-la.
7. Somente após essa verificação a Web passa a operar na nuvem. O arquivo local e os backups permanecem preservados.

Uma falha após o congelamento mantém a origem bloqueada. Use a opção de retomar; não apague `cloud-state.json` nem force uma volta ao modo local. Isso poderia criar duas versões divergentes dos dados. Antes do congelamento é possível cancelar a configuração e continuar localmente.

Dados de navegador com formato completo de exportação Avana podem ser importados. Arrays ou formatos antigos desconhecidos são identificados e mantidos no pacote de recuperação para conversão revisada. A aplicação não inventa datas de conclusão nem vínculos para convertê-los automaticamente.

Na configuração de recuperação, use **Importar sem substituir** para acrescentar uma exportação reconhecida. A restauração integral é uma ação separada. IDs que já foram removidos nesse workspace não são reinseridos por importação aditiva: exigem uma restauração explícita, para preservar o controle de versão.

## Backup, exclusão e restauração

A exportação estruturada é JSON versionado com relações por ID. Não inclui credenciais de login. Arquivos do navegador são separados porque contêm textos ainda não enviados.

Na nuvem, um backup cria um snapshot do workspace autenticado. Restauração exige confirmação e uma cópia anterior; ela não substitui dados de outra conta. Um backup dentro do mesmo banco não protege contra perda do projeto inteiro: mantenha exportações em outro local e configure a política de backup do provedor de acordo com o plano contratado.

Excluir é uma operação lógica recuperável; arquivar preserva o projeto para consulta. Nenhum cliente deve excluir registros diretamente nas tabelas. Anexos binários não existiam nesta versão; quando implementados, exigirão bucket privado, RLS de objetos e manifesto para exportar os arquivos junto ao JSON.

## Segunda etapa: cache e trabalho offline

Esta entrega usa conexão para consultar e confirmar alterações na nuvem. Rascunhos locais e identidade persistente das tentativas evitam perder texto e repetir operações, mas não são uma fila automática de sincronização offline.

O próximo passo é um cache por conta no dispositivo e uma outbox persistente com ID da operação, versão base e estado de envio. Após reconexão, cada comando será reenviado com o mesmo ID; conflitos serão revisados pelo usuário. Exclusões utilizarão tombstones e as consultas usarão revisão/cursor para recuperar mudanças. A conta anterior será removida da memória ao sair. Nenhuma política de “última escrita vence” apagará comentários ou texto silenciosamente.

## Verificação

Os testes locais usam bancos temporários SQLite e PostgreSQL via PGlite, sem acessar os dados reais. Eles verificam regras de seção, datas, subtarefas, importação, restauração, isolamento entre contas, idempotência, conflitos e congelamento da origem. O teste final entre Web e um dispositivo Android exige o projeto Supabase configurado e a mesma conta nos dois aplicativos.

Referências oficiais: [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [funções PostgreSQL](https://supabase.com/docs/guides/database/functions), [Realtime](https://supabase.com/docs/guides/realtime/postgres-changes), [Auth no React Native](https://supabase.com/docs/guides/auth/quickstarts/react-native).
