# Changes, specs, sensores e archive

**PT-BR** · [English](../../en/commands/changes-and-verification.md)

## Objetivo

Conduzir uma mudança desde a intenção registrada até uma decisão arquivada, ligando requisitos,
tarefas, sensores, evidência e verdict no grafo do cofre.

## Quando usar

Use para qualquer implementação não trivial ou correção que precise deixar prova auditável.

## Quando não usar

Não crie uma change para consultar saúde, importar sessões ou executar manutenção read-only.
Para manutenção local elegível ao perfil `FLOW`, use o microcontrato descrito em
[Perfis de Operação](operating-profiles.md); em `OFF`, o lifecycle permanece disponível, mas não
é imposto pelo Wend Runtime.

## Pré-requisitos

Tenha o projeto inicializado, um vault saudável e `wendkeep.sensors.json` válido na raiz.

## Sintaxe

```bash
npx wendkeep change new <slug> [--simple|--guide] [--session <id>]
npx wendkeep change status [slug] [--session <id>]
npx wendkeep spec effective [--change <slug>] [--session <id>]
npx wendkeep sensors list
npx wendkeep verify [--deep] [--change <slug>] [--session <id>]
npx wendkeep change archive <slug> [--json] [--session <id>]
npx wendkeep change archive recover <operation-id> --change <slug> [--spec-action rollback|resume] [--json]
```

## Opções e códigos de saída

- `wendkeep change new <slug> [--simple|--guide]` cria uma change. `--simple` só pula o design,
  não equivale a `FLOW` e preserva o lifecycle/ADR legado. `--guide` cria o contrato GUIDE
  compacto (objetivo, aceite, áreas, testes e resultado), sem design/spec/ADR automático quando
  `contract_impact:none`.
- `change use`, `list`, `show`, `status`, `diff`, `done` e `undone` inspecionam ou atualizam o
  trabalho sem arquivar.
- `change continue <arquivada> <nova>` abre continuação sem herdar evidência antiga.
- `change bind <slug> --session <id>` liga uma sessão existente.
- `--session <id>` seleciona o `active_contexts` causal nos comandos implícitos. Sem a opção,
  somente um contexto ativo inequívoco da worktree é aceito; ambiguidade retorna exit `2`.
- `change relink [--apply]` e `change backlink [--apply]` reparam o grafo; dry-run é o padrão.
- `change abandon <slug>` descarta sem ADR; `archive --force` exige decisão humana explícita.
- `change archive recover <operation-id> --change <slug> [--spec-action rollback|resume]` inspeciona
  uma transação pendente por padrão; com `rollback` ou `resume`, converge somente a promoção de
  specs preparada no journal, sob lock e validação. Não promove a change, não apaga o journal e não
  inventa reconciliação.
- `wendkeep spec list|show|effective|migrate|rebase` administra contratos vivos e deltas.
- `wendkeep sensors list|add` administra provas executáveis.
- Exit `0` indica comando concluído; os gates usam exit `1` para prova vermelha e exit `2` para
  contexto/uso inválido.

## Exemplos

```bash
npx wendkeep change new login-tenant
npx wendkeep change use login-tenant --session <id>
npx wendkeep change new ajuste-interno --guide
npx wendkeep spec effective --change login-tenant
npx wendkeep change done 1.1 --change login-tenant
npx wendkeep verify --change login-tenant
npx wendkeep verify --deep --change login-tenant
npx wendkeep change archive login-tenant
```

Para adicionar um sensor:

```bash
npx wendkeep sensors add api-contracts "npm run test:contracts" --severity critical
```

## Resultado esperado

A change arquivada move seu delta para o spec vivo quando aplicável e preserva proposta,
tarefas/evidência e design quando existente. GOVERN/ASSURE geram ADR; GUIDE compacta sem impacto
de contrato não gera ADR automático. O archive só passa com tarefas fechadas, sensores exigidos
verdes e verdict atual ligado ao mesmo Evidence Envelope v2. Evidência v1 é mostrada como
`legacy-unbound`; `change status <slug>` também diagnostica `bound`, `stale` e `context-mismatch`.
O archive compara `evidenceEnvelopeId` e o `evidenceBinding` completo de package/verdict com o
checkout provado. Se houver divergência, volte à worktree/sessão correta e rode `verify`,
`verify --deep` e `wk-verify` novamente. Campos, normalização textual/binária, códigos e recovery
estão detalhados no [guia de verify](verify.md).

O gate comum reclassifica envelope, package e verdict como `verified`, `reported`,
`legacy-unbound`, `stale`, `conflict` ou `unproven`; somente `verified` permite archive. Um bloqueio
retorna `WENDKEEP_PROVENANCE_GATE_BLOCKED`: estabilize/recupere o contexto, rode `verify`, depois
`verify --deep` e obtenha novo passe `wk-verify`. `--force` pode dispensar somente tarefa aberta;
para proveniência, integridade, package e verdict ele **não** altera o resultado nem promove spec/ADR.
Os erros de ledger são `WENDKEEP_RECEIPT_LEDGER_BUSY`, `WENDKEEP_RECEIPT_LEDGER_CONFLICT`,
`WENDKEEP_RECEIPT_LEDGER_CORRUPT` e `WENDKEEP_RECEIPT_LEDGER_TRUNCATED`. No bloqueio, use a saída
`--json` sanitizada (`state`, `reasonCodes`, `diagnostics`, `repair.command`), execute o recovery
indicado e rode `npx --no-install wendkeep verify --deep --json`; preserve e recapture a prova, sem
editar ledger/checkpoint ou expor stderr, token, URL privada ou path do Vault.

### Contrato pós-fix do archive

