# Wave A — Credibilidade (spec de design)

> Primeira wave do programa [12](12-camada-verificacao-tlc.md). Torna o gate confiável.
> Decisões travadas: **Q1=A** (req-ID no título), **Q2=B** (pacote + `verdict.json`, gate
> exige), **Q3=delegar** (Wave B), **Q4=A** (archive sempre exige `verdict.ok`).
> Isto é design — o plano TDD vem depois de revisado.

## Objetivo
O agente não consegue arquivar uma change sem que um **passe de verificação independente**
tenha re-derivado a cobertura do spec e assinado um veredito. Rastro `req → task → verdict
→ ADR`. Quase tudo na camada de skill; o enforcement é mecânico (gate exige `verdict.json`).

## Peças

### 1. Requirement IDs + rastreabilidade (código)
**Formato (contrato):** no spec vivo `07-Specs/<cap>.md`:
```markdown
### Requisito: GATE-1 — archive trava sem sensor crítico verde
(corpo / cenários)
```
- ID = `^[A-Z][A-Z0-9]*-\d+$` (ex.: `GATE-1`, `AUTH-2`). Identidade = o ID; ` — <nome>` é display.
- **`spec-core.parseRequirements`** passa a extrair `{ id, name, body }`. Retrocompat: heading
  sem ID (`### Requisito: <nome>`) → `id: null`, identidade cai pro nome (specs 0.4.0 seguem válidos).
- **Delta** (ADDED/MODIFIED/REMOVED) casa por ID quando presente, senão por nome.
- **Tarefa → requisito:** em `tarefas.md`, hint `[req:<ID>]` (mesmo padrão do `[sensor:]`):
  ```
  - [ ] 3.2 implementa o bloqueio [req:GATE-1] [sensor:tests]
  ```
  `change-core.parseTasks` ganha `task.req`.
- **ADR** no archive lista os IDs tocados: `Requisitos: [[07-Specs/gate|GATE-1]], …`.

### 2. `verify --deep` + veredito (código + skill)
Fluxo (Q2=B — o CLI **monta**, a skill **julga**, o gate **exige**):
```
verify --deep ──▶ <change>/verificacao.json ──wk-verify(skill, contexto fresco)──▶ <change>/verdict.json ──gate exige──▶ archive
```
- **`wendkeep verify --deep [--change s]`** monta o *pacote* `verificacao.json`:
  `{ slug, generatedAt, requirements:[{id,name}], tasks:[{id,text,req,done}], sensors:[…evidência…] }`.
  Não julga — empacota. Reconciliação com Q4/auto-sizing: se a change **não tem nenhum
  `[req:]`** e todos os sensores estão verdes, o CLI **auto-escreve um verdict trivial**
  (`ok:true, coverage:[]`) — trivial não exige passe do agente. Com req, exige.
- **Skill `wk-verify`** (contexto fresco, autor≠verificador): lê `verificacao.json`, re-deriva
  a cobertura do `07-Specs`, faz o outcome check ancorado no spec, grava
  `verdict.json`: `{ slug, ok, verifiedAt, coverage:[{req, covered:bool, evidence:"file:line"}], notes:[] }`.
- **Testes / não-agente:** os testes escrevem `verdict.json` direto (simulam o passe).

### 3. Gate exige veredito (Q4=A — sempre) (código)
`archiveChange` ganha uma checagem **além** do gate de sensor (compõem — os dois têm que passar):
- `verdict.json` existe e `ok:true`; senão bloqueia: *"rode `wendkeep verify --deep` + skill `wk-verify`."*
- **Completude/frescor:** `coverage` cobre **todo** `[req:ID]` declarado pelas tarefas da change.
  Requisito adicionado depois do veredito → cobertura não bate → bloqueia (força re-verificar).
- Trivial (zero req) → o verdict auto-escrito (peça 2) satisfaz. Sem brecha, atrito mínimo.

### 4. Skills TLC-grade (conteúdo)
- **`wk-tdd`** (reescrever): assertions derivadas do spec (não de ler o código); litmus
  não-raso (rejeita asserção que passa sob impl errada; afirma valor/estado, não "mock chamado");
  Test Adequacy (todo critério coberto com evidência file:line; todo teste rastreia um requisito);
  test-learning (amostra 5–10 testes existentes; lê `AGENTS.md`/`.cursor/rules`/CI pros padrões).
- **`wk-brainstorming`** (reescrever): closure gate (toda ambiguidade resolvida com o usuário
  ou logada como assumption assinada; cinzas declinados são registrados) + tabela out-of-scope.
- **`wk-verify`** (nova): a disciplina do verificador independente — passe fresco read-only,
  autor≠verificador, re-deriva cobertura do spec, escreve `verdict.json`. No Claude pode
  spawnar sub-agente (isolamento real); nos outros, passe disciplinado em contexto limpo.
- **`wk-workflow`** (ajustar): o loop ganha `verify --deep` + `wk-verify` antes do archive.

### 5. Contrato v1 (`docs/14-harness-contract.md`)
Extrai os formatos como referência de extensão: sensor (`type: command|mutation|verifier`),
req-ID, `[req:]`/`[sensor:]`, spec delta, SKILL.md, `verificacao.json`, `verdict.json`, lesson.

## Módulos tocados
- `hooks/spec-core.mjs` — parse de req-ID no heading; identidade por ID.
- `hooks/change-core.mjs` — `parseTasks` ganha `req`; `archiveChange` exige verdict + lista IDs no ADR.
- `src/verify.mjs` (ou novo `src/verify-deep.mjs`) — `--deep`: monta `verificacao.json`, auto-verdict trivial.
- `src/change.mjs` — CLI expõe `verify --deep`; mensagem de bloqueio do gate de verdict.
- `src/skills-seed.mjs` — reescreve wk-tdd/wk-brainstorming, adiciona wk-verify, ajusta wk-workflow.
- `docs/14-harness-contract.md` — novo.

## Contratos de dados (resumo)
```
verificacao.json: { slug, generatedAt, requirements:[{id,name}], tasks:[{id,text,req,done}], sensors:[{id,status,severity}] }
verdict.json:     { slug, ok:bool, verifiedAt, coverage:[{req, covered:bool, evidence}], notes:[] }
```

## Verificação de aceite (Wave A)
1. Spec com `### Requisito: GATE-1 — …`; tarefa `[req:GATE-1]`; `parseTasks().req == "GATE-1"`.
2. `verify --deep` numa change com req → escreve `verificacao.json` (sem verdict).
3. `archive` sem `verdict.json` → **bloqueia**. Com `verdict.json ok:true` cobrindo GATE-1 → passa; ADR lista GATE-1.
4. Change trivial (zero req, sensores verdes) → `verify --deep` auto-escreve verdict → `archive` passa.
5. Skills reescritas presentes em `.claude/skills` (wk-tdd/brainstorming/verify), `wk-workflow` cita `verify --deep`.
6. `docs/14-harness-contract.md` publicado. Suíte verde.

## Perguntas fechadas
Q1=A, Q2=B, Q3=delegar(Wave B), Q4=A. Sem pendências pra começar o plano.
