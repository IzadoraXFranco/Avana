# Ativar a sincronização do Avana

O código pode ser preparado e testado localmente sem uma conta Supabase. A sincronização real requer um projeto criado na sua conta. Não há projeto, banco em nuvem ou conta criados automaticamente por esta implementação.

**Estado desta instalação em 16/10/2026:** o projeto existente **Avana** (`mjhvpynwebarjdgpfrma`, região `us-east-1`) recebeu a migration inicial, com 14 tabelas protegidas por RLS e publicação Realtime verificada. As regras de tarefas, idempotência, conflitos e isolamento entre contas passaram em um teste transacional no PostgreSQL real; todos os registros fictícios foram revertidos. Web e Android estão configurados para esse mesmo projeto. A autenticação de redirecionamento da Web usa `http://127.0.0.1:4310`. A conta do aplicativo foi confirmada e a migração terminou: um projeto, uma tarefa e quatro eventos. Uma consulta somente leitura conferiu o recibo, o proprietário, as preferências, os IDs, o conteúdo e os vínculos com o snapshot local, sem divergências. O SQLite original permanece preservado e congelado; a fonte ativa é a nuvem. As instruções abaixo servem também para instalações futuras; não reaplique a migration inicial em um banco já configurado.

## 1. Criar o projeto

