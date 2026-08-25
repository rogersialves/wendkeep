# Estado portátil

**PT-BR** · [English](../../en/commands/portable.md)

## Objetivo

Publicar em `.wendkeep/portable/state.json` a parte revisável do Vault e um snapshot compacto
`active-work`, sem transformar runtime privado em dados de Git. O comando nunca executa `git add`,
commit ou push.

## Quando usar

Use `portable export` antes de um PR que compartilhe specs/decisões ou antes de trocar de máquina;
`portable status`/`diff` para revisar drift; e `portable import` depois de criar e vincular o Vault
de um clone limpo.

## Quando não usar

Não use como sync remoto em tempo real, backup de transcritos, transporte de secrets ou substituto
de `context switch`. O import restaura uma indicação de retomada, mas não inventa session ID, active
context ou lease.

## Pré-requisitos

- Projeto Git vinculado ao Vault por `.wendkeep.json`.
- `PROJECT.json` válido; worktree registry para gerar identidade nova.
- Revisão humana do JSON antes de adicioná-lo ao Git.

## Sintaxe

```powershell
npx --no-install wendkeep portable status [--project <raiz>] [--vault <cofre>] [--input <arquivo>] [--json]
npx --no-install wendkeep portable export [--project <raiz>] [--vault <cofre>] [--output <arquivo>] [--json]
npx --no-install wendkeep portable import [--project <raiz>] [--vault <cofre>] [--input <arquivo>] [--json]
npx --no-install wendkeep portable diff [--project <raiz>] [--vault <cofre>] [--input <arquivo>] [--json]
```

## Opções e códigos de saída

- `--input`/`--output`: substituem o path padrão `.wendkeep/portable/state.json`.
- `--project`/`--vault`: selecionam o binding; `--json` emite resultado estruturado.
- Exit `0`: status/export/import válido ou diff igual. Exit `1`: diff diferente. Exit `2`: schema,
  project, integridade, path ou argumento inválido.
- `status` retorna `not_configured`, `current`, `diverged` ou `invalid`.

## Exemplos

```powershell
npx --no-install wendkeep portable export
npx --no-install wendkeep portable diff
git diff -- .wendkeep/portable/state.json
git add -- .wendkeep/portable/state.json
```

O `.gitattributes` fixa LF para `/.wendkeep/portable/*.json`. Projetos podem ignorar essa pasta e
continuar usando todo o Keep Core local.

## Resultado esperado

O inventário classifica `.brain/CORE.md`, ADRs, proposta/design/tarefas e deltas de `specs/` como
`authored`; `07-Specs`, evidência/verificação/verdict e arquivo como `derived`; registries, leases,
locks, outboxes e receipts completos como `runtime`; transcritos, prompts/respostas, tokens/custos,
secrets e environment como `secret`. Só authored e `07-Specs` entram. O export normaliza LF,
exclui symlink/hardlink e remove caminhos absolutos Windows/POSIX, tokens conhecidos e valores de
`Authorization`, `token`, `password`, `secret` e `api_key`.

Cada `active-work` contém `project_id`, `repository_id`, `change_slug`, `task_id`, branch/SHAs,
hashes, tarefas concluídas/próximas, blockers, references, timestamp e revision. Nunca contém
`work_session_id`, `worktree_id`, path local ou token. O import grava a dica privada em
`.brain/runtime/PORTABLE_ACTIVE_WORK.json`; export/import registram somente metadados e hashes em
`.brain/runtime/PORTABLE_PROVENANCE.jsonl`.

## Erros comuns e diagnóstico

- `WENDKEEP_PORTABLE_STALE`: revision recebida é inferior à local.
- `WENDKEEP_PORTABLE_CONFLICT`: mesma revision tem hash diferente.
- `WENDKEEP_PORTABLE_PATH_UNSAFE`: traversal, path fora da allowlist ou symlink.
- `WENDKEEP_PORTABLE_INTEGRITY`: conteúdo/hash foi adulterado.

Todos falham antes da primeira escrita. O `doctor` mostra `[portable] diverged` e recomenda diff/export;
`not_configured` é opt-out válido. Schemas: `schema/portable-state-v1.schema.json` e
`schema/portable-active-work-v1.schema.json`.

## Próximos passos

Revise o diff humano pequeno, adicione somente o snapshot confirmado e abra o PR. No clone destino,
execute `init`, `portable import`, consulte `portable status` e inicie uma nova sessão causal.
