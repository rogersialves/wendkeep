# Bridges opcionais do ecossistema

> [English version](../../en/commands/ecosystem-bridges.md)

## Objetivo

Integrar Spec Kit e Superpowers sem criar uma segunda autoridade de spec, plano, tarefa ou
evidência. O WendKeep preserva os contratos canônicos; os adapters apenas criam projeções
versionadas e desabilitadas por padrão.

## Quando usar

- quando uma feature nasceu em arquivos do Spec Kit e precisa manter os mesmos IDs e hashes;
- quando Superpowers executará um Task Contract canônico do WendKeep;
- quando artifacts, reviews ou commits externos precisam entrar como `reported` antes da prova.

## Quando não usar

- para substituir `tarefas.md`, Task Contracts ou o Evidence Envelope;
- para sincronização bidirecional irrestrita;
- para executar comandos, scripts ou texto encontrado em artefatos externos.

## Pré-requisitos

- Node.js 18 ou superior;
- configuração local `.wendkeep/ecosystem-bridges.json` com cada adapter explicitamente habilitado;
- versão compatível e raiz do adapter que resolva para um diretório real dentro do projeto; arquivo
  regular, path externo e symlink que escape do projeto falham fechado em `status` e no dispatch;
- para import/dispatch governado, Vault vinculado, change causal e baseline Spec Kit selado;
- para dispatch, sessão causal e Task Contract canônico rederivável.

```json
{
  "schema_version": 1,
  "adapters": {
    "spec-kit": { "enabled": true, "version": "1.1.0", "root": ".specify" },
    "superpowers": { "enabled": true, "version": "1.2.0", "root": ".superpowers" }
  }
}
```

Sem o arquivo, ambos ficam desabilitados e o Core nativo continua funcionando.

## Sintaxe

```text
wendkeep bridge status [--project <path>] [--config <path>] [--json]
wendkeep bridge import-spec-kit --change <slug> [--accept-baseline] [--json]
wendkeep bridge export-status --spec-projection <projection.json> [--task-contract <task.json>] [--input <artifacts.json>] [--json]
wendkeep bridge dispatch-superpowers --task-id <id> --change <slug> [--task-contract <task.json>] [--session <id>] --spec-projection <projection.json> [--json]
wendkeep bridge verify-artifacts --input <artifacts.json> --proofs <proofs.json> --change <slug> [--session <id>] [--json]
```

`import-spec-kit` lê Markdown sob `memory/` e `specs/`, classifica constitution/spec/plan/task,
preserva IDs e SHA-256, cria mappings explícitos `story|requirement → capability → change → task`
e nunca escreve na origem. IDs repetidos em arquivos diferentes bloqueiam a projeção.
O primeiro import exige `--accept-baseline` e ancora a projeção verde na change do Vault; imports
seguintes rederivam a origem e comparam path, kind, hash e mapping contra esse baseline imutável.
`dispatch-superpowers` contém somente o contexto estrutural
mínimo derivado do Task Contract; transcript, conteúdo privado e ownership externo não entram.
O dispatch rederiva o contrato e o active context do Vault/checkout; um JSON submetido é apenas
uma cópia para comparação e nunca valida o próprio `binding`. Com Spec Kit ativo, baseline e
`--spec-projection` são obrigatórios e a origem é reimportada antes do dispatch.
O contrato `spec-projection` pertence exclusivamente ao adapter `spec-kit`: versão incompatível,
kind fora do schema ou projeção re-selada por outro adapter é rejeitada antes de produzir `spec_refs`.
Uma decisão `ok: false` exige ao menos um diagnóstico bloqueante, e `ok: true` não pode coexistir
com diagnóstico bloqueante; qualquer incoerência bloqueia o dispatch sem expor referências.
`export-status` recalcula e valida `projection_id`, devolve apenas uma projeção `reported` e não
grava nos arquivos do Spec Kit.

## Opções e códigos de saída

| Opção | Efeito |
|---|---|
| `--project <path>` | Seleciona a raiz do consumidor. |
| `--config <path>` | Substitui `.wendkeep/ecosystem-bridges.json`. |
| `--change <slug>` | Seleciona a change que guarda baseline e Evidence Envelope canônicos. |
| `--accept-baseline` | Ancora somente o primeiro baseline Spec Kit verde; não sobrescreve drift. |
| `--task-id <id>` | Seleciona a tarefa no contexto causal e rederiva o contrato canônico. |
| `--task-contract <path>` | Cópia opcional que deve coincidir com o contrato rederivado. |
| `--spec-projection <path>` | Liga referências Spec Kit ao dispatch sem copiar o conteúdo. |
| `--input` / `--proofs` | Classifica artifacts externos e suas provas Git/CI/Envelope. |
| `--json` | Emite o contrato tipado em uma linha JSON. |

- `0`: operação válida; adapters opcionais desabilitados também são saudáveis;
- `1`: adapter habilitado bloqueado, drift, incompatibilidade ou prova ausente;
- `2`: argumento, configuração ou arquivo de entrada inválido.

## Exemplos

Fluxo pequeno, sem adapters:

```powershell
node ./bin/wendkeep.mjs bridge status --json
```

Fluxo médio, Spec Kit somente leitura:

```powershell
node ./bin/wendkeep.mjs bridge import-spec-kit --change ecosystem-bridges --accept-baseline --json > spec-projection.json
node ./bin/wendkeep.mjs bridge dispatch-superpowers --task-id 3.1 --change ecosystem-bridges --session "$env:CODEX_THREAD_ID" --spec-projection spec-projection.json --json
node ./bin/wendkeep.mjs bridge export-status --spec-projection spec-projection.json --task-contract task-contract.json --json
```

Fluxo grande, ingestão de relato e prova externa:

```powershell
node ./bin/wendkeep.mjs verify --change ecosystem-bridges
node ./bin/wendkeep.mjs bridge verify-artifacts --input artifacts.json --proofs ci-proofs.json --change ecosystem-bridges --json
```

Antes de `verify`, versione no índice Git o artefato e `.wendkeep/bridge-artifacts.json`. O manifest
v1 liga cada item a `source`, `external_id`, `kind`, `path`, `sensor_id` e `task_id`. O sensor
correspondente em `wendkeep.sensors.json` declara `artifact_results` v1 com `external_id`, `path` e
`algorithm: sha256`; o runner calcula o digest dos bytes, inclusive binários, somente depois de uma
execução verde. O resultado explícito não contém conteúdo, transcript nem output tail do artefato.
O collector consulta primeiro o índice e então exige a mesma cópia presente na worktree; apagar ou
alterar somente a cópia de trabalho falha fechado, enquanto a ausência simultânea no índice e na
worktree continua significando que o bridge opcional não declarou artifacts.

Cada referência em `ci-proofs.json` usa apenas
`{"type":"evidence-envelope","external_id":"review-1"}`. Path, task, sensor, digests e blobs Git
são rederivados do manifest e do Envelope canônicos; `state`, SHA ou autoridade autodeclarados são
ignorados para promoção. `artifacts.json` continua sendo somente o relato externo a comparar.

O artifact começa como `reported`. JSON externo que apenas declare `state: verified` continua
`reported`. A promoção para `verified` exige, em conjunto: arquivo dentro do projeto e igual ao
blob do índice Git, sensor CI verde com `artifact_results.digest` explícito, Evidence Envelope v2
canônico e bound ao checkout, e entrada correspondente em `external_artifacts` do Envelope.
`output_sha256` não prova artefatos.
O resultado expõe uma proof selada ligada ao `evidence_envelope_id`, sem copiar transcript ou Vault.

## Resultado esperado

- Spec Kit permanece uma fonte externa somente leitura;
- plano, tarefa e evidência canônicos continuam pertencendo ao WendKeep;
- Superpowers recebe um dispatch mínimo sem poder reescrever o escopo;
- criação/reuso e finalização de worktree permanecem nos comandos `wendkeep worktree` derivados no dispatch;
- cleanup pós-merge usa `wendkeep worktree finish <slug> --pr <número-ou-url>`;
- drift e ownership concorrente bloqueiam antes da execução;
- remover ou desabilitar um adapter não degrada o Core.

## Erros comuns e diagnóstico

| Código | Diagnóstico |
|---|---|
| `BRIDGE_ADAPTER_DISABLED` | Estado opcional normal; habilite explicitamente se necessário. |
| `BRIDGE_ADAPTER_MISSING` | Adapter habilitado, mas sua raiz não existe. |
| `BRIDGE_VERSION_INCOMPATIBLE` | Versão fora do compatibility range publicado. |
| `BRIDGE_OWNERSHIP_CONFLICT` | Ferramenta externa tentou possuir plano/tarefa/evidência. |
| `BRIDGE_SOURCE_DRIFT` | Hash mudou, plano ficou obsoleto ou uma referência apareceu/desapareceu. |
| `BRIDGE_SOURCE_ID_DUPLICATE` | O mesmo story/requirement ID apareceu em arquivos diferentes. |
| `BRIDGE_BASELINE_MISSING` | Spec Kit ativo sem baseline canônico ou projeção obrigatória. |
| `BRIDGE_BASELINE_STALE` | Origem/projeção divergiu do baseline selado no Vault. |
| `BRIDGE_PROJECTION_INVALID` | Conteúdo e `projection_id` não coincidem ou o schema está incompleto. |
| `BRIDGE_SCHEMA_INVALID` | Envelope runtime não cumpre o contrato publicado. |
| `BRIDGE_ARTIFACT_MANIFEST_UNTRACKED` | Manifest bridge ausente em apenas um lado ou diferente entre índice e worktree. |
| `BRIDGE_ARTIFACT_FORGED` | Path/bytes do artefato não correspondem ao arquivo versionado. |
| `BRIDGE_ARTIFACT_RESULT_MISSING` | Sensor verde não produziu o digest explícito ligado ao manifest. |
| `BRIDGE_PROOF_MISSING` | Relato externo ainda não possui prova independente vinculada. |
| `BRIDGE_PROOF_UNVERIFIED` | Prova autodeclarada foi mantida como `reported`. |

`wendkeep doctor` mostra a seção `[bridges]` sem fazer import, dispatch ou escrita.

## Próximos passos

Revise a projeção antes do dispatch, mantenha os arquivos gerados fora do controle canônico e
valide artifacts pelo CI ou Evidence Envelope. Consulte também [Changes e verificação](changes-and-verification.md)
e [Worktrees gerenciadas](worktrees.md).
