<!-- wendkeep:skills:start -->
<!-- wendkeep-version: 0.67.0; skills-sha256: d170f56e18f94318178d4062b722c40275d07c10e76021f95d16f441d498328d -->
## wendkeep — Keep Core & operating profiles

This project uses the [wendkeep](https://github.com/rogersialves/wendkeep) harness. **Keep Core is always active**
in every profile: Vault, session, identity, memory, lessons, and persistence integrations.
The persistent profile is selected explicitly; missing or invalid configuration uses **GOVERN as the default**.

Before an implementation, the native LLM harness classifies the current request and may create a
task-scoped lease with `wendkeep profile route <FLOW|GUIDE|GOVERN|ASSURE> --session <id> --reason <text>`.
The lease expires when that request ends and the persistent session/project profile becomes
effective again. **OFF is never selected adaptively**; only a human can persist `profile use OFF`.

Route work by the effective profile:
- **OFF** — Wend Runtime is disabled and governance belongs to the native LLM harness; Keep Core stays active.
- **FLOW** — Execute → Validate through `wendkeep flow start/finish`, without creating a change.
- **GUIDE** — Plan → Execute → Validate through a compact change.
- **GOVERN** — the default a2 loop: `wendkeep change new <slug>` → review → implement tasks test-first
  (tag proof `[sensor:id]` and requirement `[req:ID]`) → `wendkeep verify` →
  `wendkeep verify --deep` + independent read-only verdict → `wendkeep change archive`.
- **ASSURE** — GOVERN plus explicit confirmation and handoff.

Inspect with `wendkeep profile status` / `wendkeep change status` /
`spec effective --change <slug>` / `sensors list`. Author specs only in
`08-Mudanças/<slug>/specs/`; `07-Specs` is generated and must not be edited directly.

Process skills (full text in `.claude/skills/`, `.agents/skills/`, and the vault's `.brain/skills/`):
- **example-skill** — An example custom skill. Replace with your own — describe the trigger here.
- **wk-brainstorming** — Use quando a ideia ainda é vaga ou o usuário quer discutir/planejar uma feature (inclusive em plan mode) — vira design aprovado, com closure gate e tabela out-of-scope, antes de código.
- **wk-debugging** — Use quando algo falha, quebra, dá erro ou regride — depuração sistemática por hipótese antes de corrigir.
- **wk-planning** — Use após um design aprovado ou um plano aceito (inclusive plan mode) — decompõe em plano de tarefas TDD bite-sized e registra na change ativa.
- **wk-tdd** — Use ao implementar qualquer comportamento — Red/Green/Refactor com testes que discriminam (derivados do spec, litmus não-raso, adequação).
- **wk-verify** — Use no verify deep — passe independente read-only (autor≠verificador) que re-deriva a cobertura do spec e grava verdict.json.
- **wk-workflow** — Use quando o usuário pedir para implementar, criar, corrigir, refatorar, adicionar ou alterar código: classifique e registre a rota temporária FLOW/GUIDE/GOVERN/ASSURE ANTES de editar, então siga o perfil efetivo. Keep Core permanece ativo; OFF nunca é automático.
<!-- wendkeep:skills:end -->

## Contribuição — PR por implementação (regra do projeto)

**Toda implementação vai por Pull Request por padrão.** Commits diretos na `main` são permitidos quando o mantenedor os solicitar expressamente. Sem essa solicitação, cada change do
loop a2 (ou correção de infra) nasce num branch `wk/<slug>`, vira PR e é revisada/merged pelo
mantenedor. O merge na `main` é o gatilho da release (ver automação abaixo).

1. `git checkout -b wk/<slug>` antes de editar.
2. Implemente pelo loop a2 (change new → tarefas TDD → verify → archive). Bump de versão +
   `CHANGELOG.md` no MESMO PR quando a mudança afeta o pacote.
3. `git push origin wk/<slug>` e abra o PR (`gh pr create`) com resumo + entrada do CHANGELOG.
4. Mantenedor revisa e faz merge. **Não faça self-merge sem revisão se a branch protection exigir.**

## Documentação bilíngue (regra do projeto)

Toda alteração em comando, flag, código de saída, fluxo, hook ou comportamento observável deve
atualizar, no mesmo commit, o resumo do `README.md`/`README.en.md` e o par de guias PT-BR/EN
correspondente sob `docs/pt-BR/commands/` e `docs/en/commands/`. Nenhum idioma pode ficar atrás.

Esta regra é exclusiva do repositório WendKeep e fica fora do bloco gerenciado acima. Ela não deve
ser propagada por `init`, `sync` ou `sync-defs` para o `AGENTS.md` de projetos consumidores.

## Release & publicação (regra do projeto)

CHANGELOG ↔ NPM ↔ GitHub **sempre na mesma versão**. A **tag `vX.Y.Z` é o elo** que fecha isso:
sem a tag pushada, o `release.yml` não cria a GitHub Release e a página fica atrás do npm.
Esse foi um atrito recorrente (12/07, 16/07) — `npm publish` avulso publicava sem tag.

**Automação (auto-tag-release):** `.github/workflows/auto-tag.yml` observa a `main`, gera as
notas da versão corrente diretamente do `CHANGELOG.md` e converge o estado remoto: cria a tag
quando ausente e cria **ou atualiza** a GitHub Release mesmo quando a tag já existe. O job lê as
notas publicadas de volta e falha se elas divergirem do changelog.

**Fluxo do agente (só prepara):**
1. `npm view wendkeep version` — alinhe `package.json`/`CHANGELOG`/tag a esse estado antes de bumpar.
2. Bump SemVer no PR: `npm version <patch|minor|major> --no-git-tag-version` (fix→patch, feat→minor).
3. Entrada `## [X.Y.Z] — AAAA-MM-DD` no topo do `CHANGELOG.md` (fonte única; `release.yml`/
   `auto-tag.yml`/`scripts/release.mjs` leem dela).
4. Commit `fix|feat: <resumo> (X.Y.Z)` no branch; abra o PR. Ao merge, a automação tag+release.

**Mantenedor (publica no npm):** `npm run release` (npm publish + tag + push, atômico) OU
`npm publish` — neste caso a `auto-tag.yml` cobre a tag no push da `main`. Nunca deixe npm à
frente da GitHub Release sem tag.

**Fechamento obrigatório — CHANGELOG → GitHub Release:** não declare uma release concluída só
porque npm e tag existem. A entrada `## [X.Y.Z]` do `CHANGELOG.md` deve ser o corpo efetivamente
publicado em `vX.Y.Z`. Depois do merge/tag, confirme a execução verde do workflow e leia a Release
de volta. Se uma entrada já publicada for corrigida, atualize a Release existente sem mover a tag:

```powershell
node scripts/print-release-notes.mjs X.Y.Z > RELEASE_NOTES.md
gh release edit vX.Y.Z --notes-file RELEASE_NOTES.md
gh release view vX.Y.Z --json body --jq .body
Remove-Item RELEASE_NOTES.md
```

Para a versão corrente, `auto-tag.yml` faz create/update + readback automaticamente. Para uma
versão histórica diferente da versão de `package.json`, o agente/mantenedor executa o fluxo acima
explicitamente. A conclusão exige `package.json`, npm `latest`, tag e corpo da GitHub Release na
mesma versão e com as mesmas notas relevantes do `CHANGELOG.md`.

**Recuperação retroativa** (releases perdidas): `git tag -a vX.Y.Z <sha> -m "vX.Y.Z" && git push
origin vX.Y.Z` no commit cujo `package.json` tem a versão — o `release.yml` monta a Release do
CHANGELOG. Depois, aplique o fechamento obrigatório acima e confirme o corpo publicado.
