# Verify e verificação independente

**PT-BR** · [English](../../en/commands/verify.md)

## Objetivo

Executar os sensores exigidos pelas tarefas de uma change, persistir evidência fresca e montar o
pacote autocontido usado pelo passe independente `wk-verify`.

## Quando usar

Use depois de implementar as tarefas e novamente sempre que tarefas, specs ou testes mudarem.

## Quando não usar

Não use como health check pós-instalação ou quando não existe change. Nesse caso, rode
`wendkeep doctor` e `wendkeep memory status --gate`. Em `FLOW`, a validação e o recibo pertencem a
`flow finish`; em `OFF`, `verify` continua disponível apenas quando o usuário escolhe executar o
lifecycle manualmente.

## Pré-requisitos

- Change aberta selecionada por `CURRENT_CHANGE.md` ou `--change <slug>`.
- `tarefas.md` sem placeholders, com tags `[req:]` e uma ou mais `[sensor:]` na linha do checkbox;
  todos os IDs distintos de sensor são exigidos uma vez, na ordem declarada.
- Sensores declarados em `wendkeep.sensors.json`.

## Sintaxe

```bash
npx wendkeep verify [--change <slug>] [--project <raiz>] [--vault <cofre>]
npx wendkeep verify --deep [--change <slug>]
npx wendkeep change use <slug>
```

## Opções e códigos de saída

- `--change <slug>` mira uma change sem alterar o ponteiro ativo.
- `change use <slug>` troca o foco persistido para comandos seguintes.
- `--project <raiz>` define onde os sensores executam; `--vault` define onde a prova é gravada e é
  propagado aos sensores como `OBSIDIAN_VAULT_PATH`, inclusive no `memory-health`.
- **Exit 0:** todos os sensores exigidos passaram e a evidência foi gravada.
- **Exit 1:** o gate executou, mas ao menos um sensor crítico ficou vermelho ou um mutante
  sobreviveu.
- **Exit 2:** uso/contexto inválido, como `no change (--change or active)`, vault ausente,
  change inexistente, projeto fora de um repositório Git, `wendkeep.sensors.json` inválido ou
  `WENDKEEP_EVIDENCE_HEAD_CHANGED`.

`verify --deep` gera `verificacao.json`; ele não substitui o verificador. A skill `wk-verify`
precisa ser executada por autor diferente e grava `verdict.json`.

## Exemplos

Change ativa:

```bash
npx wendkeep verify
npx wendkeep verify --deep
```

Change explícita:

```bash
npx wendkeep verify --change tenant-login
npx wendkeep verify --deep --change tenant-login
```

Projeto sem change aberta:

```bash
npx wendkeep doctor --vault .MeuApp-vault
npx wendkeep memory status --gate --vault .MeuApp-vault
```

## Resultado esperado

`evidencia.json` segue o [schema público v2](../../../schema/wendkeep.evidence-envelope-v2.schema.json).
O envelope liga `project_id`, `repository_id`, `worktree_id`, `work_session_id`, change e branch a
`base_sha`, `head_sha`, `index_tree_sha`, `worktree_digest`, tarefas, spec e configuração dos
sensores por SHA-256 completo. O digest cobre staged, unstaged, untracked, rename e delete; paths
usam `/`, texto normaliza CRLF/CR para LF e binários preservam bytes. A classificação binária
respeita atributos Git `binary`/`-text` e extensões binárias conhecidas (incluindo `.bin`); arquivos
ignorados não entram.

Cada sensor registra comando sanitizado e seu hash, início/fim, duração, exit code, digest da saída
e tail sanitizado de até 2.000 caracteres. Os artefatos são publicados por temporário path-safe no
mesmo diretório e rename atômico. No deep, `verificacao.json` e `verdict.json` carregam o mesmo
`evidenceEnvelopeId` e `evidenceBinding` completo; o verificador independente deve preservar ambos
no verdict.

Evidência v1 continua legível como `legacy-unbound`, nunca como autoridade equivalente. Rode
`wendkeep change status <slug>` para ver `bound`, `stale` ou `context-mismatch`.

O gate de proveniência normaliza a visão legada numa taxonomia única: `verified` quando toda prova
obrigatória está fresca e vinculada; `reported` para claim registrada sem observação autoritativa;
`legacy-unbound` para v1; `stale` para um snapshot anterior; `conflict` para identidade/conteúdo
incompatível; e `unproven` para prova ausente ou insuficiente. A precedência é `conflict` > `stale`
> `legacy-unbound` > `unproven` > `reported` > `verified`, e somente `verified` fecha o gate.

