# Contexto ativo

**PT-BR** · [English](../../en/commands/context.md)

## Objetivo

Inspecionar e mover a scope causal da mesma sessão com prova do checkout atual: durante uma troca
de branch normal ou ao recuperar explicitamente uma divergência já colocada em quarentena.

## Quando usar

Use `context switch` para criar ou selecionar outra branch na mesma worktree. Se o registry já
registrou `project_scope_conflict`, use `context status` para inventariar `reserved` e `observed`
sem paths locais; recupere somente com `context recover` e uma seleção humana explícita.

## Quando não usar

Não use para mudar de worktree, editar o registry à mão ou substituir `worktree create`. Recovery
não escolhe a candidata automaticamente e não aceita uma scope que deixou de corresponder ao HEAD.

## Pré-requisitos

- Projeto Git vinculado a um Vault por `.wendkeep.json`.
- Sessão ativa com `project_scope` completa e correspondente à worktree atual.
- Git disponível no `PATH` e branch válida segundo `git check-ref-format --branch`.

## Sintaxe

```bash
npx --no-install wendkeep context switch <branch> [--create] [--session <id>] [--project <raiz>] [--vault <cofre>] [--json]
npx --no-install wendkeep context status --session <id> [--project <raiz>] [--vault <cofre>] [--json]
npx --no-install wendkeep context recover --session <id> --select <reserved|observed> --revision <n> --reason <texto> [--project <raiz>] [--vault <cofre>] [--json]
```

Sem `--session`, exatamente uma sessão ativa deve corresponder integralmente à scope atual. Use
`--create` para executar `git switch -c`; sem a flag, a semântica é `git switch`.

## Opções e códigos de saída

- `--create`: cria a branch a partir do HEAD atual.
- `--session <id>`: seleciona explicitamente a sessão causal; recomendado quando houver dúvida.
- `--select <reserved|observed>`: escolhe exatamente uma candidata da quarentena; obrigatório no recovery.
- `--revision <n>`: CAS contra a revisão exibida por `context status`; obrigatório no recovery.
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

## Próximos passos

Veja [worktrees gerenciadas](worktrees.md) para criar checkouts isolados e
[changes e verificação](changes-and-verification.md) para continuar o lifecycle na nova branch.
