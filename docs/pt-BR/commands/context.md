# Contexto ativo

**PT-BR** · [English](../../en/commands/context.md)

## Objetivo

Inspecionar e mover a scope causal da mesma sessão com prova do checkout atual, recuperar uma
divergência em quarentena ou reparar explicitamente autoridade operacional que o `doctor` provou
estar órfã, ligada a worktree removida ou com lease expirada.

## Quando usar

Use `context switch` para criar ou selecionar outra branch na mesma worktree. Se o registry já
registrou `project_scope_conflict`, use `context status` para inventariar `reserved` e `observed`
sem paths locais; recupere somente com `context recover` e uma seleção humana explícita.
Use `doctor` para obter key/revision de dívida em `active_contexts`; execute `context repair` somente
depois de revisar o diagnóstico e fornecer sessão ator e motivo explícitos.

## Quando não usar

Não use para mudar de worktree, editar o registry à mão ou substituir `worktree create`. Recovery
não escolhe a candidata automaticamente e não aceita uma scope que deixou de corresponder ao HEAD.
`context repair` não serve para encerrar contexto saudável, limpar por idade ou apagar histórico.

## Pré-requisitos

- Projeto Git vinculado a um Vault por `.wendkeep.json`.
- Sessão ativa com `project_scope` completa e correspondente à worktree atual.
- Git disponível no `PATH` e branch válida segundo `git check-ref-format --branch`.

## Sintaxe

```bash
npx --no-install wendkeep context switch <branch> [--create] [--session <id>] [--project <raiz>] [--vault <cofre>] [--json]
npx --no-install wendkeep context status --session <id> [--project <raiz>] [--vault <cofre>] [--json]
npx --no-install wendkeep context recover --session <id> --select <reserved|observed> --revision <n> --reason <texto> [--project <raiz>] [--vault <cofre>] [--json]
npx --no-install wendkeep context repair --key <repository:worktree:work-session> --revision <n> --reason <texto> --session <id> [--project <raiz>] [--vault <cofre>] [--json]
```

Sem `--session`, exatamente uma sessão ativa deve corresponder integralmente à scope atual. Use
`--create` para executar `git switch -c`; sem a flag, a semântica é `git switch`.

## Opções e códigos de saída

- `--create`: cria a branch a partir do HEAD atual.
- `--session <id>`: seleciona a sessão causal ou, no repair, a sessão ator ativa e auditável.
- `--key <repository:worktree:work-session>`: seleciona exatamente o active context diagnosticado.
- `--select <reserved|observed>`: escolhe exatamente uma candidata da quarentena; obrigatório no recovery.
- `--revision <n>`: CAS contra a revisão exibida por `context status` ou pelo `doctor`; obrigatório
  em recovery e repair.
- `--reason <texto>`: justificativa auditável, sanitizada e limitada a 240 caracteres.
- `--project <raiz>` e `--vault <cofre>`: selecionam binding e paths para uso manual.
- `--json`: emite status, session id, branch, HEAD, revisão e evento sem expor o Vault.

Exit `0` significa transição concluída ou destino já ativo. Uso inválido, ambiguidade,
scope divergente, conflito, falha Git ou rollback retorna `2` com um código `WENDKEEP_CONTEXT_*`.

## Exemplos

```bash
npx --no-install wendkeep context switch wk/auth --create
npx --no-install wendkeep context switch main --session 019abc-session-id
npx --no-install wendkeep context switch wk/auth --session 019abc-session-id --json
npx --no-install wendkeep context status --session 019abc-session-id --json
npx --no-install wendkeep context recover --session 019abc-session-id --select observed --revision 7 --reason "checkout confirmado"
npx --no-install wendkeep context repair --key "repo:tree:work" --revision 4 --reason "worktree removida após merge" --session 019abc-session-id
```

Não substitua pelo comando cru abaixo quando o harness estiver ativo:

```bash
git switch -c wk/auth
```

O guard responde `WENDKEEP_CONTEXT_SWITCH_REQUIRED` antes do Git, evitando que a próxima mutação
falhe por mismatch.

## Resultado esperado

O comando valida a scope inicial sob lock, troca a branch, prova que projeto, repositório, remoto,
worktree, provider e session id não mudaram, incrementa `context_revision` e anexa um evento
`from/to` em `context_transitions`. Change ativa, task lease e autorizações são preservadas.

Se qualquer validação ou persistência falhar depois do switch, o rollback restaura a branch ou
detached HEAD anterior; uma branch criada pela tentativa também é removida.

