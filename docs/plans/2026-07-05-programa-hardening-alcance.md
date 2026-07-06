# Programa pós-paridade — hardening, ergonomia, alcance (0.6.1 → 0.8.0)

> Plano-programa em 3 releases. TDD, `node --test`, zero dep no core. "Commit" = checkpoint
> verde + commit git (repo existe agora). Cada release: CHANGELOG + tag + GitHub release +
> `npm publish` (OTP do usuário).
> Detalhe: 0.6.1 com código completo (executa já); 0.7.0 médio; 0.8.0 discovery-first
> (i18n/agent-agnostic têm incógnitas — detalhar depois do discovery é honesto, antes é chute).

## Avaliação própria de gaps (além da lista do turno anterior)

Verificados no código:
- **G1 — archive ignora tarefas abertas.** O gate checa sensores + verdict, mas não `- [ ]`.
  Fix-tasks `M.n` (mutantes sobreviventes) abertas não bloqueiam o archive — fura a
  discriminação. TLC exige toda task fechada.
- **G2 — proposta `source:` sempre vazio.** `src/change.mjs` não passa `sessionRel` ao
  `newChange` (a assinatura aceita). `readControl` (obsidian-common:173) tem `session_file`
  da sessão ativa — dá pra linkar automático. Aresta proposta→sessão faltando no grafo.
- **G3 — evidência sem frescor.** `evidencia.json` antigo passa o gate pra sempre. Par do
  bug #6 (verdict stale por mudança de código): resolver os dois com **hash de tarefas.md**
  gravado no pacote/verdict e conferido no gate.
- **G4 — `verify` sai 0 com mutantes sobreviventes.** Fix-tasks anexadas mas exit verde;
  CI/script não detecta. Sobrevivente = exit 1 (o sensor passou no threshold da ferramenta,
  mas o nosso contrato é "discrimina ou vermelho").

Avaliados e **adiados com razão** (backlog, não releases):
- **Concorrência multi-sessão** (uma change ativa global): real, mas exige redesign do
  ponteiro (por worktree/branch). Não travar releases nisso; design próprio depois.
- **Auto-destilar lessons**: gancho automático gera ruído; manter manual via skill + 1
  auto-trigger barato (escalação de mutação, ver 0.6.1 T2).
- **Benchmark tipo TLC**: marketing, não engenharia. Só depois de i18n/agnostic.

---

## Release 0.6.1 — Hardening (bugs + CI). Patch.

### Task 1 — CI (GitHub Actions)
**Files:** create `.github/workflows/test.yml`.
- [ ] Workflow: push+PR na `main`; matrix `os: [ubuntu-latest, windows-latest]`,
  `node: [18, 20, 22]`; steps: checkout → setup-node → `npm test` → `npm run check`.
```yaml
name: test
on: { push: { branches: [main] }, pull_request: {} }
jobs:
  test:
    strategy: { matrix: { os: [ubuntu-latest, windows-latest], node: [18, 20, 22] } }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: ${{ matrix.node }} }
      - run: npm test
      - run: npm run check
```
- [ ] Badge no README (`![test](https://github.com/rogersialves/wendkeep/actions/workflows/test.yml/badge.svg)`).
- [ ] Checkpoint: push numa branch, ver o workflow verde, merge. (Ubuntu vai pegar qualquer
  path/case bug que o dev Windows escondeu — é o objetivo.)

### Task 2 — mutation-round: reset + exit 1 + auto-lesson na escalação (#5, G4)
**Files:** `src/verify.mjs`; test `tests/change-cli.test.mjs`.
- [ ] Test: (a) verify com report limpo (0 survivors) após rodadas → `.mutation-round`
  resetado (próximo survivor = rodada 1); (b) verify com survivor → exit **1**; (c) 3ª
  rodada → escala E grava lesson automática (`.brain/lessons/*mutant*`).
- [ ] Impl em `src/verify.mjs` (bloco de mutação):
```js
  const roundFile = join(changeDir, '.mutation-round');
  if (!withSurvivors.length) {
    try { unlinkSync(roundFile); } catch { /* nunca houve */ }   // reset (#5)
  } else {
    let round = 0;
    try { round = Number(readFileSync(roundFile, 'utf8').trim()) || 0; } catch {}
    if (round >= 3) {
      process.stderr.write('verify: mutantes sobrevivem após 3 rodadas — revise os testes à mão.\n');
      try { addLesson(vaultBase, { trigger: `mutantes persistentes em ${slug}`, lesson: `3 rodadas não mataram: ${withSurvivors.flatMap((e)=>e.survivors.map((s)=>`${s.file}:${s.line}`)).join(', ')}`, sourceChange: slug, dateStr: today() }); } catch {}
    } else { /* appendFixTasks + increment (igual hoje) */ }
    // G4: sobrevivente = falha do verify, sempre.
    process.exit(1);
  }
```
  (import `unlinkSync`, `addLesson`; extrair `today()` comum.)