Entre em [Supabase](https://supabase.com/dashboard) e crie um projeto para o Avana. Guarde a senha do banco em um gerenciador de senhas; ela não deve ser colocada no código nem nos aplicativos. Escolha a região adequada ao seu uso e aguarde o banco ficar disponível.

No SQL Editor do projeto, execute o arquivo SQL de `supabase/migrations/`. Ele cria somente as estruturas com prefixo `avana_` e o schema auxiliar `avana_private`. Preserve esse arquivo como histórico de migração. Para mudanças posteriores, use novas migrations em vez de editar o banco manualmente.

O SQL habilita RLS, políticas de leitura do proprietário, a função transacional de escrita e a publicação Realtime da revisão do workspace. Não desative RLS para solucionar erros de acesso. Uma conta autenticada continua precisando das políticas corretas.

### Alternativa pelo CLI oficial

Se o SQL Editor não responder, o CLI 2.121.0 permite aplicar o arquivo pela Management API, sem colocar a senha do banco no código. Em um terminal interativo, execute:

```text
npx --yes supabase@2.121.0 login --agent no --output-format text
```

Conclua a autorização no navegador e cole o código de verificação somente no terminal. O CLI cuida da credencial; não a coloque em `.env`, mensagens, Git ou arquivos do aplicativo.

Confira a lista de projetos e use o identificador do projeto **Avana**. Os comandos abaixo destinam-se à primeira implantação em um projeto vazio; substitua `SEU_PROJECT_REF` pelo identificador conferido:

```text
npx --yes supabase@2.121.0 projects list
npx --yes supabase@2.121.0 db query --linked --project-ref SEU_PROJECT_REF --file supabase/migrations/202610160001_avana_cloud.sql
npx --yes supabase@2.121.0 db query --linked --project-ref SEU_PROJECT_REF --file supabase/verify-cloud.sql
```

O arquivo de verificação faz somente leituras de metadados. Espere 14 tabelas com RLS, nenhuma escrita direta para `anon` ou `authenticated`, leitura das 14 tabelas somente para `authenticated`, uma única assinatura do RPC com cinco argumentos, execução do RPC somente para `authenticated`, nenhum acesso dos clientes ao schema/funções privados e a publicação Realtime de `avana_workspaces`. `authenticated` também precisa de `USAGE` em `public`. A Data API deve estar habilitada e expor `public`.

Executar SQL por `db query`, assim como pelo SQL Editor, não registra automaticamente a versão no histórico de migrations do CLI. Preserve os arquivos aplicados e registre esse estado antes de adotar `db push` em uma instalação já existente. Não use `db reset` para ativar a nuvem ou corrigir uma migração interrompida.

## 2. Configurar a autenticação

Ative o provedor de e-mail/senha em Authentication. Use uma senha forte para a conta Avana. Se a confirmação de e-mail estiver habilitada, confirme o cadastro antes de entrar.

Configure a URL do site/retorno para o endereço utilizado na Web. Na instalação local é `http://127.0.0.1:4310`; em desenvolvimento, `http://127.0.0.1:5173`. Na hospedagem use o domínio HTTPS real e adicione somente os retornos necessários. O Android utiliza login com a mesma conta, por e-mail e senha.

Não use `service_role` nem uma chave `sb_secret_` na Web, no Expo, em arquivos públicos ou em mensagens. Os clientes recebem apenas a URL do projeto e sua chave `publishable` (`sb_publishable_…`) ou a antiga chave `anon`. A chave pública identifica o projeto; a sessão autenticada e as políticas RLS restringem os registros.

## 3. Migrar a instalação Web existente

1. Atualize a instalação com `npm install` e `npm run build`, e inicie com `npm start` ou pelo atalho Avana.
2. Abra **Configurações → Sincronização**, informe URL e chave pública e continue.
3. Crie/acesse sua conta Avana. Ela será a conta utilizada no celular.
4. Baixe o pacote de recuperação do navegador e confira eventuais dados antigos identificados. Esse arquivo não contém a senha da conta e não transforma rascunhos em conteúdo publicado.
5. Escolha **Migrar e ativar sincronização**. O programa fará backup, congelará a base local, importará o snapshot e verificará a cópia remota.
6. Aguarde a abertura dos projetos. Só então comece a editar esses dados no Android.

O banco `data/avana.sqlite` e as cópias de segurança não são apagados. Depois da ativação, todas as alterações passam pelo Supabase. Reiniciar o servidor mantém essa decisão em `data/cloud-state.json`, que guarda a configuração pública e os recibos, sem tokens de acesso.

Se houver uma interrupção, use **Retomar e verificar migração** com a mesma conta. Não exclua o estado de migração. A origem ficará bloqueada para impedir novas alterações locais enquanto o resultado remoto estiver incerto.

Se a verificação detectar diferenças, mantenha os arquivos e confira o erro antes de tentar corrigir qualquer registro. Não substitua o banco nem recrie tarefas manualmente para “consertar a sincronização”.

## 4. Hospedar a Web, se desejar

A instalação existente pode continuar abrindo pelo atalho. Para acessar a Web em outro computador sem o servidor local, publique o build Vite em uma hospedagem estática HTTPS, configurando `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY` antes do build. O exemplo está em `.env.example`.

Faça a migração pela instalação original primeiro. A versão hospedada entra diretamente na nuvem e não consegue ler o SQLite ou o localStorage do computador antigo. Configure fallback de rotas para `index.html` para permitir links diretos de tarefas. Se a hospedagem aplicar CSP, permita conexões HTTPS e WSS ao projeto Supabase utilizado. Não publique a pasta `data`, backups, arquivos `.env` privados ou o servidor SQLite na internet.

## 5. Conferir a sincronização real

Prepare o Android seguindo [mobile/README.md](mobile/README.md), que inclui Expo Go e a geração do APK pelo EAS. O banco, a URL e a conta devem ser os mesmos da Web.

Entre na mesma conta na Web e no Android e mantenha conexão nos dois dispositivos:

- Crie uma tarefa na Web e confirme que aparece no Android uma única vez.
- Altere descrição, prioridade, ordem e prazo no Android; confira os mesmos valores na Web.
- Mova para Hold com motivo, pessoa aguardada e follow-up. Confira os campos no outro dispositivo.
- Adicione uma subtarefa e um comentário de cada lado. Confira o progresso e o histórico.
- Conclua com uma evidência. Confira Done Today e a mesma data de conclusão nos dois lados.
- Reabra e conclua novamente. Devem existir dois eventos reais de conclusão, sem duplicações de uma tentativa repetida.
- Abra a mesma tarefa nos dois lados, altere em um e tente salvar um formulário antigo no outro. O texto deve ser preservado para resolver o conflito.
- Exclua e restaure uma tarefa. Confira a atualização no outro cliente.
- Entre com uma segunda conta. Ela deve receber seu próprio workspace vazio e não conseguir abrir IDs da primeira conta.
- Desconecte e reconecte. A consulta deve ser atualizada e o texto digitado não deve desaparecer. Trabalho completo offline será a próxima etapa.

Done Today passa a Done pela data/fuso na leitura, inclusive após fechar os aplicativos durante a virada do dia. Não configure automação externa para essa mudança.

## Recuperação e limites

Exporte JSON regularmente e guarde uma cópia fora do projeto Supabase. O backup interno do Avana está no mesmo banco; mantenha também a estratégia de backup do provedor. O formato exportado conserva os IDs e vínculos para restaurar projetos, tarefas, comentários, subtarefas e histórico.

Tokens e credenciais não são exportados. Identidades de usuário/workspace são remapeadas para a conta autenticada durante importação. Restauração é uma operação diferente de importação: substitui o conteúdo do workspace e exige confirmação; importação acrescenta registros e recusa colisões incompatíveis.

Fontes: [chaves de API](https://supabase.com/docs/guides/getting-started/api-keys), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Realtime](https://supabase.com/docs/guides/realtime/postgres-changes).
