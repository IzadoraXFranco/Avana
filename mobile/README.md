# Avana para Android

Aplicativo nativo React Native + TypeScript, com Expo SDK 57. A interface usa os mesmos contratos, regras de datas, ordenação, comandos, controle de versão e notificações de atualização do código `../shared` usado pela Web. Não é uma WebView.

**Estado desta instalação em 16/10/2026:** o usuário confirmou o login no Expo Go, a leitura da mesma tarefa da Web e a sincronização nos dois sentidos: criação no Android refletida na Web e prioridade alterada na Web refletida no Android, sem atualização manual. O projeto EAS `@izadorafranco/avana-mobile` está vinculado (`48e5984f-b716-4fd7-91d2-9b86e3b88469`), com assinatura Android gerenciada pelo Expo. O [primeiro build APK](https://expo.dev/accounts/izadorafranco/projects/avana-mobile/builds/f753888b-ef60-4042-a470-e739fe35f3e0) foi concluído: versão `0.1.0`, build `1`, pacote `app.avana.mobile`, 70.265.286 bytes. A cópia local teve o conteúdo nativo, a configuração pública do Supabase e a presença do bloco de assinatura conferidos. O usuário confirmou a instalação do APK, o login pelo Wi-Fi e uma alteração de prioridade pelo 5G refletida na Web.

## Instalar o APK pronto

1. No navegador do Android, [baixe o APK Avana 0.1.0](https://expo.dev/artifacts/eas/jfRqPUgbv_2bGeqsGpetbdKkRZbFhvzbyiOXLvOxaB8.apk).
2. Abra o arquivo baixado e escolha **Instalar**. Se o Android solicitar, permita a instalação pelo navegador usado no download.
3. Abra **Avana** e entre com a mesma conta usada na Web. Confirme a tarefa existente e repita uma alteração simples nos dois sentidos.

O APK funciona sem Expo Go e sem o computador ligado; esta versão precisa de internet para consultar e salvar no Supabase. A cópia local está em [build/Avana-0.1.0.apk](build/Avana-0.1.0.apk); guarde esse arquivo se quiser preservar o instalador além da disponibilidade do link no EAS. O SHA-256 é `fe0756d99995df449570653e1d136968575c2c96e471db93f68c8099948ab477`. As instruções oficiais de instalação estão em [APK em aparelhos Android](https://docs.expo.dev/build-reference/apk/#physical-device).

No primeiro login do APK por 5G ocorreu `fetch failed: java.net.SocketException: Connection reset`. A API de autenticação respondeu normalmente na verificação, e o APK contém a permissão de internet. O login pelo Wi-Fi funcionou; depois, a alteração de uma tarefa pelo 5G também chegou à Web. O erro não se repetiu nesse teste, sem trocar APK, credenciais ou configuração. A causa exata da interrupção inicial não foi isolada. Se ocorrer novamente, mantenha os campos preenchidos e tente de novo ou compare com outra rede; não é necessário recriar a conta nem apagar os dados.

## Preparar a conta e executar

1. Configure o projeto Supabase e aplique as migrations descritas em [SUPABASE.md](../SUPABASE.md). Se você já utiliza a versão local, conclua primeiro a migração pelo assistente da Web, com a conta de destino correta.
2. Em `mobile`, instale as dependências com `npm ci`.
3. Copie `.env.example` para `.env` e preencha `EXPO_PUBLIC_SUPABASE_URL` e `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` com **o mesmo projeto Supabase da Web**. Use somente a chave pública `sb_publishable_…` ou a chave pública legada `anon`. Nunca inclua chave secreta ou `service_role`.
4. Execute `npm start` e abra o QR code no Expo Go para Android compatível com SDK 57. Computador e celular precisam conseguir se comunicar na rede. Para emulador Android já instalado, use `npm run android`.
5. Entre com a mesma conta da Web. Um novo cadastro pode exigir confirmação por e-mail, conforme a configuração do Supabase. Sem configuração válida, o aplicativo mostra instruções e não cria uma base alternativa.

As variáveis `EXPO_PUBLIC_` entram no aplicativo compilado e **não são segredos**. A proteção dos dados depende da autenticação, das políticas RLS e da validação do usuário esperado em cada chamada RPC. A configuração do servidor não pode usar a chave pública para contornar essas proteções.

Se o Expo Go mostrar **“Cannot connect to Expo CLI”**, confira se o servidor `npm start` continua aberto e se celular e computador estão na mesma rede Wi-Fi. Recarregue o Avana pelo menu do Expo Go ou abra novamente o endereço de desenvolvimento mostrado pelo servidor. Esse aviso é do canal de desenvolvimento/Fast Refresh; no SDK utilizado, uma conexão perdida pode exigir recarregar para reconectar. Não é necessário limpar os dados do aplicativo. O APK do perfil `preview` inclui o código do aplicativo e funciona sem esse servidor, com internet para acessar o Supabase. Veja [como iniciar e conectar o ambiente Expo](https://docs.expo.dev/get-started/start-developing/).

## Funcionalidades desta versão

- Temas lilás claro, escuro e do sistema; preferência da conta, nome e fuso configuráveis.
- Projetos: criação, edição, favoritos, arquivamento, restauração e lixeira por 30 dias.
- Lista compacta com as cinco seções, recolhimento, busca por título, prioridade, prazo e ordenação manual ou por número de execução.
- Detalhes em tela inteira: título, descrição em texto/links, responsável, prioridade, ordem de execução, projeto, data planejada e prazo com horário opcional.
- Backlog por padrão; seleção para hoje preserva o prazo. Tarefas inacabadas permanecem em In Progress (Do Today).
- Hold com motivo, pessoa/objeto aguardado, próxima ação e follow-up. Registro de acompanhamento e reagendamento.
- Subtarefas com título, responsável, prazo, conclusão independente e ordenação; comentários e evidências por texto ou link; histórico separado.
- Conclusão com nota/link opcionais, política de evidência do projeto, confirmação de subtarefas pendentes, reabertura e histórico das conclusões.
- Done Today e Done calculados da conclusão real no fuso configurado. Relógio local ajustado pela referência do servidor após sincronizar; não há tarefa de meia-noite.
- Sincronização por Realtime, atualização ao retornar ao aplicativo, gesto de atualizar e consulta periódica de recuperação.
- Backup estruturado na conta. Exportação de arquivo e restauração integral permanecem disponíveis na Web; a tela Android informa isso.

A data de entrada é `AAAA-MM-DD` e o horário é `HH:MM`. Datas sem horário permanecem datas civis, sem conversão para UTC. A ordem de execução é opcional, inteira de 1 a 99999; as setas do detalhe alteram a ordem **manual**, independente desse número. Alta, Média e Baixa têm texto e indicadores vermelho, amarelo e azul.

Upload, calendário, quadro, notificações de lembretes, colaboração entre participantes e edição rica da descrição não foram adicionados ao Android nesta entrega. Não há controles simulando essas funções. Não há integração com Slack ou envio de notificações para aplicativos externos.

## Rascunhos, conexão e conflitos

O banco Supabase é a fonte de verdade. Esta versão exige conexão para consultar e confirmar alterações. Não há fila offline que publique conteúdo automaticamente.

Rascunhos de criação e de detalhes ficam no AsyncStorage do dispositivo, separados pela URL do projeto, usuário e tarefa. Eles incluem os campos editados, comentários ainda não enviados e evidências. Ao fechar um detalhe, a gravação do rascunho é aguardada; se ela falhar, o aplicativo mantém a tela aberta e informa a falha. Sair da conta não transfere rascunhos a outra conta. Desinstalar/limpar os dados do aplicativo remove esses rascunhos locais; registros já salvos permanecem na conta.

O serviço compartilhado guarda identificadores de tentativas para que a repetição explícita de uma requisição de resultado incerto não duplique comentários/conclusões. Cada alteração contém a versão conhecida da tarefa. Uma mudança concorrente é recusada pelo servidor; os campos digitados são preservados para revisão. Rascunhos de subtarefas removidas em outro dispositivo permanecem acessíveis para copiar para um comentário. Uma nova sessão desmonta a interface anterior, cancela a assinatura e descarta o serviço anterior. Cada RPC valida o usuário esperado contra o usuário autenticado antes de mutar dados.

Os tokens da sessão ficam no SecureStore, protegido pelo Android, divididos em fragmentos para respeitar limites de tamanho. Um manifesto gravado por último aponta para a versão completa; uma falha não substitui a sessão anterior por uma gravação parcial. AsyncStorage contém rascunhos e identificadores de repetição, não os tokens da sessão. O refresh da autenticação acompanha o estado ativo do aplicativo.

## Verificar e empacotar

Execute a partir de `mobile`:

```powershell
npm run typecheck
npm test
npx expo-doctor
npm run export:android -- --clear
```

Os testes de rascunhos usam o executor nativo de TypeScript do Node.js 24 e cobrem mescla concorrente, preservação de texto, subtarefas removidas e conflitos depois de fechar/reabrir. `export:android` gera o bundle JavaScript/Hermes e metadados em `mobile/dist`. **Isso não gera um APK e não substitui testes em um aparelho.** Metro resolve as dependências React/React Native instaladas em `mobile/node_modules`; o código compartilhado não importa o React da Web.

Para gerar um APK instalável usando EAS, depois de revisar/configurar a conta Expo e as credenciais Android:

```powershell
npx eas-cli login
npx eas-cli build:configure
npx eas-cli build --platform android --profile preview --clear-cache
```

Se a autorização pelo navegador não retornar ao terminal, cancele a tentativa anterior e execute `npx eas-cli login --no-browser` em um terminal interativo. O próprio CLI pedirá e-mail/usuário, senha e, se configurado na conta Expo, o código de verificação em duas etapas. Preencha esses dados somente no terminal; não os coloque em comandos, arquivos do projeto ou mensagens. Confirme o resultado com `npx eas-cli whoami` antes de iniciar o build.

O perfil `preview` em `eas.json` pede APK para distribuição interna; `production` pede Android App Bundle. Ambos herdam de `base` a URL e a chave **pública** do projeto Avana `mjhvpynwebarjdgpfrma`, para que o build remoto use o mesmo banco da Web mesmo sem receber o `.env` local. Ao trocar de projeto, atualize essas duas variáveis no perfil base e no `.env` local, além da configuração da Web. Nunca coloque credenciais secretas em `eas.json`. Nesta instalação, o projeto e a assinatura foram criados na conta Expo e o primeiro build foi concluído. Nenhuma publicação em loja foi solicitada.

Execute o EAS a partir de `mobile`, mantendo este diretório e `shared` no mesmo repositório Git. A documentação oficial orienta manter `eas.json` no diretório do aplicativo; o arquivo de upload é montado a partir da raiz Git e respeita `.gitignore` (ou `.easignore`, se existir). Neste repositório, `.gitignore` exclui `data/`, `.env*`, `node_modules/` e `dist/`; `shared/` precisa permanecer incluído. Não envie apenas a pasta `mobile` isolada. Antes do primeiro build remoto, inspecione o arquivo local com `npx eas-cli build:inspect --platform android --stage archive --profile preview --output ./build/archive-review`, confira a presença de `shared/` e a ausência da base SQLite, anexos locais, backups e credenciais. Caso adicione `.easignore`, copie também as exclusões de `.gitignore`, pois ele substitui essas regras. Consulte [EAS em monorepos](https://docs.expo.dev/build-reference/build-with-monorepos/), [conteúdo do arquivo de upload](https://github.com/expo/fyi/blob/main/eas-build-archive.md) e [regras de exclusão](https://docs.expo.dev/build-reference/easignore/).

Ao alterar as variáveis públicas, limpe o cache do Metro na exportação (`--clear`) e o cache do EAS no build (`--clear-cache`). A verificação local de 16/10/2026 confirmou a URL e a chave pública do projeto Avana dentro do bundle Hermes depois dessa limpeza; um bundle reaproveitado do cache ainda continha a configuração anterior.

## Validação manual em dois dispositivos

1. No Android e na Web, entre com a mesma conta e abra o mesmo projeto. Crie uma tarefa apenas com título e confira Backlog em ambos.
2. Defina prazo, planeje para hoje e confira que o prazo não mudou. Use ordem manual e ordem de execução separadamente.
3. Coloque em Hold, registre motivo e terceiro aguardado; confirme que o responsável permanece igual. Use prazo/follow-up vencidos para verificar os dois indicadores.
4. Crie subtarefas, conclua somente uma e registre comentário/evidência. Confira a atualização cruzada.
5. Conclua com subtarefa pendente mediante confirmação. Confira Done Today, o horário real e a subtarefa ainda pendente. Reabra escolhendo destino e confira o histórico.
6. Edite o mesmo campo sem salvar no Android; altere-o na Web. Confira a revisão de conflito, sem sobrescrita silenciosa. Remova na Web uma subtarefa cujo título foi editado no Android e confira a recuperação do texto.
7. Interrompa a rede, tente salvar um comentário, feche/reabra o detalhe e restabeleça a conexão. Reenvie explicitamente e confira que existe um único comentário.
8. Exclua/restaure tarefa e projeto, arquive/restaure projeto, altere o tema e reinicie o app.
9. Saia e entre em outra conta: nenhum dado, rascunho ou resultado pendente da primeira conta deve aparecer. Volte à primeira conta e confira seu rascunho.
10. Teste TalkBack, tamanhos de fonte maiores, teclado, botão Voltar do Android, tela pequena e mudança de dia no fuso do workspace.

Não utilize dados pessoais reais para esses testes de desenvolvimento. A validação automatizada do domínio e da segurança da nuvem fica nos testes da raiz do repositório.

Na revisão de 16/10/2026, foi aplicado um override restrito de `xcode@3.0.1 → uuid@11.1.1`, removendo o alerta de `uuid` sem mudar Expo ou React Native. O uso de `uuid.v4()` pelo `xcode` foi conferido e a geração de identificadores foi testada. Restam 15 entradas de severidade alta no `npm audit`, propagadas por duas dependências de ferramentas: [braces 3.0.3, GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), usado por Metro/micromatch, e [node-forge 1.4.0, GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv), usado pelo CLI Expo/assinatura. Ambos estavam sem versão corrigida publicada nessa verificação. Não foi aplicado o downgrade incompatível sugerido por `audit fix --force`; acompanhe as atualizações compatíveis do SDK. Isso não é uma auditoria de segurança completa do aplicativo. O login e a sincronização nos dois sentidos foram confirmados em aparelho com Expo Go. No APK, foram confirmados instalação, login pelo Wi-Fi e alteração de prioridade pelo 5G refletida na Web; os demais cenários do roteiro manual ainda não foram confirmados.
