# Execução do programa no VS Code

Este guia permite executar as issues #70–#84 em worktrees isoladas. Até #70/#72 existirem, use os comandos manuais seguros abaixo. Depois, substitua-os pelos comandos nativos do WendKeep.

## 1. Pré-requisitos

Na worktree principal:

```powershell
git switch main
git pull --ff-only
node --version
npm ci --ignore-scripts
node ./bin/wendkeep.mjs doctor --project .
```

Confirme também:

```powershell
gh auth status
code --version
git worktree list
```

## 2. Slugs recomendados

| Issue | Slug/worktree | Branch |
|---|---|---|
| #70 | `worktree-manager` | `wk/worktree-manager` |
| #71 | `active-context` | `wk/active-context` |
| #72 | `worktree-cleanup` | `wk/worktree-cleanup` |
| #73 | `evidence-envelope-v2` | `wk/evidence-envelope-v2` |
| #74 | `provenance-gates` | `wk/provenance-gates` |
| #75 | `typed-contracts` | `wk/typed-contracts` |
| #76 | `tdd-attestation` | `wk/tdd-attestation` |
| #40 | `universal-commit` | `wk/universal-commit` |
| #77 | `native-mcp` | `wk/native-mcp` |
| #78 | `portable-active-work` | `wk/portable-active-work` |
| #79 | `sync-protocol` | `wk/sync-protocol` |
| #80 | `host-capability-matrix` | `wk/host-capability-matrix` |
| #81 | `observer-security` | `wk/observer-security` |
| #82 | `incremental-memory-recall` | `wk/incremental-memory-recall` |
| #83 | `ecosystem-bridges` | `wk/ecosystem-bridges` |
| #84 | `architecture-1-0` | `wk/architecture-1-0` |

Não comece uma issue antes das dependências declaradas em seu corpo.

## 3. Criar uma worktree agora

Exemplo para #70:

```powershell
$Slug = "worktree-manager"
$Branch = "wk/$Slug"

New-Item -ItemType Directory -Force .worktrees | Out-Null
git switch main
git pull --ff-only
git worktree add ".worktrees/$Slug" -b $Branch main
code -n ".worktrees/$Slug"
```

No terminal da nova janela:

```powershell
git status --short --branch
npm ci --ignore-scripts
node ./bin/wendkeep.mjs sync --project . --yes
node ./bin/wendkeep.mjs profile status --project .
```

Para o próprio checkout do WendKeep, continue usando `node ./bin/wendkeep.mjs`; não reinstale `wendkeep` como devDependency.

## 4. Criar uma worktree depois de #70

```powershell
node ./bin/wendkeep.mjs worktree create <slug> --open vscode
```

Exemplo:

```powershell
node ./bin/wendkeep.mjs worktree create active-context --open vscode
```

## 5. Prompt-base para o agente no VS Code

Cole o texto abaixo no Codex/Claude da janela da worktree, substituindo a issue:

```text
Implemente integralmente a issue #NN do repositório rogersialves/wendkeep.

Use o AGENTS.md do repositório como regra obrigatória. Trabalhe somente nesta worktree e nesta branch. Leia a issue, o épico #69 e os documentos em docs/plans/2026-08-21-wendkeep-control-plane-1-0/.

Antes de editar:
1. execute o routing gate do WendKeep;
2. classifique work kind, contract impact e operation risk separadamente;
3. crie/use a change adequada;
4. transforme os critérios da issue em requisitos e tarefas TDD pequenas.

Durante a implementação:
- preserve as fronteiras de packages;
- não altere o Vault ou runtime de outra worktree;
- escreva testes Red → Green por comportamento;
- mantenha documentação PT-BR/EN alinhada quando houver comportamento observável;
- não faça merge, publish ou cleanup destrutivo.

Antes de concluir:
- execute os sensores relevantes;
- execute verify e verify --deep;
- faça revisão independente;
- archive a change somente com gates válidos;
- prepare CHANGELOG/versionamento se a issue alterar o pacote;
- faça push da branch e abra um PR com resumo, testes, riscos e referência à issue.

Pare somente diante de operação destrutiva/externa, risco de segurança ou ambiguidade que torne todas as alternativas um palpite.
```

