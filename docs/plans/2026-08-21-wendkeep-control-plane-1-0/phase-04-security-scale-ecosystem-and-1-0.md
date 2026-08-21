# Fase 04 — Segurança, escala, ecossistema e hardening para 1.0

**Issues:** #81, #82, #83, #84  
**Prioridade:** P2  
**Pré-requisito:** Fases 01–03  
**Gate da fase:** Observer e runtime são seguros/escopados, histórico escala incrementalmente, bridges não duplicam autoridade e releases 1.0 são migráveis/reproduzíveis.

## 1. Objetivo

Produtizar a base construída nas fases anteriores. Esta fase não introduz nova autoridade: reforça projeções, armazenamento, integrações e distribuição.

## 2. Observer seguro

### Captura por classe

```text
document_capture   = none | metadata | selected | full
transcript_capture = none | metadata | messages | full
prompt_capture     = none | redacted | full
response_capture   = none | redacted | full
usage_capture      = none | aggregate | calls
```

### Autorização

```text
roles  = viewer | auditor | publisher | admin
scopes = project + capability + data class
```

Requisitos:

- token expiry/rotation/revocation;
- optional auth em loopback;
- project isolation;
- transcript/prompt scopes separados;
- audit log de acesso sensível;
- ingest/mutation sempre autenticados.

### Retenção e proteção

- TTL por classe;
- purge idempotente com receipt;
- índices derivados também removidos;
- encryption at rest quando habilitada;
- export seguro por padrão;
- migrations de DB testadas.

## 3. Ledger e recall incrementais

### Memory ledger

- segmentos imutáveis;
- manifest/hash chain;
- snapshots de projeção;
- replay do tail;
- compactação com dry-run/receipt;
- repair a partir do ledger original.

### Evidence recall

- estado por `logical_path + content_hash`;
- chunk upsert/delete incremental;
- FTS local quando disponível;
- fallback lexical sobre corpus completo;
- embeddings opcionais/locais;
- paginação e byte budgets.

### Métricas

- tempo de startup;
- tempo de recall;
- bytes lidos/escritos;
- eventos replayed;
- chunks atualizados;
- tamanho de outbox/segments;
- custo de full reconcile.

## 4. Bridges do ecossistema

### Matriz de autoridade

```text
Spec Kit    → autoria opcional de specs complexas
WendKeep    → memory/context/contracts/evidence/governance
Superpowers → execução/TDD/review
CI          → prova final do commit
```

### Spec Kit adapter

- detectar versão/artefatos;
- preservar IDs/hashes;
- importar/reference, não duplicar;
- detectar drift;
- mapping user story/requirement/change/task;
- status/evidence como projeção opcional.

### Superpowers adapter

- dispatch package mínimo;
- task contract e spec refs;
- worktree via WendKeep;
- ingest de ledger/review/commits como artifacts;
- nenhuma reescrita silenciosa de escopo;
- cleanup seguro pós-merge.

Cada adapter é opcional e possui compatibility matrix.

## 5. Arquitetura para 1.0

Packages-alvo:

```text
@wendkeep/vault
@wendkeep/harness
@wendkeep/worktrees
@wendkeep/observer
@wendkeep/sync
@wendkeep/integrations
@wendkeep/mcp
```

Regras:

- adapters irmãos não dependem entre si;
- hooks contêm somente adaptação/orchestration;
- effectful code nos composition roots;
- Core Node >=18;
- Observer SQL Node >=22.13;
- schemas/migrations públicos;
- legacy facades com deprecation timeline;
- APIs 1.0 versionadas.

## 6. Migrations

Cobertura mínima:

- Vault structure;
- memory v2/segments/snapshots;
- active contexts;
- evidence v1→v2;
- task/handoff contracts;
- portable state;
- Observer DB;
- MCP configs/host manifests.

Cada migration precisa de:

- preflight;
- dry-run quando possível;
- staging/atomic publication;
- rollback ou repair;
- idempotência;
- tests N-2/N-1 → atual;
- receipt.

## 7. CI e supply chain

- Windows/Linux e macOS onde relevante;
- Core 18/20; Full 22.13/24;
- checks obrigatórios antes de merge/release;
- Actions pinadas por SHA;
- permissões mínimas por job;
- dependency review/CodeQL quando aplicável;
- SBOM/provenance do tarball;
- package smoke em consumidor isolado;
- migration tests;
- coverage thresholds por package;
- mutation nos kernels críticos;
- tag/npm/Release no mesmo SHA e versão.

## 8. VS Code

```powershell
node ./bin/wendkeep.mjs worktree create observer-security --open vscode
node ./bin/wendkeep.mjs worktree create incremental-memory-recall --open vscode
node ./bin/wendkeep.mjs worktree create ecosystem-bridges --open vscode
node ./bin/wendkeep.mjs worktree create architecture-1-0 --open vscode
```

Cada implementação permanece separada. #84 não deve virar um rewrite que absorve #81–#83.

## 9. Testes de fase

- role/scope matrix;
- retention/purge/encryption;
- multi-project isolation;
- 100k+ memory events;
- corrupted snapshot/segment/index;
- incremental document change;
- FTS unavailable;
- Spec Kit drift;
- Superpowers dispatch/review;
- dependency graph;
- migrations N-2/N-1;
- tarball consumer;
- release provenance;
- workflow permission assertions.

## 10. Definition of Done

- Observer pode ser usado remotamente com política explícita;
- dados sensíveis têm captura/retention/access control;
- histórico longo não degrada hooks linearmente;
- bridges preservam autoridade única;
- packages possuem fronteiras testadas;
- upgrades preservam memória/evidence;
- tarball publicado corresponde ao SHA testado;
- release 1.0 possui compatibility/deprecation/support policy.