No recovery, ambas as candidatas precisam ser completas e manter a mesma identidade causal. A
selecionada deve corresponder integralmente a projeto, repositório, remoto, worktree, branch e HEAD
atuais. Sob o lock do registry, o comando revalida a revisão, incrementa `context_revision`, preserva
change/lease/autorizações, limpa somente a quarentena e anexa um receipt sanitizado em
`context_recoveries`. Qualquer falha deixa registry e quarentena byte a byte intactos.

No repair, o comando relê o alvo sob o lock, valida revision e sessão ator, prova novamente a
topologia Git e reaplica o diagnóstico. Contexto sem sessão ativa ou com worktree removida muda
para `state=closed`, mas seu registro e bindings históricos continuam presentes; uma lease vencida
isolada muda para `expired` e o contexto segue ativo. O receipt append-only em
`active_context_repairs` registra ator, motivo, diagnósticos e efeito. Só depois da escrita
autoritativa `CURRENT_CHANGE.md` e `CURRENT_DELIVERY` são reprojetados; ledger, evidence index,
notas e memória histórica não são alterados.

### Registry multi-contexto de changes

O `SESSION_REGISTRY.json` mantém `active_contexts` com schema e revisão próprios. Cada entrada é
identificada por `repository_id` + `worktree_id` + `work_session_id`; branch, HEAD e `change_slug`
pertencem a essa entrada. Assim, duas worktrees podem selecionar changes diferentes sem
sobrescrever o foco uma da outra.

Com sessão causal explícita, change, spec e verify resolvem somente a entrada correspondente. Sem
sessão, uma única entrada ativa da worktree pode ser usada; duas sessões compatíveis causam
ambiguidade e a operação falha fechada, sem escolher uma change em silêncio.

`CURRENT_CHANGE.md` é apenas uma projeção derivada: contém a change somente quando existe um único
contexto ativo inequívoco. Com zero ou múltiplos contextos, fica vazio. A migração é conservadora:
não inventa uma identidade de worktree ou sessão. O ponteiro legado só vira contexto quando uma sessão
ativa, scope completa e metadados da worktree provam uma única identidade.

## Erros comuns e diagnóstico

- `WENDKEEP_CONTEXT_AMBIGUOUS`: informe `--session <id>`; nenhuma candidata é escolhida em silêncio.
- `WENDKEEP_CONTEXT_SCOPE_MISMATCH`: a candidata escolhida não prova o checkout/HEAD atual; rode
  `context status` novamente e selecione apenas uma candidata com `matches_actual: true`.
- `WENDKEEP_CONTEXT_SCOPE_CONFLICT`: a sessão não está em quarentena ou uma candidata está ausente.
- `WENDKEEP_CONTEXT_CAS_MISMATCH`: a revisão mudou; descarte a decisão antiga e repita o status.
- `WENDKEEP_CONTEXT_IDENTITY_CHANGED`: as candidatas pertencem a identidades causais diferentes;
  preserve a quarentena e diagnostique o registry.
- `WENDKEEP_CONTEXT_CONFLICT`: outro contexto ativo ocupa o destino; use outra branch/worktree ou
  encerre corretamente o contexto concorrente.
- `WENDKEEP_CONTEXT_GIT`: corrija a branch, dirty state conflitante ou erro do Git e repita.
- `WENDKEEP_CONTEXT_ROLLBACK_FAILED`: preserve Git e registry e faça diagnóstico manual antes de
  qualquer nova mutação.
- `WENDKEEP_CONTEXT_SWITCH_REQUIRED`: troque o comando Git cru por `wendkeep context switch`.
- `WENDKEEP_ACTIVE_CONTEXT_CAS_MISMATCH`: a revision do alvo mudou; rode o `doctor` novamente.
- `WENDKEEP_ACTIVE_CONTEXT_HEALTHY`: a condição desapareceu ou o alvo nunca foi reparável; não force.
- `WENDKEEP_ACTIVE_CONTEXT_TOPOLOGY_UNPROVEN`: o Git/registry não provou as worktrees; corrija a
  topologia antes de qualquer repair.
- `WENDKEEP_ACTIVE_CONTEXT_ACTOR_MISMATCH`: a sessão ator não pertence ao projeto provado do alvo.
- `WENDKEEP_ACTIVE_CONTEXT_SESSION_ORPHAN`, `WENDKEEP_ACTIVE_CONTEXT_WORKTREE_REMOVED` e
  `WENDKEEP_ACTIVE_CONTEXT_LEASE_EXPIRED`: diagnósticos read-only emitidos pelo `doctor`.

## Próximos passos

Veja [worktrees gerenciadas](worktrees.md) para criar checkouts isolados e
[changes e verificação](changes-and-verification.md) para continuar o lifecycle na nova branch.
