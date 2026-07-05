# 10 — Harness a2 nativo no wendkeep (spec de design)

> Deriva do ADR-019 do NutriGym (`.NutriGymBrain/04-Decisões/2026/07-JUL/DIA 05/ADR-019-openspec-primaria-dotcontext-gate.md`) — arquitetura **a2** provada e pilotada. Este doc porta o a2 pro **pacote wendkeep**, reimplementado **nativo (zero dep externa)**.

## Context (porquê)

wendkeep é um harness com memória persistente (vault Obsidian + `.brain`). O núcleo de memória está pronto. Falta a camada de **execução dirigida por spec**: o que o OpenSpec (spec/mudança), o dotcontext (gate de evidência) e o superpowers (disciplina) fazem de melhor. O ADR-019 do NutriGym já resolveu a composição (opção a2): **OpenSpec primária + dotcontext gate + superpowers disciplina**. Aqui reimplementamos isso **nativo** no wendkeep — sem depender de `@fission-ai/openspec` nem `@dotcontext` — para que `wendkeep init` monte o harness completo em qualquer projeto, com **tudo no vault** (planos↔sessões↔decisões wikilinkados = grafo Obsidian vivo).

Decisões do usuário (fechadas nesta sessão):
- Reimplementar **nativo, zero dep externa**.
- **Tudo no vault** — motivo: ver no grafo Obsidian os links plano↔sessão↔decisão.
- **Change ativa injetada no SessionStart** (brain-inject) — retoma trabalho-em-curso.
- context-mode / understand-anything / caveman = **camada opt-in**. dotcontext **sai de companion default** (o gate é reimplementado nativo).

## Arquitetura (o loop)

```
/wk:explore → /wk:propose → /wk:apply (TDD por task) → /wk:verify (gate) → wendkeep change archive
```

| Papel | Native no wendkeep |
|---|---|
| **O QUÊ** (spec/mudança, OpenSpec-like) | `08-Mudanças/<slug>/{proposta,design,tarefas}.md` + contrato `07-Specs/` |
| **O COMO** (disciplina, superpowers-like) | skills embarcadas: TDD, systematic-debugging, verification-before-completion, subagent-driven-development, requesting-code-review |
| **A PROVA** (gate, dotcontext-like) | `wendkeep verify` roda `sensors.json` → evidência → `gate` trava `archive` sem sensor crítico verde |
| **MEMÓRIA** (wendkeep) | vault + `.brain`; archive promove ADR→`04-Decisões`; change ativa injetada no SessionStart |

**3 níveis de verificação (defesa em profundidade):** `verification-before-completion` (soft, prompt) + `/wk:verify` (soft) + evidence gate (HARD, único que trava o archive).

## Decomposição (3 pilares, build B→C→A)

Cada pilar = spec+plan próprio. C engancha em B (gate no archive, via interface); A dirige B+C (prompts).

- **B — Change/spec lifecycle** (espinha) — detalhado abaixo.
- **C — Verify + evidence gate** — resumo abaixo (spec própria depois).
- **A — Skills nativas + init wiring** — resumo abaixo (spec própria depois).

---

## Pilar B — Change/spec lifecycle (DETALHADO)

### Layout no vault (novas pastas em `VAULT_FOLDERS`)

```
07-Specs/<capability>.md              contrato vivo (requisitos/cenários por capacidade)
08-Mudanças/<slug>/
    proposta.md                        porquê + o que muda (frontmatter + wikilinks)
    design.md                          abordagem técnica
    tarefas.md                         checklist numerado `- [ ] 1.1 ...`
    evidencia.json                     (Pilar C) resultado dos sensores
08-Mudanças/_arquivo/<AAAA-MM-DD>-<slug>/   change concluída (movida no archive)
```

Frontmatter da `proposta.md` (exemplo):
```yaml
type: change
status: active            # draft | active | done
date: 2026-07-05
cssclasses: [topic-change]
tags: [mudanca, claude]
source: "[[02-Sessões/2026/07-JUL/DIA 05/HH-MM-<slug>]]"   # sessão de origem (grafo)
specs:  ["[[07-Specs/<capability>]]"]                       # spec(s) afetada(s) (grafo)
```

### Comandos (CLI, `bin/wendkeep.mjs`)

- `wendkeep change new <slug>` — scaffold das 3 notas com frontmatter + **wikilink pra sessão atual** (lê `.brain/CURRENT_SESSION`). Marca `status: active`, grava ponteiro `.brain/CURRENT_CHANGE.md`.
- `wendkeep change list` — lista ativas + arquivadas (lê status).
- `wendkeep change show <slug>` — imprime tarefas + status (o `apply` em si é dirigido pela skill `/wk:apply`, que implementa; CLI não implementa).
- `wendkeep change archive <slug>` — chama `gate(changeDir)`; se verde: move pra `_arquivo/<data>-<slug>/`, promove deltas de spec pra `07-Specs/`, grava **ADR em `04-Decisões`** (reusa `getNextAdrNumber` + builder de ADR do `linked-notes.mjs`) wikilinkando `[[change]]`+`[[sessão]]`, limpa `CURRENT_CHANGE`.

