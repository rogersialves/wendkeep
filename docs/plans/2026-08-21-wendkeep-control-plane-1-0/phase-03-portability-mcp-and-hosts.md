# Fase 03 — Portabilidade, MCP, sync e capabilities dos hosts

**Issues:** #77, #78, #79, #80  
**Prioridade:** P1  
**Pré-requisito:** Fases 01 e 02  
**Gate da fase:** um agente ou máquina diferente consegue retomar authored state por interfaces tipadas, e toda lacuna de captura do host é explícita.

## 1. Objetivo

Levar o WendKeep do cenário “mesmo computador e mesmo Vault” para um sistema portátil e interoperável sem transformar cloud em requisito nem expor runtime privado.

## 2. Ordem recomendada

A execução pode ocorrer parcialmente em paralelo:

```text
#77 MCP read-only ───────────────┐
                                 ├→ #80 host capability matrix
#78 authored/private → #79 sync ┘
```

Writes MCP dependem dos contracts/evidence da Fase 02.

## 3. MCP nativo

### Princípio

O MCP deve expor operações semânticas do WendKeep, não apenas leitura arbitrária do Vault.

### Read-only inicial

```text
project_status
context_status
memory_recall
memory_conflicts
change_list/show/status
spec_effective
task_show/evaluate
handoff_current
evidence_latest
observer_query
```

### Writes posteriores

```text
memory_assert
checkpoint_create
context_select
task_claim/release/complete
handoff_publish
```

Writes carregam actor, session, active context, lease e capability. Operações destrutivas permanecem fora da superfície padrão.

### Runtime

- Core tools: Node >=18;
- Observer SQL tools: capability opcional Node >=22.13;
- stdio como transporte inicial;
- schemas e error codes versionados;
- paginação, byte budgets, timeout e cancellation;
- nenhuma dependência `@latest` no caminho principal.

## 4. Authored state versus runtime privado

### Authored/shared

- CORE/invariantes compartilháveis;
- specs/deltas;
- ADRs/decisões normativas;
- contracts sanitizados;
- handoff compacto;
- active-work;
- hashes/references de evidência.

### Private/generated

- transcript/prompt/response;
- token/cost detail;
- absolute paths;
- outboxes/locks;
- traces completos;
- local leases e secrets.

A classificação deve ser formal e testável. Export default é safe-by-default.

## 5. Snapshot `active-work`

Campos mínimos:

```text
schema_version
project_id
repository_id
change_slug
task_id
branch
base_sha
head_sha
spec_sha256
tasks_sha256
status
completed
current_action
next_actions
blockers
evidence_refs
updated_at
revision
```

O snapshot não contém path absoluto, transcript, secret ou session ID privado.

### Regras de import

- comparar revision/base hash;
- conflito explícito;
- não substituir estado local mais novo;
- provenance de import/export;
- round-trip determinístico;
- opt-out de versionamento permitido.

## 6. Sync local-first

### Primitivas

```text
project_id
record_key
revision
base_revision
content_hash
causal_parent_ids
actor_id
device_id
lease_id
observed_at
operation
```

### Propriedades

- compare-and-swap;
- outbox/inbox idempotentes;
- replay fora de ordem;
- conflict sets;
- leases com TTL/recovery;
- offline-first;
- backend substituível;
- E2E para payload privado opt-in.

### Anti-requisitos

- nenhum last-write-wins automático;
- nenhum backend obrigatório;
- nenhum upload de transcript em plaintext por padrão.

## 7. Capability matrix dos hosts

Capabilities mínimas:

```text
session.start/resume/stop
prompt.submit
tool.pre/post
edit.attribution
plan.approved
decision.capture
task.completed
subagent.start/stop
transcript.read
usage.read
```

Estados:

```text
native | adapted | polled | manual | unavailable
```

### Regras

- manifest no início da sessão;
- coverage persistida em session/handoff/evidence;
- capability ausente não produz fato `verified`;
- host desconhecido usa baseline MCP/CLI;
- contract tests por versão;
- adapter Pi deve existir ou deixar de ser declarado como integração implementada.

## 8. VS Code e clientes

Depois de #70:

```powershell
node ./bin/wendkeep.mjs worktree create native-mcp --open vscode
node ./bin/wendkeep.mjs worktree create portable-active-work --open vscode
```

A integração VS Code futura deve gerar localmente:

- task para `worktree create`;
- task para `profile status`;
- task para `change status`;
- task para `verify`;
- task para `worktree finish`;
- configuração MCP nativa quando solicitada.

Preferências pessoais permanecem locais; templates/versionamento ficam no pacote.

## 9. Testes de fase

- MCP handshake/tools/calls;
- Core Node 18 e Observer 22.13;
- pagination/timeout/cancel;
- unauthorized write;
- safe export/import em clone limpo;
- secret/path fixtures;
- CAS/conflicts/reorder/duplicate;
- offline/reconnect;
- lease takeover;
- host capability ausente;
- cross-provider resume;
- package tarball consumer.

## 10. Definition of Done

- MCP é semântico, tipado e nativo;
- authored state pode viajar sem runtime privado;
- active-work permite retomada segura;
- sync converge ou explicita conflito;
- hosts declaram cobertura real;
- VS Code consegue operar o fluxo sem comandos improvisados;
- Keep Core continua local e funcional quando todas as extensões estão desligadas.
