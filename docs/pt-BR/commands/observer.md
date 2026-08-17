# Observer local

**PT-BR** · [English](../../en/commands/observer.md)

## Objetivo

O Observer consolida a observabilidade de vários projetos WendKeep em um serviço local, sem
copiar ou assumir a propriedade dos vaults.

## Quando usar

Use para consultar changes, sessões, tarefas resumidas e saúde de vários projetos em uma única
projeção local, mantendo cada vault como fonte oficial.

## Quando não usar

Não use o Observer para editar, concluir ou arquivar changes, curar memória, armazenar transcripts
ou substituir os hooks locais. Não o exponha na rede nesta versão.

## Pré-requisitos

Tenha os projetos inicializados com WendKeep, registre explicitamente cada projeto e defina um
token local antes de iniciar o servidor HTTP.

## Sintaxe

```bash
npx wendkeep observer status --data-dir <diretório> --json
npx wendkeep observer register --project <projeto> --vault <vault> --data-dir <diretório>
npx wendkeep observer publish --project <projeto> --vault <vault> --data-dir <diretório>
npx wendkeep observer serve --host 127.0.0.1 --port 8787 --data-dir <diretório>
```

## Opções e códigos de saída

- `--data-dir` escolhe o diretório local de eventos e índice; o padrão é
  `WENDKEEP_OBSERVER_DATA_DIR` ou `~/.wendkeep-observer`.
- `--project` e `--vault` identificam o projeto somente nos comandos `register` e `publish`.
- `--host` aceita somente `127.0.0.1`, `localhost` ou `::1`; outros hosts são recusados antes do
  listen.
- `--token` ou `WENDKEEP_OBSERVER_TOKEN` protege as rotas `/v1`; `GET /healthz` permanece sem
  dados de projeto.
- Exit `0` indica sucesso; exit `1` indica falha de configuração ou operação; o hook publisher
  também retorna `0` quando o Observer está indisponível.

## Exemplos

```powershell
$env:WENDKEEP_OBSERVER_TOKEN = '<token-local>'
npx wendkeep observer register --project C:\GitHub\WendKeep --vault C:\GitHub\WendKeep\.WendKeep-vault --data-dir C:\WendKeepObserver
npx wendkeep observer serve --host 127.0.0.1 --port 8787 --data-dir C:\WendKeepObserver
$env:WENDKEEP_OBSERVER_URL = 'http://127.0.0.1:8787'
```

Para Docker local:

```powershell
$env:WENDKEEP_OBSERVER_TOKEN = '<token-local>'
docker compose -f docker/wendkeep-observer/compose.yaml up -d --build
```

## Resultado esperado

`register` grava apenas `project_id`, nome, versão e data de registro. `publish` lê o vault local,
produz um snapshot sanitizado e envia um evento idempotente. O container mantém somente
`EVENTS.jsonl` e `INDEX.json` no volume `observer-data`; não monta `C:\GitHub` nem qualquer
`.WendKeep-vault`.

O `init` projeta `observer-publish` para `SessionStart` e `Stop` depois dos hooks principais. Sem
`WENDKEEP_OBSERVER_URL`, o hook é no-op. Com o servidor parado, ele grava em
`.brain/observer-outbox/` e não bloqueia a sessão; uma execução posterior tenta reenviar eventos
pendentes.

## Erros comuns e diagnóstico

- `project_not_registered`: rode `observer register` antes de publicar.
- `unauthorized`: confira `Authorization: Bearer <token>` e `WENDKEEP_OBSERVER_TOKEN`.
- `host loopback`: troque `0.0.0.0` ou endereço LAN por `127.0.0.1`.
- Outbox pendente: o serviço estava indisponível; preserve `.brain/observer-outbox/` e repita o
  publisher. Não apague eventos manualmente.
- O Observer não lê conteúdo bruto, caminhos, transcripts ou memória; rejeições desse tipo são
  esperadas e devem ser investigadas na origem do snapshot.

## Próximos passos

Leia a change `local-observer` para o contrato `OBS-1` a `OBS-8`. O volume Docker não deve ser
removido com `docker compose down -v` durante a operação normal, pois isso apaga a projeção local.

## Autoridade dos dados

O vault de cada projeto continua sendo a fonte oficial de sessões, changes, tarefas, memória e
evidências. O Observer é uma projeção read-only reconstruível; suas consultas não concluem,
arquivam, reparam ou promovem estado no vault.

## API mínima

- `GET /healthz` — disponibilidade sem dados de projeto.
- `GET /v1/projects` — projetos com snapshot aceito.
- `GET /v1/projects/:project_id` — último snapshot do projeto.
- `GET /v1/projects/:project_id/changes` — resumo das changes do snapshot.
- `PUT /v1/projects/:project_id` — registro explícito autenticado.
- `POST /v1/projects/:project_id/snapshot` — ingestão autenticada e idempotente.

As rotas `/v1` rejeitam corpo acima do limite e nunca aceitam caminho de vault, transcript, segredo
ou conteúdo bruto de memória.