- [ ] Checkpoint: `npm test` + commit.

### Task 3 — gate bloqueia tarefa aberta (G1)
**Files:** `src/change.mjs`; test `tests/change-cli.test.mjs`.
- [ ] Test: change com `- [ ] 1.1` aberta + sensores/verdict ok → archive **bloqueia**
  (`/tarefas abertas/`); com `- [x]` → passa. Flag `--force` arquiva mesmo assim (escape
  explícito, warning).
- [ ] Impl: no gate closure de `src/change.mjs`, antes do verdict:
```js
      const open = tasks.filter((t) => !t.done);
      if (open.length && !rest.includes('--force')) {
        return { ok: false, failing: [`${open.length} tarefa(s) abertas (ex.: ${open[0].id}) — conclua ou use --force`] };
      }
```
- [ ] Ajustar testes existentes que arquivam com task aberta (usar `- [x]` ou `--force`).
- [ ] Checkpoint.

### Task 4 — frescor: hash de tarefas no pacote/verdict (#6, G3)
**Files:** `src/verify.mjs`, `hooks/spec-core.mjs`, `src/change.mjs`; tests `tests/spec-core.test.mjs`, `tests/change-cli.test.mjs`.
- [ ] Test unit: `evaluateVerdict(verdict, reqIds, { tasksHash })` → `ok:false` quando
  `verdict.tasksHash` difere; e2e: editar `tarefas.md` após verdict → archive bloqueia
  (`/re-verifique|stale/`).
- [ ] Impl: `verify --deep` calcula `tasksHash = createHash('sha1').update(tarefas).digest('hex').slice(0,12)`
  e grava no pacote **e** no auto-verdict trivial. Skill `wk-verify` copia do pacote pro
  verdict (atualizar texto da skill + docs/14). Gate recomputa o hash de `tarefas.md` e
  passa em `evaluateVerdict`; mismatch = `{ok:false}` com mensagem "verdict stale".
  Retrocompat: verdict sem `tasksHash` → aceito com warning no doctor (não quebra 0.6.0).
- [ ] Checkpoint.

### Task 5 — lessons: cap no diretório (#7)
**Files:** `hooks/lessons-core.mjs`; test `tests/lessons-core.test.mjs`.
- [ ] Test: 60 lessons → `addLesson` mantém ≤50 (poda as mais antigas por nome asc).
- [ ] Impl: no fim de `addLesson`: `readdirSync(dir).filter(md).sort()` → enquanto
  `length > 50`, `unlinkSync` da primeira (nomes têm prefixo de data → asc = mais antiga).
- [ ] Checkpoint.

### Task 6 — proposta linka a sessão ativa (G2)
**Files:** `src/change.mjs`; test `tests/change-cli.test.mjs`.
- [ ] Test: com `.obsidian-control` apontando `session_file` (usar `writeControl` de
  obsidian-common no setup), `change new x` → `proposta.md` contém o wikilink da sessão.
- [ ] Impl: `runChange` new: `const control = readControl(vaultBase); const sessionRel =
  control.session_file || '';` → `newChange(vaultBase, slug, { dateStr: today(), simple, sessionRel })`.
  Fail-quiet (sem control = `source: []`, igual hoje).
- [ ] Checkpoint.

### Task 7 — release 0.6.1
- [ ] docs/14: campo `tasksHash` no pacote/verdict. CHANGELOG `## [0.6.1]` (Fixed: #5 #6 #7
  G1–G4; Added: CI). Bump. `npm test` + `npm run check`. Commit, push, tag `v0.6.1`,
  `gh release create`, usuário publica npm.

---

## Release 0.7.0 — Ergonomia (o loop sem hand-edit). Minor.

### Task 1 — `change status`
`wendkeep change status [slug]`: proposta (status/specs), tarefas (done/open, req/sensor por
task), evidência (verde/vermelho + ts), verdict (ok/stale/ausente), mutation-round. Uma tela.
Test e2e: monta change completa, confere seções no stdout.

