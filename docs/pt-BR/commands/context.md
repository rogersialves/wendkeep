# Contexto ativo

**PT-BR** · [English](../../en/commands/context.md)

## Objetivo

Trocar a branch Git e a scope causal da mesma sessão juntas, dentro da worktree atual, sem abrir
uma nova sessão e sem relaxar o guard.

## Quando usar

Use `context switch` quando uma sessão ativa precisa criar ou selecionar outra branch na mesma
worktree e deve continuar mutando o repositório depois da troca.

## Quando não usar

Não use para mudar de worktree, adotar uma scope já divergente, reparar o registry ou substituir
`worktree create`. Esses casos exigem outro contexto físico ou diagnóstico explícito.

## Pré-requisitos

- Projeto Git vinculado a um Vault por `.wendkeep.json`.
- Sessão ativa com `project_scope` completa e correspondente à worktree atual.
- Git disponível no `PATH` e branch válida segundo `git check-ref-format --branch`.

## Sintaxe

```bash
npx --no-install wendkeep context switch <branch> [--create] [--session <id>] [--project <raiz>] [--vault <cofre>] [--json]
```

Sem `--session`, exatamente uma sessão ativa deve corresponder integralmente à scope atual. Use
`--create` para executar `git switch -c`; sem a flag, a semântica é `git switch`.

## Opções e códigos de saída

- `--create`: cria a branch a partir do HEAD atual.
- `--session <id>`: seleciona explicitamente a sessão causal; recomendado quando houver dúvida.
- `--project <raiz>` e `--vault <cofre>`: selecionam binding e paths para uso manual.
- `--json`: emite status, session id, branch, HEAD, revisão e evento sem expor o Vault.

Exit `0` significa transição concluída ou destino já ativo. Uso inválido, ambiguidade,
scope divergente, conflito, falha Git ou rollback retorna `2` com um código `WENDKEEP_CONTEXT_*`.

## Exemplos

```bash
npx --no-install wendkeep context switch wk/auth --create
npx --no-install wendkeep context switch main --session 019abc-session-id
npx --no-install wendkeep context switch wk/auth --session 019abc-session-id --json
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

## Erros comuns e diagnóstico

- `WENDKEEP_CONTEXT_AMBIGUOUS`: informe `--session <id>`; nenhuma candidata é escolhida em silêncio.
- `WENDKEEP_CONTEXT_SCOPE_MISMATCH` ou `WENDKEEP_CONTEXT_SCOPE_CONFLICT`: volte ao checkout
  reservado ou diagnostique a sessão; o comando não adota uma divergência posterior.
- `WENDKEEP_CONTEXT_CONFLICT`: outro contexto ativo ocupa o destino; use outra branch/worktree ou
  encerre corretamente o contexto concorrente.
- `WENDKEEP_CONTEXT_GIT`: corrija a branch, dirty state conflitante ou erro do Git e repita.
- `WENDKEEP_CONTEXT_ROLLBACK_FAILED`: preserve Git e registry e faça diagnóstico manual antes de
  qualquer nova mutação.
- `WENDKEEP_CONTEXT_SWITCH_REQUIRED`: troque o comando Git cru por `wendkeep context switch`.

## Próximos passos

Veja [worktrees gerenciadas](worktrees.md) para criar checkouts isolados e
[changes e verificação](changes-and-verification.md) para continuar o lifecycle na nova branch.
