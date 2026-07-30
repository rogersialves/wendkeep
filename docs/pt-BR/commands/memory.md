# Memória compartilhada e curadoria

**PT-BR** · [English](../../en/commands/memory.md)

## Objetivo

Inspecionar e curar CORE, SHARED, ledger, outbox, attempts e candidates sem confundir autoria
canônica com estado operacional gerado.

## Quando usar

Use no CI, antes de verify/archive, diante de avisos do doctor ou para decidir candidates.

## Quando não usar

Não edite `SHARED_MEMORY.md` ou `MEMORY_EVENTS.jsonl` à mão. Não use repair em vault legado que
apenas aguarda migração.

## Pré-requisitos

Informe o vault explicitamente em automações. Preserve backups e evidências antes de reparar.

## Sintaxe

```bash
npx wendkeep memory status [--gate] --vault <cofre>
npx wendkeep memory repair --vault <cofre>
npx wendkeep memory reconcile <sessão-ambígua> --by-session <sessão-sucessora> --reason <motivo> [--apply] --vault <cofre>
npx wendkeep memory promote <candidate> [--event <event-id>] --vault <cofre>
npx wendkeep memory reject <candidate> --vault <cofre>
npx wendkeep validate-memory [caminho-do-CORE]
npx wendkeep validate-memory --vault <cofre-v2>
```

## Opções e códigos de saída

- `memory status` é read-only; `--gate` retorna exit `1` apenas para estado bloqueante.
- O `Stop` grava os eventos na outbox antes de reconhecer `last_memory_attempt: enqueued`; depois o
  projector roda fora do lock do registry. Retry do mesmo attempt reutiliza os event IDs congelados
  e pode projetá-los no máximo uma vez.
- Projector busy/falho persiste `degraded`, preserva a outbox e avisa que há replay. Um Stop/retry
  seguinte reaproveita essa tentativa; não reconstrói o handoff com dados transitórios novos.
- O outcome só atualiza `memory_status`/checkpoint se activation, epoch, turno e attempt ainda forem
  exatamente os mesmos. Resultado stale/superseded não apaga nem sobrescreve checkpoint mais novo.
- Vault legado válido gera warning e exit `0`. Em v2, o status correlaciona
  `last_memory_attempt`, disposition, outbox, ledger, SHARED e checkpoint: attempt ambíguo,
  publicação perdida ou checkpoint divergente bloqueiam; `degraded` com outbox íntegra é warning.
- `memory repair` é exclusivamente estrutural: trabalha sob locks com owner PID/token, salva
  `.bak`, retém eventos válidos e reprojeta. Quando reconhece um checkpoint pré-0.59 válido com
  cursor causal, migra-o por CAS para a fronteira física. Também reconhece um prefixo histórico
  assert-only somente quando revision, cursor, hash, identidade, turns e o espelho
  `memory_checkpoint` reproduzem exatamente a semântica antiga; o alvo é o replay atual daquele
  prefixo, sem absorver eventos posteriores. Ambos os casos fazem CAS do attempt e do espelho e
  registram backup/auditoria. O repair nunca reclassifica attempts do registry nem aceita tuple,
  operação ou espelho que não seja rederivado integralmente.
- `memory reconcile` é dry-run por padrão. `--apply` exige duas sessões nomeadas e motivo, faz CAS
  do attempt exato, salva backup do registry e limita a mutação ao attempt ambíguo e à sucessora.
  O replay é CORE-aware, usa cursor físico do ledger no checkpoint e não reescreve ledger, CORE ou
  notas, nem consome a outbox. Repetir a mesma decisão aplicada é idempotente.
- Toda rota de memória valida a topologia física de `.brain`, ledger, outbox, CORE, SHARED,
  candidates, registry, notas, backups, temporários e sidecars antes de ler ou escrever. Junction,
  symlink, reparse point ou hardlink falham fechados sem tocar bytes externos. Locks publicam owner
  e lease atomicamente, não colhem PID vivo apenas por idade e só liberam a lease adquirida.
- `promote`/`reject` acrescentam uma decisão auditável e idempotente ao ledger. Replay e repair
  preservam a decisão e não recriam o candidate resolvido. Para candidate `conflict`, `promote`
  exige `--event <event-id>` pertencente ao candidate; não há vencedor implícito por data ou ID.
  `reject` preserva o valor operacional atual. Candidate `blocked_by_core` só pode ser rejeitado:
  promover exige antes alterar CORE pela curadoria canônica. Se o evento escolhido ainda pertence
  ao último attempt `projected` correspondente, a promoção também atualiza causalmente checkpoint
  e espelho; o JSON retorna `checkpointRefreshed`, e um attempt concorrente mais novo não é tocado.
- `validate-memory <CORE.md>` valida cap de 25 linhas, seções e segredos.
- `validate-memory --vault` exige bundle v2 completo; não é o gate correto para vault legado.

## Exemplos

```bash
npx wendkeep memory status --gate --vault .MeuApp-vault
npx wendkeep memory reconcile antiga --by-session atual --reason "entrega continuada" --vault .MeuApp-vault
npx wendkeep memory reconcile antiga --by-session atual --reason "entrega continuada" --apply --vault .MeuApp-vault
npx wendkeep validate-memory .MeuApp-vault/.brain/CORE.md
npx wendkeep memory promote candidate-123 --event mem-escolhido --vault .MeuApp-vault
npx wendkeep memory reject candidate-456 --vault .MeuApp-vault
```

## Resultado esperado

O status imprime schema, revision, cursor, hash, eventos, outbox, candidates, conflitos e o estado
causal do último attempt. CORE permanece canônico e curado à mão; SHARED permanece projeção
operacional verificável. Depois de uma projeção bem-sucedida, o checkpoint do attempt pode ser um
prefixo válido de uma projeção global que já avançou com eventos concorrentes.

## Erros comuns e diagnóstico

- `legacy`: siga o guia de migração; não é corrupção.
- `revision: 0` logo após migração válida, sem attempt v2, é saudável; não rode repair só para
  fabricar o primeiro evento.
- `degraded` com todos os event IDs presentes no ledger ou na outbox íntegra é recuperável; deixe o
  replay idempotente concluir. Event ID ausente nos dois lugares indica publicação perdida.
- Attempt `ambiguous`, attempt `applied` sem event IDs, evento `projected` apenas na outbox ou
  checkpoint divergente são bloqueantes: preserve os artefatos e investigue antes de repair. Se a
  ambiguidade for comprovadamente substituída por uma sessão sucessora, revise o dry-run de
  `memory reconcile` antes de autorizar `--apply`; o comando falha se o attempt ambíguo tiver IDs.
- Candidate pendente comum: warning recuperável, exige decisão humana quando apropriado.
- `promote` informa que `--event` é obrigatório: leia os `event_ids` do candidate, compare a
  proveniência/valor e indique explicitamente o vencedor. ID que não pertence ao candidate falha
  sem mutar ledger ou projeções.
- `event_cursor` ausente ou hash divergente em v2: preserve o bundle e avalie `memory repair`.
- `validate-memory --vault` falha no legado: valide apenas CORE ou migre primeiro.

## Próximos passos

Leia [migração de memória](memory-migration.md), [manutenção](maintenance-and-diagnostics.md) e
[verify](verify.md).
