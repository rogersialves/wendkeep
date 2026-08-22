# Worktrees gerenciadas

**PT-BR** · [English](../../en/commands/worktrees.md)

## Objetivo

Criar e encerrar linked worktrees isoladas que continuam vinculadas ao mesmo projeto e Vault
canônico, sem copiar estado privado para arquivos versionados nem descartar trabalho local.

## Quando usar

Use ao iniciar uma implementação isolada, listar checkouts gerenciados, diagnosticar uma operação
parcial, abrir uma worktree no VS Code ou limpá-la depois de um PR comprovadamente merged.

## Quando não usar

Não use para fazer merge do PR, descartar checkout dirty/untracked nem remover branch remota sem
autorização explícita. `finish` consome um merge já concluído; não faz self-merge.

## Pré-requisitos

- Repositório Git com o projeto já vinculado ao Vault por `.wendkeep.json`.
- Git disponível no `PATH`; `finish` também requer `gh` autenticado para consultar o GitHub.
- Para abertura, o comando `code` do VS Code deve existir.

## Sintaxe

```bash
npx --no-install wendkeep worktree create <slug> [--base <ref>] [--branch <nome>] [--open vscode|none] [--json]
npx --no-install wendkeep worktree list [--json]
npx --no-install wendkeep worktree status [<slug>] [--json]
npx --no-install wendkeep worktree open <slug> [--editor vscode] [--json]
npx --no-install wendkeep worktree finish <slug> [--pr <número|url>] [--delete-remote] [--open-main] [--json]
npx --no-install wendkeep worktree cleanup --merged [--dry-run|--apply] [--json]
npx --no-install wendkeep worktree remove <slug> --reason <texto> [--json]
npx --no-install wendkeep worktree prune [--dry-run|--apply] [--json]
```

Todas aceitam `--project <raiz>`. O padrão cria `.worktrees/<slug>` a partir da base detectada e
usa a branch `wk/<slug>`. `worktrees.root`, quando configurado, deve ser um path relativo não vazio.
Slug e branch são validados pelo Git; paths que escapam da raiz ou atravessam symlink/junction são
rejeitados antes da mutação.

## Fechamento seguro

`finish` executa `git fetch --prune` quando existe `origin`, consulta o PR por adapter GitHub e
exige estado `MERGED`, branch coerente e merge commit alcançável pela base local. O número/URL fica
associado ao registry. Antes da remoção, o preflight falha fechado diante de checkout dirty ou
untracked, sessão ativa, delivery ativa, memory outbox ou handoff pendente.

Depois da reserva sob lock, o comando remove a linked worktree, fecha somente seus active contexts,
faz prune, apaga o ref local por CAS e grava receipt JSONL append-only no Git common-dir. Isso aceita
merge commit, squash e rebase sem usar `git branch -D`. Reexecução com a mesma prova é idempotente;
se a pasta sumiu entre etapas, a reserva interrompida é retomada. `doctor` mostra cleanup
interrompido/failed e uma recuperação objetiva.

`--delete-remote` é a única autorização para excluir a branch remota. A branch deve continuar no
head comprovado; divergência ou rede indisponível bloqueia. Branch já ausente é sucesso idempotente.
`--open-main` abre a worktree principal somente depois da conclusão.

## Cleanup, remove e prune

`cleanup --merged` e `prune` são dry-run por padrão. `--dry-run` apenas torna essa intenção
explícita; somente `--apply` permite mutação. O plano é ordenado por slug e não altera Git,
registry, contexts ou receipts. `cleanup --merged` atua apenas em entries com PR associado e merge
revalidado. `remove --reason` é a saída auditável para abandono explícito: dispensa prova de merge,
mas mantém todo o preflight e preserva as branches local e remota.

## Opções e códigos de saída

O registry fica no Git common-dir, em `wendkeep/worktrees-v1.json`, sob lock multiprocesso. Ele
guarda identidade do repositório/worktree, binding canônico, PR e estado transitório de cleanup;
`.wendkeep.json` permanece inalterado. Receipts ficam em
`wendkeep/worktree-cleanup-receipts-v1.jsonl`. `.worktrees/` entra no ignore versionado e no exclude
privado. A saída JSON de `list`/`status` não expõe path nem conteúdo do Vault.

