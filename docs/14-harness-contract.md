# Harness contract v1 — pontos de extensão

Os formatos que o harness do wendkeep lê/escreve. Quem estende (novos sensores, specs,
skills, integrações) mira **este contrato**, não o código. Estável dentro do major.
Itens marcados *(Wave B)* ainda não implementados.

## Locale (v1.2) — `<vault>/.brain/config.json`
```json
{ "locale": "pt-BR" }
```
Propriedade do VAULT, travada no `init --locale <id>`. Ausente/inválido = `pt-BR`
(retrocompat total). Locales: `pt-BR`, `en`. Parsers são bilíngues sempre
(`Requisito|Requirement`, `mata mutante|kill mutant`, seções do CORE em qualquer dos dois
conjuntos completos); só a RENDERIZAÇÃO segue o locale. Vault existente nunca é renomeado.

## Taxonomia da vault
Pastas por locale (+ `Templates` e `.brain`):
- `pt-BR`: `00-Inbox 01-Projeto 02-Sessões 03-Linear 04-Decisões 05-Bugs 06-Aprendizados 07-Specs 08-Mudanças`
- `en`: `00-Inbox 01-Project 02-Sessions 03-Linear 04-Decisions 05-Bugs 06-Learnings 07-Specs 08-Changes`
Meses: `01-JAN…12-DEZ` (pt) / `01-JAN…12-DEC` (en).

## AGENTS.md (v1.2) — canal agent-agnostic
`wendkeep sync-defs` (e o `init`) mantêm uma seção gerenciada em `<project>/AGENTS.md`
entre `<!-- wendkeep:skills:start -->` e `<!-- wendkeep:skills:end -->`: o loop resumido +
o inventário das skills. Só o miolo entre marcadores é regravado; o resto do arquivo é do
usuário. Cobre Codex/Amp/Cursor/Zed e todo agente que leia AGENTS.md.

## Sensor — `wendkeep.sensors.json` (raiz do projeto)
```json
{
  "version": 1,
  "sensors": [
    { "id": "tests", "name": "Tests", "description": "npm test",
      "severity": "critical", "command": "npm test", "type": "command" }
  ]
}
```
- `severity`: `critical` (trava o gate) | `warning` (advisory, não trava).
- `type`: `command` (default) | `mutation` (delega à ferramenta + parseia o report) | `verifier` *(futuro)*.
- `report` (só `type: mutation`): caminho do relatório mutation-testing-elements (Stryker et al.),
  relativo ao root do projeto. `verify` extrai mutantes `Survived`/`NoCoverage` e anexa fix-tasks
  na change ativa: `- [ ] M.<n> mata mutante <file>:<line> (<mutator>) [sensor:<id>]` (bounded, teto 3).
- Roda no root do projeto; `exit 0` = verde.

## Requisito — `07-Specs/<capability>.md` (spec vivo)
```markdown
### Requisito: GATE-1 — archive trava sem sensor crítico verde
(comportamento / cenários)
```
- ID = `^[A-Z][A-Z0-9]*-\d+$` (ex.: `GATE-1`, `AUTH-2`). **Identidade = o ID**; ` — <nome>` é display.
- Heading sem ID (`### Requisito: <nome>`) é válido (retrocompat); identidade cai pro nome.

## Delta de spec — `08-Mudanças/<slug>/specs/<capability>/spec.md`
```markdown
## ADDED Requirements
### Requisito: GATE-2 — novo requisito
...
## MODIFIED Requirements
### Requisito: GATE-1 — texto novo
...
## REMOVED Requirements
### Requisito: GATE-3 — a remover
```
No `archive`, funde no spec vivo (ADDED/MODIFIED = upsert por ID; REMOVED = deleta).

## Tarefa — `tarefas.md`
```markdown
- [ ] 3.2 implementa o bloqueio [req:GATE-1] [sensor:tests]
```
- `[req:<ID>]` — o requisito que a tarefa satisfaz. `[sensor:<id>]` — a prova automatizada.
- Ambos opcionais; a ordem no fim da linha é livre.

## Proposta — `08-Mudanças/<slug>/proposta.md` (frontmatter)
```yaml
type: change
status: active
specs: [gate, auth]     # capabilities cujos deltas serão promovidos
source: ["[[02-Sessões/…]]"]
```

## Pacote de verificação — `08-Mudanças/<slug>/verificacao.json`
Escrito por `wendkeep verify --deep`; consumido pela skill `wk-verify`.
```json
{ "slug": "x", "tasksHash": "a1b2c3d4e5f6",
  "requirements": [{ "id": "GATE-1" }],
  "tasks": [{ "id": "3.2", "text": "...", "req": "GATE-1", "done": false }],
  "sensors": [{ "id": "tests", "status": "green", "severity": "critical" }] }
```
`tasksHash` = sha1 curto de `tarefas.md` — o selo de frescor. A skill copia pro verdict.

## Veredito — `08-Mudanças/<slug>/verdict.json`
Escrito pela skill `wk-verify` (autor≠verificador). O gate do `archive` exige `ok:true`
cobrindo todo `[req:]` declarado.
```json
{ "slug": "x", "ok": true,
  "coverage": [{ "req": "GATE-1", "covered": true, "evidence": "tests/gate.test.mjs:42" }],
  "tasksHash": "a1b2c3d4e5f6",
  "notes": [] }
```
Change sem `[req:]` = trivial: `verify --deep` auto-escreve o verdict; o gate passa pelo sensor.
`tasksHash` divergente do `tarefas.md` atual = verdict **stale**, gate bloqueia (verdicts
pré-0.6.1 sem o campo são aceitos). O gate também bloqueia **tarefas abertas** (`- [ ]`,
inclui fix-tasks `M.n`); escape explícito: `change archive --force`.

## Skill — `.brain/skills/<name>/SKILL.md`
```markdown
---
name: <name>
description: <quando usar — usado pra roteamento>
---
<corpo>
```
Distribuída por `wendkeep sync-defs` (e pelo `init`) pra `.claude/skills/<name>/`.

## Lesson — `.brain/lessons/[<data>-]<slug>.md`
Falha de verificação destilada em lição project-local, injetada como bloco `<lessons>` no
SessionStart (as N mais recentes). Escrita por `wendkeep lesson add "<trigger>" "<lesson>"`.
```yaml
type: lesson
trigger: "<gatilho>"
source: <slug da change>
date: <YYYY-MM-DD>
```
Corpo = a lição (a 1ª linha é o que entra na injeção).

---
*harness contract v1.2 — wendkeep 0.8.0. Mudança de formato = major ou nota de migração no CHANGELOG.*
