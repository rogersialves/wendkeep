# Worktrees gerenciadas

**PT-BR** · [English](../../en/commands/worktrees.md)

## Objetivo

Criar linked worktrees isoladas que continuam vinculadas ao mesmo projeto e Vault canônico,
sem copiar estado privado para arquivos versionados.

## Quando usar

Use ao iniciar uma implementação isolada, listar checkouts gerenciados, diagnosticar uma criação
parcial ou abrir uma worktree já pronta no VS Code.

## Quando não usar

Não use para remover, mesclar ou fazer self-merge de worktrees. Essas operações permanecem fora
desta capability.

## Pré-requisitos

- Repositório Git com o projeto já vinculado ao Vault por `.wendkeep.json`.
- Git disponível no `PATH`; para abertura, o comando `code` do VS Code também deve existir.

## Sintaxe

```bash
npx --no-install wendkeep worktree create <slug> [--base <ref>] [--branch <nome>] [--open vscode|none] [--json]
npx --no-install wendkeep worktree list [--json]
npx --no-install wendkeep worktree status [<slug>] [--json]
npx --no-install wendkeep worktree open <slug> [--editor vscode] [--json]
```

Todas aceitam `--project <raiz>`. O padrão cria `.worktrees/<slug>` a partir da base detectada e
usa a branch `wk/<slug>`. `worktrees.root`, quando configurado, deve ser um
path relativo não vazio. Slug e branch são validados pelo Git; paths que escapam da raiz ou
atravessam symlink/junction são rejeitados antes da mutação.

## Opções e códigos de saída

O registry fica no Git common-dir, em `wendkeep/worktrees-v1.json`, sob lock multiprocesso. Ele
guarda identidade do repositório/worktree e o binding canônico; `.wendkeep.json` permanece
inalterado. `.worktrees/` entra no ignore versionado e no exclude privado do repositório. A saída
JSON de `list`/`status` não expõe path nem conteúdo do Vault. A saída humana apresenta, por
worktree, slug, identidade, path do checkout, branch, HEAD, estado e saúde do binding.

`create` é idempotente quando slug, path e branch já correspondem. Colisões falham fechadas.
Falhas depois da reserva ficam como `failed`; rode `worktree status <slug>` e siga o campo
`recovery`. `doctor` também lista dívida em `[worktrees]` sem repará-la.

## VS Code e códigos de saída

`--open vscode` e `worktree open` validam `code --version` e abrem uma janela nova com `code -n`.
Use `init --vscode-worktree-tasks` ou `sync --vscode-worktree-tasks` para criar tarefas locais;
um `.vscode/tasks.json` existente ou rastreado, mesmo removido no checkout, nunca é sobrescrito.

Exit `0` indica sucesso. Erro de uso, binding, segurança, Git ou editor retorna `2` com código
estável `WENDKEEP_WORKTREE_*`. O comando nunca remove ou mescla uma worktree.

## Exemplos

```bash
npx --no-install wendkeep worktree create auth --open vscode
npx --no-install wendkeep worktree status auth --json
npx --no-install wendkeep worktree list
```

## Resultado esperado

`create auth` produz `.worktrees/auth` na branch `wk/auth`; main e linked worktree resolvem o
mesmo `projectId` e Vault, e o checkout principal permanece limpo.

## Erros comuns e diagnóstico

- `WENDKEEP_WORKTREE_SLUG_INVALID`, `WENDKEEP_WORKTREE_BRANCH_INVALID` ou
  `WENDKEEP_WORKTREE_ROOT_INVALID`: corrija a entrada antes de repetir; nenhuma reserva é criada.
- `WENDKEEP_WORKTREE_PATH_OUTSIDE_ROOT` ou `WENDKEEP_WORKTREE_PATH_SYMLINK_ESCAPE`: use uma raiz
  relativa contida no main worktree, sem symlink/junction intermediário.
- `WENDKEEP_WORKTREE_COLLISION`: slug, path ou branch já representa outro estado; rode `status`.
- `WENDKEEP_WORKTREE_GIT_FAILED` ou `WENDKEEP_WORKTREE_BASE_UNRESOLVED`: corrija o estado Git e
  repita o comando indicado em `recovery`.
- Erros `WENDKEEP_WORKTREE_REGISTRY_*`, `WENDKEEP_WORKTREE_*_MISMATCH` ou
  `WENDKEEP_VAULT_*`: preserve os artefatos e use `doctor` para diagnosticar registry/binding.
- `WENDKEEP_WORKTREE_EDITOR_NOT_FOUND` ou `WENDKEEP_WORKTREE_EDITOR_OPEN_FAILED`: disponibilize
  `code` no PATH ou use `--open none`.
- Estado `failed`/`missing`: leia `recovery` em `status --json` e o bloco `[worktrees]` do `doctor`.

## Próximos passos

Veja [instalação e primeiro uso](getting-started.md) para tarefas locais do VS Code e
[manutenção e diagnóstico](maintenance-and-diagnostics.md) para o doctor.
