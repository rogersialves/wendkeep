# Fase 01 — Worktrees, active context e limpeza pós-merge

**Issues:** #70, #71, #72  
**Prioridade:** P0  
**Gate da fase:** duas worktrees concorrentes operam no mesmo Vault sem trocar contexto, e uma worktree merged pode ser removida com segurança.

## 1. Objetivo

Construir a fundação operacional multi-worktree do WendKeep. Esta fase precede evidence v2 porque a prova precisa conhecer primeiro qual repository/worktree/session está sendo validado.

## 2. Ordem de execução

1. #70 — worktree manager e binding compartilhado;
2. #71 — active context escopado;
3. #72 — cleanup pós-merge.

Cada issue é um PR independente.

## 3. Capability #70 — gerenciador nativo

### Comandos

```text
wendkeep worktree create <slug> [--base <ref>] [--branch <name>] [--open vscode|none]
wendkeep worktree list [--json]
wendkeep worktree status [<slug>] [--json]
wendkeep worktree open <slug> [--editor vscode]
```

### Defaults

```text
root   = .worktrees
branch = wk/<slug>
base   = default branch
```

### Decisões

- localizar common dir com Git, não por suposição de path;
- derivar worktree identity do linked git dir + repository identity;
- manter binding do Vault em metadata privada/runtime;
- não editar `.wendkeep.json` na linked worktree;
- ignorar `.worktrees/` em Git, scans e indexadores;
- usar execução de argumentos sem shell interpolation;
- abertura do VS Code é opcional e injetável em testes.

### Gate

```text
principal root ─┐
                ├─ resolve mesmo project_id + Vault
linked worktree ┘
```

## 4. Capability #71 — active context

### Chave causal

```text
project_id + repository_id + worktree_id + work_session_id
```

### Campos essenciais

```text
branch
change_slug
task_id
delivery_id
head_sha
lease_id
state
updated_at
revision
```

### Resolução

1. contexto causal da sessão;
2. único contexto ativo da worktree;
3. ambiguidade explícita;
4. nunca fallback para outra worktree.

`CURRENT_CHANGE.md` deixa de ser autoridade e permanece temporariamente como projeção legada apenas quando existe um único contexto inequívoco.

### Gate

Teste de concorrência:

```text
WT-A / Codex  → change auth
WT-B / Claude → change observer

intercalar prompt, verify, stop, resume e status
resultado: nenhum evento/gate usa a change da outra worktree
```

## 5. Capability #72 — cleanup seguro

### Comandos

```text
wendkeep worktree finish <slug> --pr <number|url>
wendkeep worktree cleanup --merged --dry-run|--apply
wendkeep worktree remove <slug> --reason <text>
wendkeep worktree prune --dry-run|--apply
```

### Preflight obrigatório

- PR `MERGED`, não somente `CLOSED`;
- worktree clean, inclusive untracked;
- nenhuma sessão ativa;
- nenhuma delivery ativa;
- nenhum outbox/handoff pendente;
- active context encerrável;
- branch/path pertencem ao registry esperado.

### Efeitos

1. receipt de cleanup;
2. close/archive do contexto operacional;
3. remove linked worktree;
4. delete branch local;
5. delete remoto somente autorizado;
6. prune Git metadata;
7. memória histórica permanece.

## 6. Segurança

- path containment e symlink/hardlink checks reaproveitam Vault path safety quando aplicável;
- slug/branch possuem grammar documentada;
- worktree path nunca pode escapar de `worktrees.root`;
- `--force` exige confirmação humana e motivo;
- falha de consulta do merge produz `unproven`;
- cleanup é idempotente e possui recovery after partial failure.

## 7. VS Code

### Antes de #70

```powershell
New-Item -ItemType Directory -Force .worktrees | Out-Null
git switch main
git pull --ff-only
git worktree add ".worktrees/<slug>" -b "wk/<slug>" main
code -n ".worktrees/<slug>"
```

### Depois de #70

```powershell
node ./bin/wendkeep.mjs worktree create <slug> --open vscode
```

### Depois do merge e #72

```powershell
node ./bin/wendkeep.mjs worktree finish <slug> --pr <PR>
```

## 8. Testes de fase

- Windows e Linux;
- paths com espaço e Unicode;
- linked worktree dentro de `.worktrees/`;
- mesma branch já checked out;
- duas criações concorrentes;
- dois active contexts;
- duas sessões na mesma worktree;
- detached HEAD;
- PR merge/squash/rebase;
- worktree dirty/untracked;
- crash antes/depois de remove;
- handles abertos no Windows;
- migration do ponteiro global.

## 9. Definition of Done

- `.worktrees/` é o padrão gerenciado;
- linked worktree usa o mesmo Vault sem branch dirty;
- context routing é inequívoco;
- hooks e CLI respeitam a worktree chamadora;
- cleanup não remove trabalho não provado;
- após merge, pasta, branch local e metadata deixam de existir;
- histórico, receipts e decisões continuam consultáveis.