Antes da mutação, faça a recaptura final com `wendkeep verify --deep --change <slug>`. O package
e o verdict devem estar completos e canônicos, com binding do mesmo checkout, change, tarefas,
spec e sensores. O archive grava primeiro um receipt de autorização no ledger separado
`change-archive-receipts-v2`; só depois de validá-lo pode promover spec/ADR ou mover a change.
`change archive --json` expõe o resultado serializável com os campos `state`, `reason_codes`,
`diagnostics` e `repair`. Corrupção ou truncamento no ledger de prova ou no ledger de archive
bloqueia fechado antes de qualquer escrita. `--force` não bypassa proveniência nem integridade,
nem package/verdict, corrupção ou truncamento. O recovery exato é repetir
`wendkeep verify --deep --change <slug>` no checkout correto.

A mutação adquire o lock do runtime `.brain/runtime/change-archive-operation.lock` e abre uma
transação privada ASCII em `.brain/runtime/archive-transactions/<uuid>/{original,authorized}`.
Ela renomeia atomicamente a change viva para `original`, confere o digest e promove somente a
cópia `authorized`; o namespace público nunca é fonte de publicação. Em caso de falha de
selagem ou divergência `WENDKEEP_ARCHIVE_INPUT_CHANGED` antes da promoção, o snapshot
`authorized` é removido e `original` é restaurado sem promoção parcial. O archive bem-sucedido
mantém o journal `completed`; o finalizer pós-release valida os digests de `original` e do destino
publicado, mas retém `original` e a transação, sem cleanup destrutivo automático.

O lock do archive é um `directory lock`: o diretório canônico contém marker específico do token e
lease. A aquisição prepara um diretório irmão `.pending`, escreve owner/lease e publica por rename
atômico para o lock; não usa hardlink e reobserva colisões com no máximo 3 tentativas de topologia.
Owner vivo retorna `WENDKEEP_ARCHIVE_BUSY`; owner morto pode sofrer reap seguro sem apagar sucessor.
Estrutura/marker inválido retorna `WENDKEEP_ARCHIVE_LOCK_UNAVAILABLE`; perda de ownership retorna
`WENDKEEP_ARCHIVE_LOCK_OWNERSHIP_LOST`.

Cada operação mantém `archive-transaction.json` com as fases `prepared` → `isolated` → `copied` →
`sealed` → `published` → `promotion-prepared` → `promotion-applied` → `completed` ou
`recovery-required`. Um journal pending bloqueia novo archive do mesmo slug antes do gate. Em
colisão ou falha pós-publicação, `original` permanece retido e o estado é
`published-recovery-required`. Use a inspeção fail-closed e idempotente
`wendkeep change archive recover <operation-id> --change <slug> [--spec-action rollback|resume] [--json]`;
sem `--spec-action`, só retorna ações sanitizadas. `rollback` restaura before-images e `resume`
converge after-images de uma promoção `promotion-prepared`; ambos preservam o journal para nova
reconciliação.

A promoção multi-spec é uma unidade atômica: captura before-images/digests de todos os capabilities,
faz rollback de todos os alvos (incluindo estado/README) em falha antes ou depois da escrita e só
permite retry após a reconciliação do journal e nova verificação. O finalizer pós-release valida os
digests do original e do destino, mas retém o journal `completed` e `original`; sem cleanup
destrutivo automático. Os campos sanitizados
`operation_id` e `transaction_phase` acompanham o diagnóstico; `repair.command` aponta para
`wendkeep change archive recover <operation-id> --change <slug>` quando há operação identificada.
Texto e --json usam o mesmo diagnóstico sanitizado com code, operation, state, blocker, expected,
observed, recovery, reason_codes, diagnostics e repair.

## Cerca de escopo para ferramentas

O `change-guard` também é projetado para o `PreToolUse` do Codex. Antes de uma mutação Git ou de
uma ferramenta de escrita suportada, ele compara sessão, projeto, raiz Git, remoto, branch e
worktree com a lease registrada no `SESSION_REGISTRY.json`. Um alvo ausente, ambíguo, concorrente ou
fora do projeto é bloqueado antes da ferramenta.

O foco implícito de change vem de `active_contexts`, não de `CURRENT_CHANGE.md`. A chave combina
`repository_id`, `worktree_id` e `work_session_id`; o ponteiro Markdown permanece apenas como
projeção compatível quando existe um único contexto inequívoco.

O [Observer local](observer.md) é uma projeção read-only da observabilidade: o vault e a change
continuam autoridades locais. Consultas do Observer não concluem, arquivam, reparam ou promovem
estado no vault.

No Codex o bloqueio usa `permissionDecision: "deny"`; `ask` não é uma decisão válida de
`PreToolUse`. `commit`, `push`, `pull`, `merge`, `publish` e operações destrutivas continuam
capacidades separadas, inclusive quando um comando contém mais de uma ação. A troca de projeto
exige uma nova seleção/lease; não use autorização de outra conversa.

## Erros comuns e diagnóstico

- `no change`: selecione com `change use <slug>` ou informe `--change`.
- `spec_impact: pending`: defina `required` com delta ou `none` com justificativa real.
- Sensor não executado: mantenha uma ou mais tags `[sensor:id]` na mesma linha do checkbox. Todos
  os IDs distintos dessa linha são exigidos e executados uma vez, na ordem declarada.
- Evidência stale: rode novamente `verify` e `verify --deep` depois de alterar tarefas/spec.
- Evidência de outra worktree/sessão: retorne ao contexto causal correto; ela não satisfaz o
  archive atual mesmo que todos os sensores estejam verdes.
- Rebase em conflito: resolva o delta ou use `--accept-current` apenas quando isso for a decisão.

## Próximos passos

Leia [Perfis de Operação](operating-profiles.md), o guia profundo de [verify](verify.md) e a
referência de [manutenção e diagnóstico](maintenance-and-diagnostics.md).
