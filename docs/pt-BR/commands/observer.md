# Observer local

**PT-BR** · [English](../../en/commands/observer.md)

## Objetivo

O Observer consolida a observabilidade de vários projetos WendKeep em um serviço local. O volume
Docker mantém o SQLite `/data/observer.sqlite` como autoridade única para documentos, sessões,
agentes, uso e chamadas. Transcripts completos são opcionais e exigem captura explícita. O conteúdo fica disponível para navegação e busca
no próprio container, sem depender do Obsidian para consulta.

## Quando usar

Use para consultar changes, sessões, decisões, bugs, aprendizados, specs, documentos do brain,
consumo por agente/modelo e saúde de vários projetos em uma única memória local. Durante a
transição, o vault e os arquivos Markdown legados continuam preservados como cópia de origem para
recuperação; o Observer é a autoridade de consulta do seu container.

## Quando não usar

Não use o Observer para editar, concluir ou arquivar changes, curar memória, exportar a autoridade
de volta para Markdown automaticamente ou expor o serviço na rede. As edições continuam passando
pelos hooks e pelo WendKeep local.

## Pré-requisitos

Tenha Node.js 22.13 ou mais recente para executar o Observer SQL. O Keep Core e os demais comandos
continuam compatíveis com Node.js 18 ou mais recente. Registre explicitamente cada projeto e defina
`WENDKEEP_OBSERVER_TOKEN`; leituras no loopback permanecem abertas, mas toda mutação exige Bearer.

## Sintaxe

```bash
npx wendkeep observer status --data-dir <diretório> --json
npx wendkeep observer register --project <projeto> --vault <vault> --data-dir <diretório>
npx wendkeep observer publish --project <projeto> --vault <vault> --data-dir <diretório>
npx wendkeep observer memory import --project <projeto> --vault <vault> --url http://127.0.0.1:8787 --token <token> --json
npx wendkeep observer serve --host 127.0.0.1 --port 8787 --data-dir <diretório> --token <token>
```

## Opções e códigos de saída

- `--data-dir` escolhe o diretório local de eventos e índice; o padrão é
  `WENDKEEP_OBSERVER_DATA_DIR` ou `~/.wendkeep-observer`.
- `--project` e `--vault` identificam o projeto nos comandos `register`, `publish` e `memory import`.
- `--host` aceita somente `127.0.0.1`, `localhost` ou `::1`; outros hosts são recusados antes do
  listen.
- `--token` ou `WENDKEEP_OBSERVER_TOKEN` autentica mutações; `--allow-non-loopback` falha sem token.
- `WENDKEEP_OBSERVER_CAPTURE_LEVEL` aceita `metadata` (padrão, sem mensagens), `messages` ou
  `full-transcript`. Caminhos locais absolutos nunca são publicados.
- Exit `0` indica sucesso; exit `1` indica falha de configuração ou operação; o hook publisher
  também retorna `0` quando o Observer está indisponível.

## Exemplos

```powershell
npx wendkeep observer register --project C:\GitHub\WendKeep --vault C:\GitHub\WendKeep\.WendKeep-vault --data-dir C:\WendKeepObserver
$env:WENDKEEP_OBSERVER_TOKEN = '<token-local-forte>'
npx wendkeep observer serve --host 127.0.0.1 --port 8787 --data-dir C:\WendKeepObserver --token $env:WENDKEEP_OBSERVER_TOKEN
$env:WENDKEEP_OBSERVER_URL = 'http://127.0.0.1:8787'
```

Para Docker local:

```powershell
docker compose -f docker/wendkeep-observer/compose.yaml up -d --build
```

## Painel web local

