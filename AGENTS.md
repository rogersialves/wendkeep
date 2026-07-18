<!-- wendkeep:skills:start -->
<!-- wendkeep-version: 0.45.0; skills-sha256: c69f17a96cefc1f8a24a6bb6295bd4c0368c99f6d9f722f3ee6b95854729e8ad -->
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

## Contribuição — PR por implementação (regra do projeto)

**Toda implementação vai por Pull Request. Nunca commite direto na `main`.** Cada change do
loop a2 (ou correção de infra) nasce num branch `wk/<slug>`, vira PR e é revisada/merged pelo
mantenedor. O merge na `main` é o gatilho da release (ver automação abaixo).

1. `git checkout -b wk/<slug>` antes de editar.
2. Implemente pelo loop a2 (change new → tarefas TDD → verify → archive). Bump de versão +
   `CHANGELOG.md` no MESMO PR quando a mudança afeta o pacote.
3. `git push origin wk/<slug>` e abra o PR (`gh pr create`) com resumo + entrada do CHANGELOG.
4. Mantenedor revisa e faz merge. **Não faça self-merge sem revisão se a branch protection exigir.**

## Release & publicação (regra do projeto)

CHANGELOG ↔ NPM ↔ GitHub **sempre na mesma versão**. A **tag `vX.Y.Z` é o elo** que fecha isso:
sem a tag pushada, o `release.yml` não cria a GitHub Release e a página fica atrás do npm.
Esse foi um atrito recorrente (12/07, 16/07) — `npm publish` avulso publicava sem tag.

**Automação (auto-tag-release):** `.github/workflows/auto-tag.yml` observa a `main`; quando o
`package.json` traz uma versão sem tag correspondente, ele **cria a tag E a GitHub Release**
(notas do CHANGELOG). Ou seja: merge de um PR que bumpa a versão → release automática. Ninguém
mais depende de lembrar de pushar a tag.

**Fluxo do agente (só prepara):**
1. `npm view wendkeep version` — alinhe `package.json`/`CHANGELOG`/tag a esse estado antes de bumpar.
2. Bump SemVer no PR: `npm version <patch|minor|major> --no-git-tag-version` (fix→patch, feat→minor).
3. Entrada `## [X.Y.Z] — AAAA-MM-DD` no topo do `CHANGELOG.md` (fonte única; `release.yml`/
   `auto-tag.yml`/`scripts/release.mjs` leem dela).
4. Commit `fix|feat: <resumo> (X.Y.Z)` no branch; abra o PR. Ao merge, a automação tag+release.

**Mantenedor (publica no npm):** `npm run release` (npm publish + tag + push, atômico) OU
`npm publish` — neste caso a `auto-tag.yml` cobre a tag no push da `main`. Nunca deixe npm à
frente da GitHub Release sem tag.

**Recuperação retroativa** (releases perdidas): `git tag -a vX.Y.Z <sha> -m "vX.Y.Z" && git push
origin vX.Y.Z` no commit cujo `package.json` tem a versão — o `release.yml` monta a Release do
CHANGELOG.
