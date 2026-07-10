# Fase 1 — runtime e captura de plano

## Status

Concluída em 2026-07-09. Prioridade P0.

## Arquivos

- Modificar `C:\GitHub\WendKeep\hooks\plan-capture.mjs`: payload estruturado, backlink da sessão, snapshots por hash, observabilidade.
- Modificar `C:\GitHub\WendKeep\src\taxonomy.mjs`: comando ancorado no projeto.
- Modificar `C:\GitHub\WendKeep\src\init.mjs`: migração/deduplicação de comandos legados.
- Modificar `C:\GitHub\WendKeep\tests\plan-capture.test.mjs`.
- Modificar `C:\GitHub\WendKeep\tests\init-merge.test.mjs`.

## Implementação

1. Adicionar teste RED com `tool_response: {plan,filePath,isAgent,planWasEdited}`.
2. Fazer `extractPlan` priorizar `tool_response.plan`; manter rejeição e formatos legados.
3. Adicionar E2E do entrypoint via stdin, validando stdout e arquivos criados.
4. Resolver `sessionRel` por transcript/registry antes de `newChange`.
5. Persistir `planos/<sha256-12>.md`; manter `plano-aprovado.md` como índice idempotente.
6. Gerar comando Claude com `${CLAUDE_PROJECT_DIR}` e `args` seguros.
7. Migrar comandos relativos existentes sem duplicar grupos.
8. Testar execução simulada na raiz e em diretórios aninhados.

## Aceite

- Fixture real cria/anexa a mudança correta.
- Repetir o mesmo plano não duplica snapshot.
- Planos diferentes não se sobrescrevem.
- Nenhum hook depende do `cwd`.

## Riscos e mitigação

- Compatibilidade de `args`: manter fallback npx e cobrir merge JSON.
- Plano sem sessão registrada: capturar mudança com `source: []`, emitir diagnóstico acionável.