`create` é idempotente quando slug, path e branch já correspondem. Colisões falham fechadas.
Falhas depois da reserva ficam como `failed`; rode `worktree status <slug>` e siga `recovery`.
`doctor` também lista dívida de criação ou cleanup em `[worktrees]` sem repará-la.

## VS Code

`--open vscode` e `worktree open` validam `code --version` e abrem uma janela nova com `code -n`.
Use `init --vscode-worktree-tasks` ou `sync --vscode-worktree-tasks` para criar tarefas locais,
incluindo **WendKeep: Finish merged worktree**; um `.vscode/tasks.json` existente ou rastreado,
mesmo removido no checkout, nunca é sobrescrito.

Exit `0` indica sucesso. Erro de uso, binding, segurança, prova, Git ou editor retorna `2` com código
estável `WENDKEEP_WORKTREE_*`. Nenhum comando faz merge ou usa force para descartar checkout.

## Exemplos

PowerShell:

```powershell
npx --no-install wendkeep worktree create auth --open vscode
npx --no-install wendkeep worktree finish auth --pr 72 --open-main
npx --no-install wendkeep worktree cleanup --merged --dry-run --json
```

POSIX:

```bash
npx --no-install wendkeep worktree cleanup --merged --apply
npx --no-install wendkeep worktree remove spike --reason "PR cancelado"
npx --no-install wendkeep worktree prune --dry-run
```

## Resultado esperado

`create auth` produz `.worktrees/auth` na branch `wk/auth`. Depois do merge comprovado, `finish`
remove o checkout e o ref local, fecha apenas seu active context e preserva Vault, sessões,
evidências e receipt.

## Erros comuns e diagnóstico

- `WENDKEEP_WORKTREE_SLUG_INVALID`, `WENDKEEP_WORKTREE_BRANCH_INVALID` ou
  `WENDKEEP_WORKTREE_ROOT_INVALID`: corrija a entrada antes de repetir; nenhuma reserva é criada.
- `WENDKEEP_WORKTREE_PATH_OUTSIDE_ROOT` ou `WENDKEEP_WORKTREE_PATH_SYMLINK_ESCAPE`: use uma raiz
  relativa contida no main worktree, sem symlink/junction intermediário.
- `WENDKEEP_WORKTREE_COLLISION`: slug, path ou branch já representa outro estado; rode `status`.
- `WENDKEEP_WORKTREE_PR_INVALID`, `WENDKEEP_WORKTREE_PR_NOT_MERGED`,
  `WENDKEEP_WORKTREE_PR_MISMATCH` ou `WENDKEEP_WORKTREE_PR_MERGE_UNREACHABLE`: corrija/associe o PR,
  atualize a base local e repita sem remover a worktree manualmente.
- `WENDKEEP_WORKTREE_DIRTY`, `WENDKEEP_WORKTREE_ACTIVE_SESSION`,
  `WENDKEEP_WORKTREE_ACTIVE_DELIVERY`, `WENDKEEP_WORKTREE_OUTBOX_PENDING` ou
  `WENDKEEP_WORKTREE_HANDOFF_PENDING`: conclua a recuperação indicada pelo blocker.
- `WENDKEEP_WORKTREE_CLEANUP_BUSY`: outra operação ainda possui a reserva; se a pasta já sumiu,
  repita o mesmo comando/prova para retomar. Use `doctor` para reservations failed/incompletas.
- `WENDKEEP_WORKTREE_REMOTE_UNAVAILABLE` ou `WENDKEEP_WORKTREE_REMOTE_DIVERGED`: a branch local é
  preservada; recupere rede ou revise a divergência antes de autorizar novamente.
- Erros `WENDKEEP_WORKTREE_REGISTRY_*`, `WENDKEEP_WORKTREE_*_MISMATCH` ou `WENDKEEP_VAULT_*`:
  preserve os artefatos e use `doctor` para diagnosticar registry/binding.
- `WENDKEEP_WORKTREE_EDITOR_NOT_FOUND` ou `WENDKEEP_WORKTREE_EDITOR_OPEN_FAILED`: disponibilize
  `code` no PATH ou use `--open none`.

## Próximos passos

Veja [instalação e primeiro uso](getting-started.md) para tarefas locais do VS Code e
[manutenção e diagnóstico](maintenance-and-diagnostics.md) para o doctor.