Com o servidor em execução, abra [http://127.0.0.1:8787/](http://127.0.0.1:8787/) no navegador.
O painel é servido pelo mesmo processo e abre diretamente para consultas, sem formulário ou token. A porta fica
presa ao loopback do computador; não coloque o endereço em uma interface de rede.

O painel mostra a lista multi-projeto, versão, saúde, sessão mais recente, change ativa, contagem
de changes e data da última captura. Ao abrir um projeto, o workspace oferece Overview, Consumo,
Sessões, Memória, Changes e Sincronização. A aba Consumo mostra custo total, tokens por categoria,
agentes principais, subagentes, provedores, modelos, tendência diária, cobertura histórica e
chamadas conforme o nível de captura escolhido. Os estados de carregamento, vazio, servidor
indisponível, conflito, modelo sem tarifa e dados desatualizados ficam visíveis, e a atualização
pode ser manual ou automática a cada 15 segundos.

Se o navegador mostrar a tela mas a lista falhar, confirme a saúde em
`http://127.0.0.1:8787/healthz` e verifique se o container está em execução.

## Resultado esperado

`register` grava `project_id`, nome, versão e data de registro. `publish` lê o vault local,
produz o snapshot e envia eventos idempotentes para o SQLite com o conteúdo integral das sessões,
decisões, bugs, aprendizados, specs, changes, CORE, DIGEST, SHARED_MEMORY, estado do brain,
sessões de agentes, rollups de custo e chamadas. Mensagens e transcripts só são enviados nos
níveis de captura que os habilitam. O container grava tudo em
`/data/observer.sqlite`; não monta `C:\GitHub` nem qualquer `.WendKeep-vault`. Markdown é aceito
somente como conteúdo de uma coluna SQL e volta a existir como arquivo apenas pela exportação
read-only sob demanda. `memory import` faz a carga inicial e retorna a paridade por arquivo e hash.
Na migração, o total de custo/token registrado no frontmatter é preservado por uma linha de
reconciliação quando o ledger detalhado não fecha com ele; essa linha não inventa chamadas.
Sessões históricas com o mesmo `session_id` recebem uma identidade canônica por arquivo para
evitar que um rollup sobrescreva o outro.

No schema 4, cada documento ingerido também é projetado em chunks com caminho, heading,
autoridade, data e validade. O Observer faz um feature probe de FTS5 e usa o índice quando a
extensão está disponível; caso contrário, mantém a mesma semântica por fallback lexical. A busca
retorna o trecho em que houve o match e sua proveniência, não apenas o começo do documento.

O `init` projeta `observer-publish` para `SessionStart`, `Stop` e `SubagentStop` depois dos hooks
principais. Sem servidor disponível, ele grava snapshots em `.brain/observer-outbox/` e eventos
SQL em `.brain/observer-sql-outbox/`, sem bloquear a sessão; uma execução posterior tenta
reenviar os lotes. Os lotes SQL são enviados com gzip para que transcripts completos maiores que
64 MB em JSON puro continuem dentro do limite do transporte; o Observer descomprime e valida o
corpo antes de ingerir. O outbox é transporte temporário, não autoridade.

## Erros comuns e diagnóstico

- `project_not_registered`: rode `observer register` antes de publicar.
- `host loopback`: troque `0.0.0.0` ou endereço LAN por `127.0.0.1`.
- Outbox pendente: o serviço estava indisponível; preserve `.brain/observer-outbox/` e
  `.brain/observer-sql-outbox/` e repita o publisher. Adicione também
  `.brain/observer-sql-state.json` e `.brain/observer-sql-outbox/` ao ignore do Vault. Não apague eventos manualmente.
- `WENDKEEP_OBSERVER_NODE_UNSUPPORTED`: execute o Observer em Node.js 22.13 ou mais recente.
- Se a memória ou o consumo ficarem incompletos, verifique a tela Sincronização, preserve o
  outbox e rode `observer memory import` para reconstruir a carga a partir do vault.

## Próximos passos

Leia a change `local-observer` para o contrato `OBS-1` a `OBS-8`. O volume Docker não deve ser
removido com `docker compose down -v` durante a operação normal, pois isso apaga a projeção local.

## Autoridade dos dados

O SQLite do container é a memória canônica para consultas do Observer e guarda o conteúdo integral
publicado. O vault e qualquer `/data/memory` legado continuam preservados durante a migração como
cópia de transição e fonte de recuperação; os hooks não atualizam Markdown no container depois do
corte. As telas do Observer não concluem, arquivam, reparam ou promovem estado.

## API mínima

- `GET /healthz` — disponibilidade, versão das migrações SQLite e estado da migração legada.
- `GET /v1/projects` — projetos registrados no SQLite, com snapshot quando houver.
- `GET /v1/projects/:project_id` — último snapshot do projeto.
- `GET /v1/projects/:project_id/changes` — resumo das changes do snapshot.
- `PUT /v1/projects/:project_id` — registro explícito local.
- `POST /v1/projects/:project_id/snapshot` — ingestão local idempotente.
- `POST /v1/projects/:project_id/ingest` — lote idempotente de documentos, sessões, agentes, rollups,
  chamadas e transcripts.
- `GET /v1/projects/:project_id/memory/tree` — árvore e metadados dos documentos.
- `GET /v1/projects/:project_id/memory/document?path=...` — conteúdo Markdown integral.
- `GET /v1/projects/:project_id/memory/search?q=...` — busca ranqueada por chunks, com trecho do
  match e proveniência; usa fallback lexical quando FTS5 não está disponível.
- `GET /v1/projects/:project_id/sync` — modo, contagem, conflitos e último evento.
- `PUT /v1/projects/:project_id/sync` — compatibilidade de configuração; a autoridade continua SQL.
- `GET /v1/projects/:project_id/memory/export` — exportação read-only com conteúdo completo.
- `POST /v1/projects/:project_id/memory/events` — ingestão idempotente em lote.
- `GET /v1/projects/:project_id/usage/summary` — totais filtráveis por período, change, sessão,
  agente, provedor, modelo e papel.
- `GET /v1/projects/:project_id/usage/breakdown` — hierarquia de agentes, subagentes e modelos.
- `GET /v1/projects/:project_id/usage/calls` — chamadas individuais com prompt e resposta.
- `GET /v1/projects/:project_id/transcripts/:transcript_id` — transcript comprimido, validado por hash.

As rotas `/v1` rejeitam corpo transportado ou expandido acima do limite e validam projeto, caminho,
revisão, hash, idempotência e isolamento antes de gravar o conteúdo no SQLite. Para preservar uma
cópia Markdown, use a rota `memory/export`; ela não altera a autoridade SQL.
