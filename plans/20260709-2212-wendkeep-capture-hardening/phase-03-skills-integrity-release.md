# Fase 3 — skills, integridade e release

## Status

Concluída em 2026-07-09. Prioridade P1.

## Arquivos

- Modificar `C:\GitHub\WendKeep\src\skills-seed.mjs` e testes.
- Modificar `C:\GitHub\WendKeep\hooks\brain-inject.mjs` e testes.
- Modificar `C:\GitHub\WendKeep\hooks\session-stop.mjs` e/ou `decision-capture.mjs` para backlinks.
- Modificar `C:\GitHub\WendKeep\hooks\vault-health.mjs` e testes.
- Modificar `C:\GitHub\WendKeep\src\init.mjs` para orientação de ignore.
- Modificar `C:\GitHub\WendKeep\package.json` para `0.32.0`.
- Modificar `C:\GitHub\WendKeep\CHANGELOG.md` com entrada `0.32.0` em 2026-07-09.

## Implementação

1. Exigir `spec_impact`, capability, delta e `[req:]` em `wk-workflow`/`wk-planning`.
2. Atualizar o roteador de SessionStart.
3. Reescrever backlink da sessão ao arquivar; manter link válido para `_arquivo`.
4. Atualizar decisão capturada na sessão no mesmo ciclo quando seguro.
5. Distinguir health check de sessão ativa/finalizada.
6. Recomendar ignore para `.brain/.change-*`.
7. Atualizar versão e changelog com Added/Changed/Fixed e migração.
8. Rodar suíte completa, check e `npm pack --dry-run`.

## Aceite

- Skills geradas descrevem o fluxo completo.
- Links da sessão não quebram após archive.
- Changelog é específico e release-ready.
- Tarball contém todos os hooks/imports necessários.

## Fora de escopo

- `npm publish`, tags e push remoto.
