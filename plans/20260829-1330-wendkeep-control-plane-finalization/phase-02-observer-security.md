# Fase 02 — #81: segurança e ciclo de vida do Observer

## Visão geral

- **Branch:** `wk/observer-security`
- **Prioridade:** alta; superfície sensível
- **Estado:** implementação concluída na branch; validação final pré-merge pendente

Adicionar policy, AuthZ, retenção, purge, auditoria e criptografia sem quebrar isolamento por projeto.

## Requisitos

- Threat model e classificação oficial.
- Captura e redaction por classe/path/entidade/projeto.
- Tokens hashados com roles, scopes, expiração, rotação e revogação.
- Leituras sensíveis autenticadas, inclusive loopback.
- Retention/purge idempotente com receipt.
- Encryption-at-rest com chave externa e falha fechada quando obrigatória.
- Audit log sem payload sensível.
- Migration segura e integração com publisher, MCP, sync e dashboard.

## Arquitetura

```text
publisher/API/MCP/sync
        ↓
 policy → redaction → authorization
        ↓              ↓
 encrypted store    access audit
        ↓
 retention/purge → deletion receipt
```

O package Observer recebe interfaces explícitas para clock, key provider e receipt sink; testes não
dependem de segredos ou tempo real.

## Arquivos

### Criar

- `C:/GitHub/WendKeep/packages/observer/package.json`.
- `C:/GitHub/WendKeep/packages/observer/src/policy.mjs`.
- `C:/GitHub/WendKeep/packages/observer/src/redaction.mjs`.
- `C:/GitHub/WendKeep/packages/observer/src/authz.mjs`.
- `C:/GitHub/WendKeep/packages/observer/src/token-registry.mjs`.
- `C:/GitHub/WendKeep/packages/observer/src/encryption.mjs`.
- `C:/GitHub/WendKeep/packages/observer/src/retention.mjs`.
- `C:/GitHub/WendKeep/packages/observer/src/purge.mjs`.
- `C:/GitHub/WendKeep/packages/observer/src/audit.mjs`.
- `C:/GitHub/WendKeep/packages/observer/src/index.mjs`.
- `C:/GitHub/WendKeep/schema/observer/004-security.sql` — tokens, audit e receipts.
- `C:/GitHub/WendKeep/schema/observer-policy-v1.schema.json`.
- `C:/GitHub/WendKeep/tests/observer-policy.test.mjs`.
- `C:/GitHub/WendKeep/tests/observer-authz.test.mjs`.
- `C:/GitHub/WendKeep/tests/observer-retention-purge.test.mjs`.
- `C:/GitHub/WendKeep/tests/observer-encryption.test.mjs`.
- `C:/GitHub/WendKeep/tests/observer-security-migration.test.mjs`.
- `C:/GitHub/WendKeep/docs/pt-BR/commands/observer-security.md`.
- `C:/GitHub/WendKeep/docs/en/commands/observer-security.md`.

### Modificar

- `C:/GitHub/WendKeep/src/observer-auth.mjs` e `observer-privacy.mjs` — fachadas compatíveis.
- `C:/GitHub/WendKeep/src/observer-server.mjs` — middleware endpoint × capability.
- `C:/GitHub/WendKeep/src/observer-sql-publish.mjs` — policy/redaction/encryption.
- `C:/GitHub/WendKeep/src/observer-sql-store.mjs` — store e purge transacional.
- `C:/GitHub/WendKeep/src/observer-sql-migrate.mjs` — migration 004.
- `C:/GitHub/WendKeep/src/observer-transcript-store.mjs` — conteúdo cifrado.
- `C:/GitHub/WendKeep/hooks/observer-publish.mjs` — policy explícita/fail-open controlado.
- `C:/GitHub/WendKeep/packages/mcp/src/executor.mjs` — scopes Observer.
- `C:/GitHub/WendKeep/src/sync-protocol.mjs` — metadata de policy sem duplicar autoridade.
- `C:/GitHub/WendKeep/web/observer/app.mjs` — administração e redaction visual.
- Docs e READMEs PT-BR/EN correspondentes.

## Passos

1. Fixar threat model, data classes e supersession do contrato local-open.
2. Implementar policy/redaction puras com corpus adversarial.
3. Implementar token registry e AuthZ project-scoped.
4. Aplicar middleware a cada endpoint e bloquear leituras sensíveis sem scope.
5. Implementar adapter AES-256-GCM e key provider externo.
6. Implementar TTL runner e purge transacional com receipt/audit.
7. Criar migration idempotente, backup e rollback seguro.
8. Integrar publisher, MCP, sync e dashboard.
9. Atualizar documentação bilíngue e preparar candidato.

## Testes focados

- Novos cinco arquivos de segurança.
- `observer-project-isolation`, `observer-sql-api`, `observer-sql-publish`, `observer-server`.
- Fixtures de token expirado/revogado, scope cruzado, chave errada e purge interrompido.
- Teste preexistente de lote gzip >64 MB deve estar verde no candidato, sem atribuir regressão falsa à #81.

## Critérios de sucesso

- Nenhum token acessa projeto/scope alheio.
- Conteúdo sensível não aparece em store, export ou audit quando policy proíbe.
- Purge repetido é seguro e possui receipt verificável.
- Dados protegidos não são legíveis sem a chave correta.
- Upgrade de DB existente preserva dados permitidos e falha recuperavelmente.

## Fechamento da entrega intermediária

- [x] 10.1 Integrar a segurança e o ciclo de vida do Observer no candidato `0.88.0`, com package, lockfile, changelog, inventário modular, paridade de importação e contrato tipado/bilíngue de identidade/hash/exclusão/timestamp alinhados. [sensor:observer-security] [sensor:observer-sql-incremental] [sensor:observer-sql-store] [sensor:observer-memory-import] [sensor:modular-workspaces] [sensor:docs-bilingual]

## Riscos e mitigação

- **Lockout local:** comando de recuperação offline, explícito e auditado.
- **Perda por purge:** dry-run, transação, receipt e política mínima documentada.
- **Chave indisponível:** falha fechada apenas quando policy exige; diagnóstico sem segredo.
- **Drift UI/API:** contract tests da matriz endpoint × capability.