### Seam do gate (fronteira B↔C)

`archive` chama `gate(changeDir) → { ok, failing[] }`. **Em B sozinho:** `gate` é stub que retorna `{ ok: true }`. **Pilar C** substitui pela checagem real (roda sensores, lê `evidencia.json`). Interface pura = B e C independentes/testáveis.

### Conectividade de grafo (requisito de 1ª classe)

- `proposta` linka `source` (sessão) + `specs`.
- Archive: ADR linka `[[change]]`+`[[sessão]]`; `07-Specs/<cap>` linka as changes que a tocaram.
- **session-stop** ganha linha `Change ativa: [[08-Mudanças/<slug>/proposta]]` quando há change ativa → **sessão↔change bidirecional** no grafo.
- Cores: `topic-change`/`topic-spec` no `vault-theme` (paleta tem teal/amber livres) + graph color groups pras 2 pastas novas.

### Integração brain-inject (SessionStart)

`brain-inject` passa a incluir bloco **Change ativa** (budget ≤10 linhas): nome, `status`, **tarefas abertas** (`- [ ]` de `tarefas.md`), link pra proposta. Fonte = ponteiro `.brain/CURRENT_CHANGE.md`. Assim o agente retoma sabendo o que falta. Estende `buildInjection` (ou builder novo `buildActiveChangeInjection`).

### Unidades puras (testável, TDD)

- `renderChangeScaffold({slug, sessionRel, date})` → conteúdo das 3 notas.
- `parseTasks(tarefasMd)` → `[{id, text, done, sensor?}]`.
- `archiveChange(vaultBase, slug, {gate, now})` → move+promove+ADR (fs; `gate`/`now` injetados).
- `buildActiveChangeInjection(vaultBase)` → bloco do SessionStart.
- `activeChange(vaultBase)` / `setActiveChange` → ponteiro `.brain/CURRENT_CHANGE.md`.

### Mudanças no `init`

- `VAULT_FOLDERS += ['07-Specs', '08-Mudanças']`.
- Seed: `07-Specs/README`, `Templates/Change.md` (template).
- Skills install = Pilar A.

---

## Pilar C — Verify + evidence gate (RESUMO)

- `wendkeep verify [--change <slug>]` — lê `sensors.json` (já semeado pelo dotcontext-seed), roda os sensores mapeados às tarefas, grava `08-Mudanças/<slug>/evidencia.json` (`{sensor, status, ts}`).
- `gate(changeDir)` (implementa o seam do B) → lê `evidencia.json`; `ok=false` se algum sensor **crítico** exigido está vermelho/ausente. Único HARD gate (trava `archive`).
- Mapa task→sensor: hint `sensor:` na tarefa, ou default por stack (typecheck/test/lint/build detectados) — reusa `renderSensorsJson` do `dotcontext-seed`.
- Puro/testável: `runSensors` (mock comandos), `evaluateGate(evidence, required)`.

## Pilar A — Skills nativas + init (RESUMO)

- Embarca `hooks/skills/` ou `skills/wk-*/SKILL.md`: `/wk:explore` (desloca brainstorming), `/wk:propose` (desloca writing-plans), `/wk:apply`, `/wk:verify` + cópias das superpowers sobreviventes (TDD, systematic-debugging, verification-before-completion, subagent-driven-development, requesting-code-review).
- `init` instala em `.claude/skills/wk-*` + slash `.claude/commands/wk/*` (mecânica já provada no sync-defs) + doutrina em `AGENTS.md`/README do vault.
- Testável: conteúdo (render) + file-writing do install.

---

## Questões em aberto (revisar)

1. **Multi-change simultânea:** MVP = 1 change ativa (ponteiro único). Suportar N ativas depois? (afeta brain-inject + `CURRENT_CHANGE`).
2. **`07-Specs` vs deltas na change:** o contrato vive em `07-Specs/` e a change edita lá no archive, OU a change carrega `specs/` próprio e o archive faz merge? (MVP: change referencia `07-Specs`; archive faz o merge do delta).
3. **Nome PT `08-Mudanças`** com acento/ç — OK no FS/Obsidian (já usamos `02-Sessões`/`04-Decisões`). Confirmar.
4. **`apply` CLI vs só-skill:** MVP = `apply` é a skill `/wk:apply` (agente implementa); CLI só `show`. Precisa de CLI `apply`?

## Verificação (Pilar B end-to-end)

1. `wendkeep change new x` cria `08-Mudanças/x/{proposta,design,tarefas}.md` com wikilink pra sessão + `CURRENT_CHANGE` apontando `x`.
2. brain-inject num SessionStart de teste injeta o bloco "Change ativa: x" com as tarefas abertas.
3. `wendkeep change archive x` (gate stub ok) move pra `_arquivo/`, grava ADR em `04-Decisões` wikilinkando `[[x]]`+sessão, limpa `CURRENT_CHANGE`.
4. Grafo Obsidian mostra sessão—change—ADR conectados.
5. `npm test` (node --test) verde; unidades puras cobertas (scaffold/parseTasks/archive/inject).
