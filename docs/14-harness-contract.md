# Harness contract v1 — pontos de extensão

Os formatos que o harness do wendkeep lê/escreve. Quem estende (novos sensores, specs,
skills, integrações) mira **este contrato**, não o código. Estável dentro do major.
Itens marcados *(Wave B)* ainda não implementados.

## Taxonomia da vault
Pastas (PT-BR, hardcoded nos hooks): `00-Inbox 01-Projeto 02-Sessões 03-Linear 04-Decisões
05-Bugs 06-Aprendizados 07-Specs 08-Mudanças Templates .brain`.

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
- `type`: `command` (default) | `mutation` *(Wave B — delega à ferramenta do usuário)* |
  `verifier` *(Wave B)*.
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
{ "slug": "x", "requirements": [{ "id": "GATE-1" }],
  "tasks": [{ "id": "3.2", "text": "...", "req": "GATE-1", "done": false }],
  "sensors": [{ "id": "tests", "status": "green", "severity": "critical" }] }
```

## Veredito — `08-Mudanças/<slug>/verdict.json`
Escrito pela skill `wk-verify` (autor≠verificador). O gate do `archive` exige `ok:true`
cobrindo todo `[req:]` declarado.
```json
{ "slug": "x", "ok": true,
  "coverage": [{ "req": "GATE-1", "covered": true, "evidence": "tests/gate.test.mjs:42" }],
  "notes": [] }
```
Change sem `[req:]` = trivial: `verify --deep` auto-escreve o verdict; o gate passa pelo sensor.

## Skill — `.brain/skills/<name>/SKILL.md`
```markdown
---
name: <name>
description: <quando usar — usado pra roteamento>
---
<corpo>
```
Distribuída por `wendkeep sync-defs` (e pelo `init`) pra `.claude/skills/<name>/`.

## Lesson *(Wave B)* — `.brain/lessons/<slug>.md`
Falha de verificação destilada em lição project-local, auto-injetada no próximo change.

---
*harness contract v1 — wendkeep 0.5.0. Mudança de formato = major ou nota de migração no CHANGELOG.*