Para o archive pós-fix, o passe final é `wendkeep verify --deep --change <slug>`. Ele deve deixar
package e verdict completos e canônicos, ligados ao mesmo checkout, change, tarefas, spec e
sensores. O archive grava o receipt de autorização antes da mutação no ledger separado
`change-archive-receipts-v2`. Sua saída `change archive --json` é serializável e expõe `state`,
`reason_codes`, `diagnostics` e `repair`; corrupção ou truncamento de ledger bloqueia fechado.
`--force` não bypassa proveniência ou integridade. O recovery exato é repetir
`wendkeep verify --deep --change <slug>` depois de estabilizar o contexto.

O archive usa um `directory lock` com marker específico do token e lease. A aquisição prepara um
diretório irmão `.pending` e publica-o por rename atômico, sem hardlink, com no máximo 3 tentativas
de topologia. Owner vivo produz `WENDKEEP_ARCHIVE_BUSY`; owner morto só é reapado com observação
segura; marker/estrutura inválida produz `WENDKEEP_ARCHIVE_LOCK_UNAVAILABLE`; perda de ownership
produz `WENDKEEP_ARCHIVE_LOCK_OWNERSHIP_LOST`. O manifest `archive-transaction.json` registra
`prepared` → `isolated` → `copied` → `sealed` → `published` → `promotion-prepared` →
`promotion-applied` → `completed` ou `recovery-required`. Um journal pending bloqueia novo archive
do mesmo slug antes do gate. Em
collision ou falha pós-publicação, `original` é retido e o estado
`published-recovery-required` bloqueia retry destrutivo. `operation_id` e `transaction_phase` são
campos sanitizados. Inspecione com
`wendkeep change archive recover <operation-id> --change <slug> [--spec-action rollback|resume] [--json]`:
sem `--spec-action`, é somente-leitura, fail-closed e idempotente, sem promoção, deleção ou
reconciliação inventada. `rollback` restaura before-images e `resume` converge after-images de uma
promoção `promotion-prepared`, mantendo o journal para reconciliação. Quando há operation ID,
`repair.command` aponta para `wendkeep change archive recover <operation-id> --change <slug>`; não
trate `command:null` como fluxo normal.

A promoção multi-spec é uma unidade atômica: captura before-images/digests de todos os capabilities,
faz rollback de todos os alvos (incluindo estado/README) em falha antes ou depois da escrita e só
permite retry após reconciliação do journal e nova verificação. O finalizador pós-release valida os
digests do original e do destino, mas o `completed` journal mantém o `original` retido; sem cleanup
destrutivo automático. Falha mantém `published-recovery-required`.

## Erros comuns e diagnóstico

- `no change`: isso é exit 2 e estado ocioso válido; crie/use uma change ou não rode verify.
- Zero/sensores ausentes: confira todas as tags na mesma linha e `sensors list`; várias tags na
  mesma tarefa são válidas e todas entram no gate.
- Gate vermelho: consulte o campo `note` limitado da entrada em `evidencia.json`, corrija a causa
  e repita; não use `archive --force` por conta própria.
- Verdict stale/ausente: regenere `--deep` e peça novo passe independente.
- `WENDKEEP_EVIDENCE_HEAD_CHANGED`: o HEAD mudou enquanto os sensores rodavam; estabilize o
  checkout e repita. A evidência anterior não foi substituída.
- `legacy-unbound`, `stale` ou `context-mismatch`: volte à worktree/sessão correta, recupere o
  contexto se necessário e rode `verify` + `verify --deep` novamente.
- `WENDKEEP_PROVENANCE_GATE_BLOCKED`: leia `state`, `reasonCodes` e `repair`; não reutilize uma
  prova de outra branch/worktree/sessão. Rode o comando indicado e recapture o envelope.
- Os erros `WENDKEEP_RECEIPT_LEDGER_BUSY`, `WENDKEEP_RECEIPT_LEDGER_CONFLICT`,
  `WENDKEEP_RECEIPT_LEDGER_CORRUPT` e `WENDKEEP_RECEIPT_LEDGER_TRUNCATED` exigem preservar o
  ledger/checkpoint e executar o recovery objetivo em `repair.command` (ou
  `npx --no-install wendkeep verify --deep --json` para uma prova fresca); a saída textual/JSON
  permanece sanitizada e não contém stderr bruto, tokens, URLs privadas ou paths do Vault.
- Mutantes sobreviventes: fortaleça o teste discriminante; após três rodadas, revise manualmente.

## Próximos passos

Volte ao [ciclo de changes](changes-and-verification.md) para archive, confira os
[Perfis de Operação](operating-profiles.md) ou consulte
[manutenção](maintenance-and-diagnostics.md) quando não houver change.
