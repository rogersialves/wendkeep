# Wave B — Enforcement (plano)

> Implementa [docs/15](../15-wave-b-enforcement.md) (design/contratos lá). superpowers:executing-plans.
> TDD, `node --test`, zero dep. "Commit" = checkpoint verde. Alvo 0.6.0.

### Task 1 — Sensor `type: mutation` + parse do report
**Files:** `hooks/sensors-core.mjs`; Test `tests/sensors-core.test.mjs`.
- `parseMutationReport(json) -> [{file, line, mutator}]` — walk `json.files{path:{mutants[]}}`, filtra `status ∈ {Survived, NoCoverage}`, pega `location.start.line` + `mutatorName`.
- `runSensors`: sensor com `type:'mutation'` → roda command (status por exit, igual), + se houver `report` legível no `cwd`, anexa `survivors:[{file,line,mutator}]` na evidência.
- Testes: report com Survived+Killed+NoCoverage → só os 2; runSensors mutation com fake spawn + report tmp → evidence.survivors.
- Checkpoint: `npm test`.

### Task 2 — Survivor → fix-task + bounded loop (teto 3)
**Files:** `hooks/change-core.mjs`, `src/verify.mjs`; Test `tests/change-core.test.mjs`, `tests/change-cli.test.mjs`.
- `appendFixTasks(changeDir, mutants, sensorId) -> nAdded` — anexa `- [ ] M.<n> mata mutante <file>:<line> (<mutator>) [sensor:<id>]` em `tarefas.md` (dedup por file:line; numera M.1..).
- `src/verify.mjs`: após rodar sensores, pra cada evidência com `survivors`, ler contador `.mutation-round` (int) do changeDir; se <3 → appendFixTasks + incrementa + avisa; se ≥3 → não gera, escala (stderr) mas não derruba.
- Testes: appendFixTasks unit (dedup, numeração); e2e verify com report sobrevivente → fix-task em tarefas.md; 3ª rodada não anexa.
- Checkpoint.

### Task 3 — doctor do harness
**Files:** `hooks/harness-doctor.mjs` (novo), `src/doctor.mjs`, `src/taxonomy.mjs`; Test `tests/harness-doctor.test.mjs`.
- `checkHarness(vaultBase, projectRoot) -> {errors:[], warnings:[]}` — sensors.json válido; ponteiro CURRENT_CHANGE resolve; change sem proposta; `[req:]` órfão (não em `07-Specs/*` nem no delta da change) = error; verdict stale (coverage ⊉ [req:] atuais) = warning; spec sem footer origem = warning.
- `src/doctor.mjs`: chama checkHarness, imprime errors/warnings, exit 1 se errors.
- `HOOK_FILES += 'harness-doctor.mjs'`.
- Testes: vault sintético dispara cada categoria.
- Checkpoint.

### Task 4 — lessons-core + injeção
**Files:** `hooks/lessons-core.mjs` (novo), `hooks/brain-inject.mjs`, `src/taxonomy.mjs`; Test `tests/lessons-core.test.mjs`.
- `addLesson(vaultBase, {trigger, lesson, sourceChange, dateStr}) -> path` → `.brain/lessons/<slug(trigger)>.md` (frontmatter + corpo). `buildLessonsInjection(vaultBase, {max=5}) -> string` → `<lessons>…</lessons>` das N mais recentes (por mtime? sem Date — por ordem de readdir; nome com data prefix pra ordenar). Budget-capado.
- `brain-inject`: append `buildLessonsInjection` após `<active_change>`.
- `HOOK_FILES += 'lessons-core.mjs'`.
- Testes: addLesson escreve+slug; buildLessonsInjection formata + cap; brain-inject inclui bloco.
- Checkpoint.

### Task 5 — CLI `wendkeep lesson add`
**Files:** `src/lessons.mjs` (novo) ou `src/change.mjs`; `bin/wendkeep.mjs`; Test `tests/change-cli.test.mjs`.
- `runLesson(argv)` → `lesson add "<trigger>" "<lesson>" [--change s] [--vault p]` chama addLesson.
- bin roteia `lesson`; help.
- Teste e2e: `lesson add` cria arquivo; `brain-inject` (hook) injeta.
- Checkpoint.

### Task 6 — auto-sizing `change new --simple`
**Files:** `hooks/change-core.mjs`, `src/change.mjs`; Test `tests/change-core.test.mjs`, `tests/change-cli.test.mjs`.
- `newChange(vaultBase, slug, { …, simple })` — se `simple`: escreve só proposta+tarefas (sem design.md, sem specs/exemplo).
- `src/change.mjs`: `change new <slug> --simple` passa `simple:true`.
- Testes: newChange simple → sem design/specs; e2e flag.
- Checkpoint.

### Task 7 — Contrato v1.1 + CHANGELOG 0.6.0
**Files:** `docs/14-harness-contract.md`, `CHANGELOG.md`, `package.json`.
- docs/14: `type: mutation` + lesson marcados implementados; schema do report; linha fix-task.
- CHANGELOG `## [0.6.0]`; bump `0.5.0 → 0.6.0`.
- Checkpoint: `npm test` + `npm run check` verdes.

## Self-Review
Cobre docs/15: mutação+parse (T1) ✓; survivor→fix-task+bounded (T2) ✓; doctor (T3) ✓; lessons (T4,T5) ✓; auto-sizing (T6) ✓; contrato (T7) ✓.
