# Fase 05 — #84-B: migration harness

## Visão geral

- **Branch:** `wk/migration-harness-0x`
- **Dependência:** packages da fase 04
- **Estado:** implementada na issue #84; fechamento registrado em `issue-84-execution.md`

Unificar migrations de Vault, ledger, contexts, Observer e portable state com recuperação explícita.

## Arquitetura

```text
registry → plan → journal → apply step(s) → verify → receipt
                    ↘ crash ↙
                 resume/repair/rollback
```

Cada migration declara origem, destino, preconditions, passos idempotentes, verificação e estratégia
de rollback/repair.

## Arquivos

### Criar

- `C:/GitHub/WendKeep/packages/migrations/package.json`.
- `C:/GitHub/WendKeep/packages/migrations/src/registry.mjs`.
- `C:/GitHub/WendKeep/packages/migrations/src/runner.mjs`.
- `C:/GitHub/WendKeep/packages/migrations/src/journal.mjs`.
- `C:/GitHub/WendKeep/packages/migrations/src/receipt.mjs`.
- `C:/GitHub/WendKeep/packages/migrations/src/index.mjs`.
- `C:/GitHub/WendKeep/schema/migration-receipt-v1.schema.json`.
- `C:/GitHub/WendKeep/tests/migration-harness.test.mjs`.
- `C:/GitHub/WendKeep/tests/migration-sequential-upgrade.test.mjs`.
- `C:/GitHub/WendKeep/tests/migration-crash-repair.test.mjs`.
- `C:/GitHub/WendKeep/tests/fixtures/migrations/n-2/` e `n-1/` sanitizados.
- Guias PT-BR/EN de upgrade, rollback e repair.

### Modificar

- `C:/GitHub/WendKeep/hooks/active-context-store.mjs` — adapter de migration.
- `C:/GitHub/WendKeep/src/observer-sql-migrate.mjs` — registry comum.
- `C:/GitHub/WendKeep/src/portable.mjs` — upgrade antes de rejeitar schema suportado.
- Stores de memória/ledger — registrations sem I/O duplicado.
- CLI, doctor, package exports, READMEs e docs bilíngues.

## Passos

1. Definir contrato e receipt de migration.
2. Implementar plan dry-run e validação de preconditions.
3. Implementar journal atômico e runner idempotente.
4. Adaptar active context, Observer e portable state.
5. Adaptar Vault/ledger sem alterar autoridade histórica.
6. Criar fixtures N-2/N-1 e upgrades sequenciais.
7. Injetar crash antes/depois de cada passo e provar resume/repair.
8. Documentar rollback quando possível e repair quando rollback não for seguro.

## Testes focados

- Três novos arquivos de harness.
- Suites existentes de active context, Observer migrate, portable e memory migration.
- Mutantes: passo repetido, journal truncado, checksum divergente, versão futura, crash pós-write.

## Critérios de sucesso

- N-2 e N-1 chegam ao schema atual sem perda de autoridade.
- Crash em qualquer passo não produz estado silenciosamente parcial.
- Resume e repair são idempotentes.
- Versão futura falha fechada e preserva os dados.
- Receipt identifica origem, destino, passos, hashes e resultado.

## Riscos e mitigação

- **Fixture irreal:** snapshots sanitizados derivados de formatos publicados reais.
- **Rollback destrutivo:** backup verificado e repair preferido quando não reversível.
- **Concorrência:** lock por recurso e comparação de generation/revision.
