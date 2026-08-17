# Observer local

**PT-BR** · [English](../../en/commands/observer.md)

## Objetivo

O Observer consolida a observabilidade de vários projetos WendKeep em um serviço local e grava no
volume Docker uma cópia integral da memória publicada pelos hooks. O conteúdo fica disponível
para navegação e busca no próprio container, sem depender do Obsidian para consulta.

## Quando usar

Use para consultar changes, sessões, decisões, bugs, aprendizados, specs, documentos do brain e
saúde de vários projetos em uma única memória local. Durante a transição, o vault continua sendo
preservado como cópia de origem para recuperação; o Observer é a autoridade de consulta do seu
container.

## Quando não usar

Não use o Observer para editar, concluir ou arquivar changes, curar memória, armazenar transcripts
ou expor o serviço na rede. As edições continuam passando pelos hooks e pelo WendKeep local.

## Pré-requisitos

Tenha os projetos inicializados com WendKeep e registre explicitamente cada projeto antes de
iniciar o servidor HTTP. No modo local padrão não há token para configurar.

## Sintaxe

```bash
npx wendkeep observer status --data-dir <diretório> --json
npx wendkeep observer register --project <projeto> --vault <vault> --data-dir <diretório>
npx wendkeep observer publish --project <projeto> --vault <vault> --data-dir <diretório>
npx wendkeep observer memory import --project <projeto> --vault <vault> --url http://127.0.0.1:8787 --json
npx wendkeep observer serve --host 127.0.0.1 --port 8787 --data-dir <diretório>
```

## Opções e códigos de saída

- `--data-dir` escolhe o diretório local de eventos e índice; o padrão é
  `WENDKEEP_OBSERVER_DATA_DIR` ou `~/.wendkeep-observer`.
- `--project` e `--vault` identificam o projeto nos comandos `register`, `publish` e `memory import`.
- `--host` aceita somente `127.0.0.1`, `localhost` ou `::1`; outros hosts são recusados antes do
  listen.
- as rotas `/v1` ficam abertas no modo local padrão; mantenha `--host 127.0.0.1` e não publique a
  porta em um endereço de rede.
- Exit `0` indica sucesso; exit `1` indica falha de configuração ou operação; o hook publisher
  também retorna `0` quando o Observer está indisponível.

## Exemplos

```powershell
npx wendkeep observer register --project C:\GitHub\WendKeep --vault C:\GitHub\WendKeep\.WendKeep-vault --data-dir C:\WendKeepObserver
npx wendkeep observer serve --host 127.0.0.1 --port 8787 --data-dir C:\WendKeepObserver
$env:WENDKEEP_OBSERVER_URL = 'http://127.0.0.1:8787'
```

Para Docker local:

```powershell
docker compose -f docker/wendkeep-observer/compose.yaml up -d --build
```

## Painel web local

Com o servidor em execução, abra [http://127.0.0.1:8787/](http://127.0.0.1:8787/) no navegador.
O painel é servido pelo mesmo processo e abre diretamente, sem formulário ou token. A porta fica
presa ao loopback do computador; não coloque o endereço em uma interface de rede.

O painel mostra a lista multi-projeto, versão, saúde, sessão mais recente, change ativa, contagem
de changes e data da última captura. Ao abrir um projeto, o workspace oferece as telas Overview,
Sessões, Memória, Changes e Sincronização. Cada lista abre o documento Markdown completo em um
leitor read-only, com filtro local, busca no corpo e alternância para a fonte. Os estados de
carregamento, vazio, servidor indisponível, conflito e dados desatualizados ficam visíveis, e a
atualização pode ser manual ou automática a cada 15 segundos.

Se o navegador mostrar a tela mas a lista falhar, confirme a saúde em
`http://127.0.0.1:8787/healthz` e verifique se o container está em execução.

## Resultado esperado

`register` grava `project_id`, nome, versão e data de registro. `publish` lê o vault local,
produz o snapshot e também envia eventos idempotentes com o conteúdo integral das sessões,
decisões, bugs, aprendizados, specs, changes, CORE, DIGEST, SHARED_MEMORY e estado do brain. O
container grava os Markdown em `/data/memory` e mantém `MEMORY_EVENTS.jsonl` e
`MEMORY_INDEX.json` no volume `observer-data`; não monta `C:\GitHub` nem qualquer
`.WendKeep-vault`. `memory import` faz a carga inicial e retorna a paridade por arquivo e hash.

O `init` projeta `observer-publish` para `SessionStart` e `Stop` depois dos hooks principais. Sem
`WENDKEEP_OBSERVER_URL`, o hook é no-op. Com o servidor parado, ele grava os snapshots em
`.brain/observer-outbox/` e a memória integral em `.brain/observer-memory-outbox/`, sem bloquear a
sessão; uma execução posterior tenta reenviar os dois tipos de evento.

## Erros comuns e diagnóstico

- `project_not_registered`: rode `observer register` antes de publicar.
- `host loopback`: troque `0.0.0.0` ou endereço LAN por `127.0.0.1`.
- Outbox pendente: o serviço estava indisponível; preserve `.brain/observer-outbox/` e repita o
  publisher. Não apague eventos manualmente.
- Se a memória ficar incompleta, verifique a tela Sincronização, preserve o outbox e rode
  `observer memory import` para reconstruir a cópia a partir do vault.

## Próximos passos

Leia a change `local-observer` para o contrato `OBS-1` a `OBS-8`. O volume Docker não deve ser
removido com `docker compose down -v` durante a operação normal, pois isso apaga a projeção local.

## Autoridade dos dados

O container é a memória canônica para consultas do Observer e guarda o conteúdo integral
publicado. O vault continua preservado localmente durante a migração como cópia de transição e
fonte de recuperação; as telas do Observer não concluem, arquivam, reparam ou promovem estado.

## API mínima

- `GET /healthz` — disponibilidade sem dados de projeto.
- `GET /v1/projects` — projetos com snapshot aceito.
- `GET /v1/projects/:project_id` — último snapshot do projeto.
- `GET /v1/projects/:project_id/changes` — resumo das changes do snapshot.
- `PUT /v1/projects/:project_id` — registro explícito local.
- `POST /v1/projects/:project_id/snapshot` — ingestão local idempotente.
- `GET /v1/projects/:project_id/memory/tree` — árvore e metadados dos documentos.
- `GET /v1/projects/:project_id/memory/document?path=...` — conteúdo Markdown integral.
- `GET /v1/projects/:project_id/memory/search?q=...` — busca no caminho e no corpo.
- `GET /v1/projects/:project_id/sync` — modo, contagem, conflitos e último evento.
- `PUT /v1/projects/:project_id/sync` — altera explicitamente o modo local.
- `GET /v1/projects/:project_id/memory/export` — exportação read-only com conteúdo completo.
- `POST /v1/projects/:project_id/memory/events` — ingestão idempotente em lote.

As rotas `/v1` rejeitam corpo acima do limite e validam projeto, caminho, revisão, hash e
isolamento antes de gravar o conteúdo no volume.
