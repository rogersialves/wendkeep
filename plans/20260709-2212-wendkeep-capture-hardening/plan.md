# Plano — captura de planos, mudanças e specs (WendKeep 0.32.0)

## Objetivo

Corrigir perdas silenciosas do `ExitPlanMode`, estabilizar hooks fora da raiz, exigir classificação de impacto em specs, preparar o release 0.32.0 e atualizar localmente o NutriGym Vision para validação antes da publicação npm pelo usuário.

## Fonte aprovada

- `C:\GitHub\WendKeep\docs\superpowers\specs\2026-07-09-wendkeep-plan-spec-capture-hardening-design.md`

## Fases

- [x] [Fase 1 — runtime e captura de plano](phase-01-runtime-plan-capture.md)
- [x] [Fase 2 — contrato de spec e gates](phase-02-spec-impact-gates.md)
- [x] [Fase 3 — skills, integridade e release](phase-03-skills-integrity-release.md)
- [x] [Fase 4 — integração e recuperação NutriGym](phase-04-nutrigym-integration-backfill.md)

## Dependências

1. Fase 1 antes da migração dos hooks no consumidor.
2. Fase 2 antes do backfill, para validar os novos artefatos.
3. Fase 3 antes do empacotamento local.
4. Fase 4 por último, preservando a árvore de produto suja.

## Gates globais

- `npm.cmd test`
- `npm.cmd run check`
- `npm.cmd pack --dry-run`
- testes focados por fase
- `wendkeep doctor` no consumidor
- JSON válido em `.claude/settings.json` e `.codex/hooks.json`

## Release

- Versão alvo: `0.32.0`.
- Atualizar `package.json` e `CHANGELOG.md` em formato Keep a Changelog.
- Não executar `npm publish` nem push remoto.

## Riscos

- Gate novo bloquear changes legadas: tratar ausência de `spec_impact` como legado diagnosticável, não como `none` implícito.
- `init --force` duplicar hooks: reconhecer comandos relativo, npx e ancorado.
- Backfill tocar trabalho do usuário: limitar alterações a `.NutriGymBrain`, configurações/skills WendKeep e dependência instalada localmente.

## Pendências externas

- Publicação no npm: responsabilidade do usuário após a entrega.
