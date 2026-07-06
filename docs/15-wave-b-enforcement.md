# Wave B — Enforcement + conforto (spec de design)

> Segunda wave do programa [12](12-camada-verificacao-tlc.md). Fecha a paridade TLC.
> Decisões: **mutação = delegar + fix-tasks** (parsear report da ferramenta → survivor vira
> fix-task, bounded loop teto 3); **Wave B inteira num spec/plano** → alvo 0.6.0.
> Isto é design — o plano TDD vem depois de revisado.

## Objetivo
O framework passa a (a) **provar que os testes discriminam** (mutação), (b) **se
auto-verificar** (doctor do harness), (c) **aprender com falhas** (lessons), e (d) escalar
o rigor à complexidade (auto-sizing). É o último pedaço pra o gate ser prova, não teatro.

## Peças

### 1. Sensor de mutação (`type: mutation`) + survivor→fix-task (código)
**Contrato do sensor** (em `wendkeep.sensors.json`):
```json
{ "id": "mutation", "type": "mutation", "severity": "critical",
  "command": "npx stryker run",
  "report": "reports/mutation/mutation.json" }
```
- `verify` roda o `command` (exit code = verde/vermelho, igual sensor normal) e, sendo
  `type: mutation`, **parseia o `report`** (schema mutation-testing-elements / stryker JSON:
  `files{ "<path>": { mutants:[{ mutatorName, status, location.start.line }] } }`).
- **`parseMutationReport(json) -> [{file, line, mutator}]`** = mutantes com `status:'Survived'`
  (ou `'NoCoverage'`). Puro, testável.
- **Survivor → fix-task:** cada sobrevivente vira uma tarefa na change ativa:
  `- [ ] M.<n> mata mutante <file>:<line> (<mutator>) [sensor:<id>]`. Anexadas em `tarefas.md`.
- **Bounded loop (teto 3):** um contador por change (`.mutation-round` no dir da change).
  Cada `verify` que encontra sobreviventes incrementa + injeta fix-tasks; ao atingir 3,
  **para de auto-gerar** e escala pro usuário (mensagem), não fica em loop.

### 2. doctor do harness (código, puro)
**`checkHarness(vaultBase, projectRoot) -> { errors:[], warnings:[] }`** (novo lib), o CLI
`wendkeep doctor` chama e reporta (exit 1 se errors). Checagens:
- `wendkeep.sensors.json` parseia; cada sensor tem `id` + `command`; `type` ∈ {command,mutation,…}.
- Ponteiro `.brain/CURRENT_CHANGE.md` aponta pra change existente (ou vazio).
- Change malformada: dir em `08-Mudanças/` sem `proposta.md`.
- **Rastro:** todo `[req:ID]` das tarefas da change ativa resolve pra um requisito em
  `07-Specs/*` **ou** num delta `specs/*/spec.md` da própria change; senão *error* ("req órfão").
- **Verdict stale:** change ativa com `verdict.json` cujo `coverage` não cobre os `[req:]`
  atuais → *warning* ("re-verifique").
- Spec vivo sem footer de origem (`> Atualizado por…`) → *warning* ("spec sem origem").

### 3. Lessons loop (código)
- **`hooks/lessons-core.mjs`** (novo): `addLesson(vaultBase, {trigger, lesson, sourceChange})`
  escreve `.brain/lessons/<slug>.md` (slug do trigger); `buildLessonsInjection(vaultBase,
  {max=5})` → bloco `<lessons>` compacto (as N mais recentes), budget-capado.
- **`wendkeep lesson add "<trigger>" "<lesson>" [--change s]`** (CLI) — a skill `wk-verify`/
  `wk-debugging` chama quando uma verificação falha (destila a lição project-local).
- **`brain-inject`** injeta o bloco `<lessons>` junto do `<brain_memory>`/`<active_change>`
  no SessionStart. Falha de verificação vira prevenção no próximo trabalho.

### 4. Auto-sizing (código)
- **`wendkeep change new <slug> --simple`** — scaffold mínimo: só `proposta.md` + `tarefas.md`
  (sem `design.md`, sem `specs/exemplo/`). Default segue completo.
- Racional: no `new` ainda não há tarefas pra auto-detectar trivialidade; a decisão é
  explícita (`--simple`). Change trivial não carrega boilerplate de design/spec.

### 5. Contrato v1 → v1.1 (`docs/14`)
Marca `type: mutation` e o formato de **lesson** como implementados; documenta o schema do
report de mutação aceito (mutation-testing-elements) e a linha de fix-task.

## Módulos tocados
- `hooks/sensors-core.mjs` — `type: mutation` no `runSensors` + `parseMutationReport`.
- `hooks/change-core.mjs` — `newChange(..., { simple })`; `appendFixTasks(changeDir, mutants)`.
- `hooks/lessons-core.mjs` — novo (add + inject).
- `hooks/brain-inject.mjs` — injeta `<lessons>`.
- `hooks/harness-doctor.mjs` — novo (`checkHarness`).
- `src/verify.mjs` — mutação: survivors→fix-tasks + contador bounded.
- `src/change.mjs` — `--simple`; subcomando `lesson add` (ou `bin` roteia `lesson`).
- `src/doctor.mjs` — chama `checkHarness`.
- `src/taxonomy.mjs` — `HOOK_FILES += lessons-core.mjs, harness-doctor.mjs`.
- `bin/wendkeep.mjs` — comando `lesson`; help.

## Contratos de dados
```
sensor mutation: { id, type:'mutation', command, report, severity }
mutation report (entrada): { files: { "<path>": { mutants:[{ mutatorName, status, location:{ start:{ line } } }] } } }
fix-task (saída em tarefas.md): - [ ] M.<n> mata mutante <file>:<line> (<mutator>) [sensor:<id>]
lesson: .brain/lessons/<slug>.md  { trigger, lesson, sourceChange, date }
```

## Aceite (Wave B)
1. `parseMutationReport` extrai só `Survived`/`NoCoverage`.
2. `verify` com sensor `type:mutation` + report com sobrevivente → anexa fix-task na change; 3ª rodada escala.
3. `checkHarness` pega: sensors.json inválido, ponteiro quebrado, change sem proposta, `[req:]` órfão, verdict stale.
4. `lesson add` escreve `.brain/lessons/*`; `brain-inject` injeta `<lessons>`.
5. `change new --simple` → sem `design.md`/`specs/`.
6. `docs/14` atualizado; suíte verde; demo end-to-end.

## Não-objetivos
- Não embutir engine de mutação nativa (Q3=delegar; o mutador JS nativo fica fora).
- Não parsear formatos de report além do mutation-testing-elements (o de-facto). Outros = via `type:command`.
- Bounded loop não "conserta sozinho" — gera fix-tasks pro agente; teto 3 evita loop infinito.
