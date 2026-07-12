<!-- wendkeep:skills:start -->
<!-- wendkeep-version: 0.38.1; skills-sha256: d09987ccbbefccd06af0a290dc6d820444e6c306230b1e4cba9b7d0cccd3039f -->
## wendkeep — process skills & loop

This project uses the [wendkeep](https://github.com/rogersialves/wendkeep) harness. Work
through its change loop: `wendkeep change new <slug>` → implement tasks test-first
(tag proof `[sensor:id]` and requirement `[req:ID]`) → `wendkeep verify` →
`wendkeep verify --deep` + an independent read-only verification pass writing
`verdict.json` → `wendkeep change archive` (gated). Inspect with `wendkeep change
status` / `spec effective --change <slug>` / `sensors list`. Author specs only in
`08-Mudanças/<slug>/specs/`; `07-Specs` is generated and must not be edited directly.

Process skills (full text in `.claude/skills/`, `.agents/skills/`, and the vault's `.brain/skills/`):
- **example-skill** — An example custom skill. Replace with your own — describe the trigger here.
- **wk-brainstorming** — Use quando a ideia ainda é vaga ou o usuário quer discutir/planejar uma feature (inclusive em plan mode) — vira design aprovado, com closure gate e tabela out-of-scope, antes de código.
- **wk-debugging** — Use quando algo falha, quebra, dá erro ou regride — depuração sistemática por hipótese antes de corrigir.
- **wk-planning** — Use após um design aprovado ou um plano aceito (inclusive plan mode) — decompõe em plano de tarefas TDD bite-sized e registra na change ativa.
- **wk-tdd** — Use ao implementar qualquer comportamento — Red/Green/Refactor com testes que discriminam (derivados do spec, litmus não-raso, adequação).
- **wk-verify** — Use no verify deep — passe independente read-only (autor≠verificador) que re-deriva a cobertura do spec e grava verdict.json.
- **wk-workflow** — Use SEMPRE que o usuário pedir para implementar, criar, corrigir, refatorar, adicionar ou alterar código — qualquer tarefa de código não-trivial. Invoque ANTES de editar qualquer arquivo: orquestra o loop a2 (wendkeep change new → tarefas → verify → archive) e registra tudo no vault.
<!-- wendkeep:skills:end -->

## Release & publicação (regra do projeto)

O mantenedor executa a publicação; agentes apenas **preparam**. Nunca rode `npm publish`
nem `npm run release` por conta própria.

1. **Antes de preparar**, consulte a versão publicada: `npm view wendkeep version`. Alinhe
   `package.json`, `CHANGELOG.md` e a tag `vX.Y.Z` a esse estado antes de bumpar.
2. Bump SemVer: `npm version <patch|minor|major> --no-git-tag-version` (fix→patch, feat→minor).
3. Adicione a entrada `## [X.Y.Z] — AAAA-MM-DD` no topo do `CHANGELOG.md` (Keep a Changelog).
   O CHANGELOG é a fonte única — `scripts/release.mjs` e a GitHub Release (`release.yml`) leem dele.
4. Commit `fix|feat: <resumo> (X.Y.Z)` com código + `package.json` + `CHANGELOG.md`. O working
   tree precisa ficar limpo (guard do release).
5. Valide com `npm run release -- --dry-run` (checa CHANGELOG, tree limpo, tag inexistente) e **pare**.
6. O mantenedor roda `npm run release` (npm publish + tag + push; a GitHub Release nasce do push da tag).

CHANGELOG ↔ NPM ↔ GitHub devem ficar sempre na mesma versão.
