# Plano — visibilidade global de pendências

## Objetivo

Exibir todas as changes e tarefas abertas para Claude, Codex e demais agentes, mantendo
`.brain/CURRENT_CHANGE.md` como ponteiro global único para comandos implícitos.

## Fonte aprovada

- `docs/superpowers/specs/2026-07-10-global-change-pending-visibility-design.md`

## Fases

- [x] [Fase 1 — projeção global no núcleo](phase-01-global-change-projection.md)
- [x] [Fase 2 — hooks multiagente](phase-02-multi-agent-hooks.md)
- [x] [Fase 3 — CLI, documentação e validação](phase-03-cli-docs-validation.md)

## Dependências

1. Fase 1 define a fonte única consumida pelas fases 2 e 3.
2. Fase 2 preserva sentinelas por sessão e gate somente da change atual.
3. Fase 3 fecha compatibilidade, documentação e regressão completa.

## Arquivos principais

- `hooks/change-core.mjs`
- `hooks/brain-inject.mjs`
- `hooks/change-context.mjs`
- `hooks/change-nag.mjs`
- `src/change.mjs`
- `src/skills-seed.mjs`
- testes correspondentes em `tests/`
- `README.md`, `README.pt-BR.md`, `CHANGELOG.md`, `package.json`

## Gates globais

- Testes focados por fase.
- `npm.cmd test`.
- `npm.cmd run check`.
- `git diff --check`.
- Smoke com duas changes abertas e troca do ponteiro.

## Restrições

- Sem ponteiro por provedor ou sessão.
- Sem filtro por Claude/Codex.
- Sem gate global entre changes.
- Sem migração de vault.
- Sem `npm publish`.

## Questões não resolvidas

- Nenhuma. O design aprovado fixa ponteiro único, visibilidade global e gates locais.
