# Fase 02 — Evidence Envelope, contracts, TDD e commit provenance

**Issues:** #73, #74, #75, #76, #40  
**Prioridade:** P0/P1  
**Pré-requisito:** Fase 01  
**Gate da fase:** archive, commit e delivery só usam prova ligada ao código exato; task/handoff são avaliáveis por máquina.

## 1. Objetivo

Eliminar a diferença entre “foi registrado que passou” e “há prova de que este estado exato do código passou”. Em seguida, transformar tasks e handoffs em contratos derivados da autoria, sem duplicar specs.

## 2. Ordem de execução

1. #73 — Evidence Envelope v2;
2. #74 — freshness/provenance gates;
3. #75 — task/handoff contracts;
4. #76 — TDD attestation;
5. #40 — commit universal baseado em provas válidas.

## 3. Evidence Envelope v2

### Identidade mínima

```text
project_id
repository_id
worktree_id
work_session_id
change_slug
branch
```

### Snapshot validado

```text
base_sha
head_sha
index_tree_sha
worktree_digest
dirty
tasks_sha256
effective_spec_sha256
sensor_config_sha256
wendkeep_version
platform
started_at
finished_at
```

### Regras

- HEAD inicial e final devem ser iguais;
- digest deve incluir staged/unstaged/untracked conforme política documentada;
- hashes usam SHA-256 canônico;
- evidence v1 vira `legacy-unbound`;
- writes são atômicos e protegidos por path-safety;
- sensor registra comando efetivo, exit code, duration, output digest e tail sanitizado.

## 4. Freshness/provenance gate

Estados de prova:

```text
verified
reported
legacy-unbound
stale
conflict
unproven
```

### Comparações locais

- repository/worktree;
- HEAD/index/worktree digest;
- tasks/spec/sensor config;
- verdict envelope ID;
- active context.

### Comparações externas opcionais

- CI run → SHA;
- tag → SHA;
- package version;
- npm integrity;
- GitHub Release/tag/body.

Falha de rede não promove `reported` a `verified`.

## 5. Task Contract

Derivado de:

- task ID/texto;
- requirement IDs;
- acceptance criteria;
- sensors;
- artifacts;
- dependencies;
- active context.

Campos essenciais:

```text
status
inputs
expected_outputs
acceptance_criteria
required_sensors
required_artifacts
dependencies
owner/lease
evidence_envelope_id
```

Uma checkbox `[x]` é apenas sinal autoral; conclusão depende da avaliação do contrato.

## 6. Artifact gates

Tipos mínimos:

```text
name
path
glob
file-count
```

Regras:

- filesystem scan bounded;
- ignore Git/node_modules/dist/worktrees;
- timeout;
- paths repo-relative;
- artifact registrado é preferível;
- `fromFilesystem` é explícito, nunca implícito para conteúdo sensível.

## 7. Handoff Contract

Transporta:

- origem/destino;
- active context/task;
- artifacts;
- evidence refs;
- decisions;
- next actions;
- blockers/risks;
- HEAD/tasks/spec hashes;
- host capability coverage.

Heurísticas de resumo servem somente para legacy migration com autoridade `reported`.

## 8. TDD attestation

Ciclo registrado:

```text
requirement/task
  ├─ RED: snapshot + command + expected failure digest
  └─ GREEN: successor snapshot + command + green digest
```

Política:

- FLOW: opcional;
- GUIDE: recomendado;
- GOVERN: obrigatório quando task declara TDD;
- ASSURE: obrigatório para comportamento testável ou waiver humano.

RED por import/typo/configuração não satisfaz a prova.

## 9. Commit universal

`wk-commit` consome apenas:

- change/ADR;
- task contracts concluídos;
- Evidence Envelope fresco;
- verdict correspondente;
- staged diff;
- identidade real dos agentes.

Pipeline:

```text
wk-commit gera
→ prepare-commit-msg estrutura
→ commit-msg valida
→ CI valida bypass
```

Nenhum receipt stale/unproven pode aparecer como evidência no corpo.

## 10. Fluxo VS Code

```powershell
node ./bin/wendkeep.mjs worktree create evidence-envelope-v2 --open vscode
```

Depois de cada PR:

```powershell
node ./bin/wendkeep.mjs worktree finish <slug> --pr <PR>
```

## 11. Testes de fase

- source alterado depois do verify;
- amend/rebase;
- staged/unstaged/untracked;
- evidence de outra worktree;
- sensor config alterada;
- artifact ausente;
- task marcada sem gate;
- handoff stale;
- RED já verde;
- RED por erro de infraestrutura;
- tag/npm/release divergentes;
- receipts truncados;
- bypass de commit hook.

## 12. Definition of Done

- qualquer prova identifica o estado exato testado;
- archive recusa mudança pós-verify;
- task e handoff são machine-checkable;
- E→V respeita gates;
- TDD pode ser auditado quando exigido;
- commit e delivery não inventam resultados;
- tudo permanece local-first e reparável.