### Task 2 — `change done <taskId>` (+ `undone`)
Marca `- [ ]`→`- [x]` do id exato em `tarefas.md` (regex ancorada no id; erro se id não
existe; idempotente). Test unit (lib em change-core: `setTaskDone(changeDir, id, done)`) + e2e.

### Task 3 — `change diff`
Preview da promoção: pra cada cap em `specs:`, parse delta + spec vivo → imprime
`+ ADDED GATE-2`, `~ MODIFIED GATE-1`, `- REMOVED GATE-3`, `! warnings` — sem escrever nada.
Reusa `parseDelta`/`parseRequirements`/`applyDelta` (dry-run). Test e2e.

### Task 4 — `spec list` / `spec show <cap>`
`list`: caps em 07-Specs com contagem de requisitos + data do footer. `show`: requisitos
(id — nome) da cap. Novo `src/spec.mjs` + bin. Test e2e.

### Task 5 — `sensors list` + schema JSON
`wendkeep sensors list`: tabela id/type/severity/command do `wendkeep.sensors.json`.
Publicar `schema/wendkeep.sensors.schema.json` no pacote (files) + `$schema` no seed do init.
Test: schema válido (parse), seed aponta `$schema`.

### Task 6 — README worked example
Seção "O loop em 5 minutos": init → change new → req/sensor → tdd → verify → verify --deep →
wk-verify → archive → grafo. Com saídas reais. + `change status/done/diff`, `spec`, `sensors`
na tabela de comandos.

### Task 7 — release 0.7.0 (CHANGELOG, bump, tag, release, npm).

---

## Release 0.8.0 — Alcance (i18n + agent-agnostic). Minor, discovery-first.

### Task 1 — Discovery i18n (sem código)
Inventário: grep de cada pasta PT (`02-Sessões`, `04-Decisões`, `05-Bugs`, `06-Aprendizados`,
`07-Specs`, `08-Mudanças`, meses `07-JUL`, headings `## Requisitos`, `### Requisito:`,
frontmatter) em hooks/src/tests. Saída: docs/16 com a lista exata de pontos + proposta:
**módulo `hooks/locale.mjs`** (mapa `folders/months/headings` por locale, default `pt-BR`,
`en` segundo), config em `wendkeep.config.json` na raiz (novo, contrato v1.2), lido 1× por
processo. Regra dura: vault existente NUNCA renomeado — locale trava no init (gravado no
config; mudar = migração manual documentada).

### Task 2 — Implementar locale core + `en`
TDD sobre o inventário do T1: substituir literais por `locale().folders.sessions` etc.
Testes atuais fixam `pt-BR` (default — zero quebra); novos testes e2e com `--locale en`
no init (pastas `02-Sessions`, `04-Decisions`, …). Contrato v1.2 documenta o mapa.

### Task 3 — Discovery agent-agnostic (sem código)
Codex/Cursor/Windsurf: onde vivem instruções por projeto (`AGENTS.md`, `.cursor/rules`,
`.windsurfrules`)? Skills wk-* têm equivalente? Proposta esperada: `sync-defs` ganha alvo
**AGENTS.md** — gera/atualiza uma seção `<!-- wendkeep:skills -->` com o conteúdo das wk-*
(condensado) + os comandos do loop; Cursor idem via `.cursor/rules/wendkeep.md`. Hooks de
sessão pros outros agentes: mapear o que cada um suporta (Codex hooks TOML?) — pode virar 0.9.
Saída: docs/17 com decisão.

### Task 4 — Implementar distribuição agnóstica (do docs/17)
TDD: `sync-defs` escreve os novos alvos (idempotente, marcador de seção, não clobber);
init inclui. e2e por alvo.

### Task 5 — Formatos de mutação extras (opcional, corta se apertar)
`report` ganha `format: 'mte' | 'mutmut' | 'pit'` (default mte). Parsers pequenos p/
`mutmut` (JSON/summary) e PIT (XML — regex simples, sem dep). Testes com fixtures reais.

### Task 6 — release 0.8.0.

---

## Backlog (sem release marcada)
- Concorrência: ponteiro de change por sessão/worktree (design próprio).
- Auto-destilar lessons de falha de verify (além do trigger de mutação).
- Benchmark público estilo TLC.
- Mutador JS nativo mínimo (demo zero-setup, rotulado "raso").

## Ordem e gates
0.6.1 primeiro (endurece o que JÁ está no ar — bugs reais afetando 0.6.0 publicado),
depois 0.7.0 (fricção diária), depois 0.8.0 (mercado). Cada release: suíte verde + demo
ao vivo + CHANGELOG + tag + GitHub release; npm publish é do usuário (OTP).