## 6. Checklist de cada PR

```text
[ ] dependências da issue estão merged
[ ] branch/worktree corretas
[ ] routing gate registrado
[ ] change/spec/tasks coerentes
[ ] testes Red → Green
[ ] sensores verdes
[ ] verify/deep verdict
[ ] docs PT/EN quando aplicável
[ ] CHANGELOG/version quando aplicável
[ ] nenhum runtime/Vault privado no diff
[ ] PR aberto; sem self-merge
```

## 7. Limpeza manual segura depois do merge

Até #72 existir, use este processo. Ele trata squash/rebase corretamente porque consulta o estado real do PR antes de forçar a remoção da branch local.

### PowerShell

```powershell
$Slug = "worktree-manager"
$Branch = "wk/$Slug"
$Pr = 123
$Path = ".worktrees/$Slug"

$info = gh pr view $Pr --json state,mergedAt,headRefName,baseRefName | ConvertFrom-Json
if ($info.state -ne "MERGED" -or -not $info.mergedAt) {
  throw "PR #$Pr não está comprovadamente merged."
}
if ($info.headRefName -ne $Branch) {
  throw "PR #$Pr pertence a $($info.headRefName), não a $Branch."
}

$dirty = git -C $Path status --porcelain
if ($dirty) {
  throw "Worktree possui mudanças locais; cleanup bloqueado.`n$dirty"
}

git worktree remove $Path

# Em squash/rebase, -d pode recusar porque a branch tip não é ancestral de main.
# Como o PR foi comprovado MERGED acima, a exclusão local pode ser forçada conscientemente.
git branch -D $Branch

git fetch --prune
git worktree prune
git worktree list
```

A branch remota só deve ser removida quando você desejar e houver autorização de delivery:

```powershell
git push origin --delete $Branch
```

### POSIX

```bash
slug="worktree-manager"
branch="wk/$slug"
pr="123"
path=".worktrees/$slug"

state="$(gh pr view "$pr" --json state --jq .state)"
merged_at="$(gh pr view "$pr" --json mergedAt --jq .mergedAt)"
head="$(gh pr view "$pr" --json headRefName --jq .headRefName)"

[ "$state" = "MERGED" ] && [ -n "$merged_at" ] || {
  echo "PR #$pr não está comprovadamente merged" >&2
  exit 1
}
[ "$head" = "$branch" ] || {
  echo "PR pertence a $head, não a $branch" >&2
  exit 1
}
[ -z "$(git -C "$path" status --porcelain)" ] || {
  echo "worktree dirty; cleanup bloqueado" >&2
  exit 1
}

git worktree remove "$path"
git branch -D "$branch"
git fetch --prune
git worktree prune
git worktree list
```

## 8. Limpeza depois de #72

```powershell
node ./bin/wendkeep.mjs worktree finish <slug> --pr <numero-ou-url>
```

Para varrer resíduos comprovadamente merged:

```powershell
node ./bin/wendkeep.mjs worktree cleanup --merged --dry-run
node ./bin/wendkeep.mjs worktree cleanup --merged --apply
```

## 9. Duas issues em paralelo

Somente quando as dependências permitirem:

```powershell
node ./bin/wendkeep.mjs worktree create native-mcp --open vscode
node ./bin/wendkeep.mjs worktree create portable-active-work --open vscode
```

Cada janela possui branch, active context, task e evidence próprios. Não use uma worktree para duas issues independentes.

## 10. Recuperação de resíduos

Inspecione antes de remover:

```powershell
git worktree list --porcelain
git branch --list "wk/*"
git status --short
```

Depois de confirmar que uma pasta não contém trabalho:

```powershell
git worktree prune --dry-run
git worktree prune
```

Nunca apague manualmente `.git/worktrees/*` como primeira ação. Use o comando Git/WendKeep e preserve receipts/contexto histórico.
