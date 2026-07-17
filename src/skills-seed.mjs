// src/skills-seed.mjs — native, zero-dep process skills (Pilar A: the HOW layer).
// Seeded into the vault's .brain/skills; distributed by `wendkeep sync-defs` to
// .claude/skills + .agents/skills. Wendkeep-flavored, concise native prose.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A skill is a SKILL.md plus optional bundled files (templates/prompts) that ship in the same
// folder and are delivered together by `wendkeep sync-defs` (cpSync of the whole dir). The
// SKILL.md references them; the model reads them on demand — depth without bloating SKILL.md.
function skill(name, description, body, files = []) {
  return { name, description, body: `---\nname: ${name}\ndescription: ${description}\n---\n${body}`, files };
}

const WORKFLOW = `# Loop a2 — o ciclo de trabalho do wendkeep

Use ao começar qualquer mudança não-trivial. O loop mantém memória (vault) e prova
(sensores) juntas, tudo linkado no grafo do Obsidian.

<HARD-GATE>
NÃO edite arquivos de código antes do passo 2 (Propose / \`wendkeep change new\`).
Toda tarefa não-trivial passa pelo loop — planejar no chat e sair editando deixa o
vault cego. Exceção única: mudança trivial (typo, 1 linha).
</HARD-GATE>

## Os passos

1. **Explore** — entenda o problema antes de propor. Leia o código/contexto relevante.
2. **Propose** — \`wendkeep change new <slug>\`. Isso cria \`08-Mudanças/<slug>/\` com:
   - \`proposta.md\` — *por quê* e *o que muda* (o WHAT).
   - \`design.md\` — a abordagem técnica.
   - \`tarefas.md\` — a lista de tarefas \`- [ ] N.N descrição\`.
   A mudança vira a *atual* (ponteiro global \`.brain/CURRENT_CHANGE.md\`). Podem existir
   várias changes abertas: hooks e \`change list/status\` mostram todas as pendências; comandos
   sem \`--change\` usam somente a atual.
   Antes de implementar, resolva \`spec_impact\` na proposta:
   - \`required\`: liste a capability em \`specs:\` e preencha
     \`specs/<capability>/spec.md\` com ADDED/MODIFIED/REMOVED; ligue tarefas com \`[req:ID]\`.
     Heading de requisito: \`### Requisito: <ID> — <nome>\` (ou só \`### Requisito: <ID>\`);
     o ID é a identidade (ex.: \`GATE-1\`, \`API-AUTH-2\`).
   - \`none\`: registre uma justificativa real em \`spec_impact_reason\`.
   \`pending\` nunca é estado pronto para implementação ou archive.
3. **Apply** — implemente cada tarefa de \`tarefas.md\` com disciplina **wk-tdd**
   (teste vermelho antes do código). Marque \`- [x]\` ao concluir. Declare nas tarefas:
   - \`[sensor:<id>]\` — a prova automatizada (roda no verify).
   - \`[req:<ID>]\` — o requisito do spec que a tarefa satisfaz (ex.: \`[req:GATE-1]\`),
      quando a change mexe numa capability. Uma tarefa pode declarar vários
      \`[req:]\` — todos contam na cobertura. Toda autoria de spec ocorre somente em
      \`08-Mudanças/<slug>/specs/<capability>/spec.md\`; \`07-Specs\` é gerado/read-only.
   Ex.: \`- [ ] 2.1 valida CORE [req:MEM-1] [req:MEM-2] [sensor:memory-validation]\`.
4. **Verify** — \`wendkeep verify\` roda os sensores → \`evidencia.json\`. Depois
   \`wendkeep verify --deep\` monta o *pacote de verificação* pro passe independente.
5. **Verify deep** — a skill **wk-verify** (passe fresco, autor≠verificador) lê o pacote,
   usa somente os requisitos autocontidos de \`verificacao.json\` e grava \`verdict.json\`. Change trivial (sem
   \`[req:]\`) recebe verdict automático — pula este passe.
6. **Archive** — \`wendkeep change archive <slug>\`. O *gate* exige sensores verdes **E**
   \`verdict.json\` cobrindo os \`[req:]\`. Passando, promove os deltas pro \`07-Specs\`,
   move a change pro \`_arquivo\` e gera um ADR em \`04-Decisões/\`.

## Regras

- Várias changes podem ficar abertas. \`CURRENT_CHANGE.md\` marca uma atual, sem esconder as
  outras pendências. Claude, Codex ou outro agente assumem uma change existente com
  \`wendkeep change use <slug>\` ou \`--change <slug>\` quando disponível.
- Se uma tarefa não precisa de prova automatizada, não declare sensor — o gate só exige
  o que você declarou. Sem \`[sensor:]\`, o archive não trava.
- A proposta linka a sessão de origem; a sessão linka a mudança ativa. É de propósito:
  o grafo do Obsidian mostra plano↔sessão↔decisão.
`;

const TDD = `# TDD — Red, Green, Refactor (testes que discriminam)

Use ao implementar qualquer comportamento. Nunca escreva código de produção sem um teste
vermelho pedindo por ele — e nunca escreva um teste que passaria sob a implementação errada.

## O ciclo

1. **Red** — o menor teste que falha por faltar o comportamento.
2. **Rode e veja falhar** — pelo motivo certo (não import/typo). Teste que nunca falhou não prova nada.
3. **Green** — o código mínimo pra passar.
4. **Refactor** — limpe com os verdes te protegendo.

## Derive do spec, não do código

Escreva a asserção a partir do *critério de aceite* da spec efetiva
(\`wendkeep spec effective --change <slug>\`), não lendo a
implementação. Cada asserção mira o resultado que o spec definiu. Escrever o teste lendo o
código = ele só confirma o que o código já faz, bugs inclusos.

## Litmus não-raso

Rejeite asserção que passaria sob uma implementação errada. Afirme **valor ou estado
persistido**, nunca "o mock foi chamado". "Testado depois" é rejeitado — o teste nasce
junto com o código da tarefa.

## Adequação (necessário e suficiente)

- Todo critério de aceite tem uma asserção — com evidência \`arquivo:linha\`.
- Todo teste rastreia um requisito (\`[req:ID]\`). Teste sem requisito = escopo à toa.
- Nem raso, nem inflado: cobre o que o spec pede, nada além.

## Aprende o projeto

Antes de escrever, amostre 5–10 testes existentes: estilo, localização, framework,
profundidade por camada — trate essa profundidade como *piso*, nunca teto. Leia
\`AGENTS.md\` / \`.cursor/rules\` / configs de CI pros padrões declarados.

## Regras

- Um comportamento por teste; o nome descreve o comportamento, não a implementação.
- Bug encontrado = primeiro o teste que o reproduz (vermelho), depois a correção.
`;

const DEBUGGING = `# Depuração sistemática

Use quando algo falha, quebra ou dá resultado errado. Uma hipótese por vez — não saia
mudando coisas no escuro.

## O método

1. **Reproduza** — um caso mínimo e determinístico que dispara a falha. Sem repro
   confiável, você não sabe se corrigiu.
2. **Uma hipótese** — a causa mais provável, específica o suficiente pra testar.
3. **Isole** — confirme ou descarte a hipótese ANTES de corrigir: bisect, log no ponto
   suspeito, comente metade. Prove onde está, não onde você acha que está.
4. **Corrija a raiz** — o defeito real, não o sintoma. Se só some o sintoma, você não
   entendeu a causa.
5. **Verifique** — o repro do passo 1 sumiu E a suíte segue verde. Sem regressão.

## Regras

- Mudou várias coisas de uma vez e "consertou"? Você não sabe o que consertou. Reverta,
  isole uma variável por vez.
- Leia a mensagem de erro inteira e a stack — a linha decisiva costuma estar ali.
- "Não faz sentido" = uma suposição sua está errada. Cheque as suposições, não o improvável.

## Registro no vault

Bug com valor durável vira nota numerada: \`wendkeep note new --type bug "resumo"\` —
cria \`BUG-NNNN-<slug>.md\` na pasta do mês de \`05-Bugs\` (nunca subpasta \`DIA N\`) e
imprime o path pra você preencher sintoma/causa raiz/correção. Aprendizado extraído do
debug: \`wendkeep note new --type learning "lição"\` (vira \`APR-NNNN-\` em \`06-Aprendizados\`).
`;

const BRAINSTORMING = `# Brainstorming — ideia vira design

Use quando a ideia ainda é vaga. Transforme-a num design aprovado ANTES de escrever
qualquer código.

## Como

1. **Explore o contexto** — arquivos, docs, histórico relevante.
2. **Pergunte uma coisa por vez** — propósito, restrições, critério de sucesso. Prefira
   múltipla escolha. Não despeje dez perguntas juntas.
3. **Proponha 2–3 abordagens** — com trade-offs e sua recomendação primeiro.
4. **Apresente o design em seções** — escale ao tamanho do problema; confirme cada seção.

## Closure gate — nada de ambiguidade solta

Antes de fechar o design, resolva cada zona cinza: decide com o usuário, ou registra como
**assumption assinada** ("assumo X porque Y — corrija se errado"). Cinza declinado pelo
usuário é *registrado*, não descartado no silêncio. Nada sai do design silenciosamente ambíguo.
Declare também a capability e se o design tem \`spec_impact: required\` ou \`none\`.

## Tabela out-of-scope

Liste explicitamente o que a mudança **não** faz. Escopo não declarado vira creep; a tabela
é o contrato do que ficou de fora — e base pra próxima change.

## Gate rígido

NÃO escreva código, scaffold nem tome ação de implementação até apresentar um design e o
usuário aprovar. Vale pra TODO projeto, por mais simples que pareça — "simples demais pra
precisar de design" é onde suposições não-checadas mais custam. O design pode ser curto,
mas tem que existir e ser aprovado.

Ao aprovar, o próximo passo é **wk-planning** (design → plano). Não pule pra implementação.

## Template
Use o \`design-template.md\` (nesta pasta da skill) pra estruturar o design (contexto, abordagens,
decisões assinadas, tabela out-of-scope, aceite).
`;

const PLANNING = `# Planejamento — design vira plano de tarefas

Use depois de um design aprovado. Produza um plano que um dev sem contexto do projeto
consiga executar.

## Antes das tarefas

Mapeie os arquivos: quais criar/modificar e a responsabilidade de cada um. Arquivos que
mudam juntos ficam juntos; um arquivo, uma responsabilidade. É aqui que a decomposição
trava.

Resolva o contrato antes de decompor: \`spec_impact: required\` exige capability + delta real em
\`specs/<capability>/spec.md\`; \`spec_impact: none\` exige justificativa. Cada comportamento do
delta recebe ID e as tarefas correspondentes usam \`[req:ID]\`.

## Tarefas bite-sized (TDD)

Cada tarefa termina num entregável testável de forma independente. Cada passo é uma ação
de 2–5 min:

- Escreva o teste que falha (mostre o código do teste).
- Rode e veja falhar (comando exato + saída esperada).
- Implementação mínima (mostre o código).
- Rode e veja passar.
- Checkpoint: suíte verde.

## Regras

- Caminhos de arquivo exatos, sempre. Código real em cada passo — nada de "TODO",
  "tratar erros apropriadamente", "similar à Task N".
- DRY, YAGNI. Corte features que o design não pediu.
- Nomes/assinaturas consistentes entre tarefas (uma função é \`x()\` em toda parte).

## Template
Comece do \`plan-template.md\` (nesta pasta da skill) — a estrutura de arquivos + tarefas TDD.
`;

const VERIFY = `# Verificação independente — o passe fresco

Use no passo *verify deep* do loop, depois de \`wendkeep verify --deep\`. Você é o
**verificador**, não o autor — mesmo tendo escrito o código, entre neste passe como se
nunca tivesse visto a implementação. Contexto fresco, read-only.

## O que fazer

1. Leia o pacote \`08-Mudanças/<slug>/verificacao.json\` (requisitos, tarefas, evidência).
2. **Re-derive a cobertura do pacote autocontido** — pra cada requisito completo em
   \`verificacao.json\`, cheque se o comportamento está coberto por um teste que discrimina (não
   passaria sob impl errada). Evidência \`arquivo:linha\`.
3. Outcome check ancorado no spec: o resultado observável bate com o critério de aceite?
4. Grave \`08-Mudanças/<slug>/verdict.json\`:
   \`{ "slug": "...", "ok": true, "coverage": [{ "req": "GATE-1", "covered": true, "evidence": "arquivo:linha" }], "tasksHash": "<copie do verificacao.json>", "effectiveSpecHash": "<copie do verificacao.json>", "notes": [] }\`.
   \`tasksHash\` e \`effectiveSpecHash\` vêm do pacote — são selos de frescor; sem eles (ou com tarefas/spec alteradas
   depois), o gate rejeita o verdict como stale.

## Regras

- **Autor ≠ verificador.** No Claude, spawn um sub-agente read-only pra este passe
  (isolamento real). Nos outros, entre num contexto limpo e re-derive do spec, não da memória.
- \`ok: false\` se algum requisito não tem cobertura que discrimina. Gap não é "quase lá" — é vermelho.
- Não conserte aqui. Gap vira tarefa de correção na change; re-verifica depois.
- O gate do \`archive\` **exige** \`verdict.json\` com \`ok\` cobrindo todo \`[req:]\`. Sem isso, não arquiva.

## Templates (nesta pasta)
- \`spec-reviewer-prompt.md\` — cole ao spawnar o subagente verificador (read-only, autor≠verificador).
- \`verdict-template.json\` — o formato exato do \`verdict.json\` a gravar.
`;

const WORKFLOW_EN = `# The a2 loop — wendkeep's work cycle

Use it when starting any non-trivial change. The loop keeps memory (vault) and proof
(sensors) together, wikilinked in the Obsidian graph.

<HARD-GATE>
Do NOT edit code files before step 2 (Propose / \`wendkeep change new\`).
Every non-trivial task goes through the loop — planning in chat and editing right away
leaves the vault blind. Single exception: a trivial change (typo, one line).
</HARD-GATE>

## Steps

1. **Explore** — understand the problem before proposing.
2. **Propose** — \`wendkeep change new <slug>\` scaffolds \`08-Changes/<slug>/\`
   (proposta/design/tarefas + a \`specs/\` delta). The change becomes *current* through global
   \`.brain/CURRENT_CHANGE.md\`. Multiple changes may stay open; hooks and \`change list/status\`
   show every pending task, while commands without \`--change\` use only the current change.
   Before implementation, resolve \`spec_impact\`: \`required\` needs the capability listed in
   \`specs:\` plus a real \`specs/<capability>/spec.md\` delta and \`[req:ID]\` links; \`none\`
   needs a real \`spec_impact_reason\`. \`pending\` is never ready for implementation/archive.
   Requirement heading: \`### Requirement: <ID> — <name>\` (or bare \`### Requirement: <ID>\`);
   the ID is the identity (e.g. \`GATE-1\`, \`API-AUTH-2\`).
3. **Apply** — implement each task in tarefas.md with **wk-tdd** (red test first). Tag tasks:
   \`[sensor:<id>]\` (automated proof) and \`[req:<ID>]\` (the spec requirement it satisfies;
   a task may declare several \`[req:]\` tags — all of them count toward coverage).
   Author specs only in \`08-Changes/<slug>/specs/\`; \`07-Specs\` is generated/read-only.
4. **Verify** — \`wendkeep verify\` runs the sensors; then \`wendkeep verify --deep\` builds
   the verification package.
5. **Verify deep** — the **wk-verify** skill (fresh, author≠verifier) writes \`verdict.json\`.
   A trivial change (no \`[req:]\`) gets an auto verdict.
6. **Archive** — \`wendkeep change archive <slug>\`. The gate needs green sensors AND a
   verdict AND no open tasks. It promotes the delta into \`07-Specs\` and mints an ADR.

## Rules
- Multiple changes may stay open. \`CURRENT_CHANGE.md\` marks one current change without hiding
  other pending tasks. Any agent may take over an existing change with
  \`wendkeep change use <slug>\` or \`--change <slug>\` where available.
- No \`[sensor:]\` on a task = no automated gate for it. No \`[req:]\` = no independent verdict.
- The graph links session ↔ change ↔ requirement ↔ decision. That is the point.
`;

const TDD_EN = `# TDD — Red, Green, Refactor (tests that discriminate)

Never write production code without a red test asking for it — and never write a test that
would pass under the wrong implementation.

## The cycle
1. **Red** — the smallest test that fails for the missing behaviour.
2. **See it fail** for the right reason (not an import/typo).
3. **Green** — the minimal code to pass.
4. **Refactor** with the greens protecting you.

## Derive from the spec, not the code
Write assertions from the effective requirement (\`wendkeep spec effective --change <slug>\`), not by reading the
implementation. Reading the code to write the test = it only confirms what the code already does.

## Non-shallow litmus
Reject an assertion that would pass under a wrong implementation. Assert a **value or persisted
state**, never "the mock was called". "Tested later" is rejected.

## Adequacy (necessary and sufficient)
Every acceptance criterion has an assertion with \`file:line\` evidence; every test traces to a
requirement (\`[req:ID]\`); covers what the spec asks, nothing more.

## Learn the project
Sample 5–10 existing tests for style/location/framework/depth (treat that depth as a floor).
Read \`AGENTS.md\` / \`.cursor/rules\` / CI configs for declared standards.
`;

const DEBUGGING_EN = `# Systematic debugging

Use it when something fails or behaves wrong. One hypothesis at a time — no shotgun changes.

1. **Reproduce** — a minimal deterministic case. Without it you can't know you fixed anything.
2. **One hypothesis** — the most likely cause, specific enough to test.
3. **Isolate** — confirm or kill the hypothesis BEFORE fixing (bisect, log, comment half). Prove
   where it is, not where you think it is.
4. **Fix the root**, not the symptom.
5. **Verify** — the repro is gone AND the suite stays green. No regression.

Changed several things and it "worked"? You don't know what fixed it — revert, isolate one
variable. Read the whole error + stack — the decisive line is usually there.

## Vault record

A durable bug becomes a numbered note: \`wendkeep note new --type bug "summary"\` — creates
\`BUG-NNNN-<slug>.md\` in the month folder of \`05-Bugs\` (never a \`DIA N\` subfolder) and
prints the path for you to fill in. A learning from the debug: \`wendkeep note new --type
learning "lesson"\` (becomes \`APR-NNNN-\` in the learnings folder).
`;

const BRAINSTORMING_EN = `# Brainstorming — idea into design

Use it when the idea is still vague. Turn it into an approved design BEFORE writing code.

1. **Explore context** — files, docs, relevant history.
2. **One question at a time** — purpose, constraints, success criteria. Prefer multiple choice.
3. **Propose 2–3 approaches** with trade-offs and your recommendation.
4. **Present the design in sections**, confirm each.

## Closure gate — no dangling ambiguity
Resolve every gray area: decide with the user, or log a **signed-off assumption** ("assuming X
because Y — correct me if wrong"). A declined gray area is recorded, not silently dropped.
Also declare the capability and whether the design has \`spec_impact: required\` or \`none\`.

## Out-of-scope table
List explicitly what the change does **not** do. Undeclared scope becomes creep.

## Hard gate
No code / scaffold / implementation action until a design is presented and approved. Then go to
**wk-planning**.

## Template
Use \`design-template.md\` (in this skill folder) to structure the design (context, approaches,
signed-off decisions, out-of-scope table, acceptance).
`;

const PLANNING_EN = `# Planning — design into a task plan

Use it after an approved design. Produce a plan an engineer with no project context can execute.

## Before tasks
Map the files: what to create/modify and each one's responsibility. Files that change together
live together; one file, one responsibility.

Resolve the contract first: \`spec_impact: required\` needs a capability and a real delta at
\`specs/<capability>/spec.md\`; \`spec_impact: none\` needs a reason. Give each behaviour an ID
and link the corresponding tasks with \`[req:ID]\`.

## Bite-sized tasks (TDD)
Each task ends in an independently testable deliverable. Each step is a 2–5 min action:
write the failing test (show code) → run and see it fail (exact command + expected) → minimal
implementation (show code) → run and see it pass → checkpoint: suite green.

## Rules
- Exact file paths, always. Real code in each step — no "TODO", "handle errors appropriately",
  "similar to Task N". DRY, YAGNI. Consistent names/signatures across tasks.

## Template
Start from \`plan-template.md\` (in this skill folder) — the file map + TDD task structure.
`;

const VERIFY_EN = `# Independent verification — the fresh pass

Use it in the *verify deep* step, after \`wendkeep verify --deep\`. You are the **verifier**, not
the author — even if you wrote the code, enter as if you'd never seen it. Fresh context, read-only.

## What to do
1. Read the package \`08-Changes/<slug>/verificacao.json\` (requirements, tasks, evidence).
2. **Re-derive coverage from the self-contained package** — for each complete requirement in
   \`verificacao.json\`, check its behaviour
   is covered by a test that discriminates (wouldn't pass under a wrong impl). \`file:line\` evidence.
3. Spec-anchored outcome check: does the observable result match the acceptance criterion?
4. Write \`08-Changes/<slug>/verdict.json\`:
   \`{ "slug": "...", "ok": true, "coverage": [{ "req": "GATE-1", "covered": true, "evidence": "file:line" }], "tasksHash": "<copy from the package>", "effectiveSpecHash": "<copy from the package>", "notes": [] }\`.

## Rules
- **Author ≠ verifier.** On Claude, spawn a read-only sub-agent for real isolation.
- \`ok: false\` if any requirement lacks discriminating coverage. A gap is red, not "almost".
- Don't fix here — a gap becomes a fix task; re-verify after.
- The archive gate **requires** a fresh \`verdict.json\` (matching \`tasksHash\` and \`effectiveSpecHash\`) covering every \`[req:]\`.

## Templates (in this folder)
- \`spec-reviewer-prompt.md\` — hand it to the verifier sub-agent you spawn (read-only, author≠verifier).
- \`verdict-template.json\` — the exact shape of the \`verdict.json\` to write.
`;

// --- bundled templates (shipped alongside the relevant SKILL.md) -------------

// Shared, language-neutral verdict skeleton for the independent verify pass.
const VERDICT_TEMPLATE = `{
  "slug": "<change-slug>",
  "ok": true,
  "coverage": [
    { "req": "GATE-1", "covered": true, "evidence": "tests/foo.test.mjs:42" }
  ],
  "tasksHash": "<copie de verificacao.json — selo de frescor / copy from verificacao.json — freshness seal>",
  "effectiveSpecHash": "<copie de verificacao.json / copy from verificacao.json>",
  "notes": []
}
`;

const REVIEWER_PROMPT_PT = `# Prompt — passe de verificação independente (read-only)

Entregue este prompt ao spawnar o subagente verificador (via o harness nativo — Task/Agent no
Claude). Ele NÃO é o autor: entra fresco, read-only, não edita nada.

---
Você é o verificador independente de uma mudança do wendkeep. Não escreveu este código —
entre como se nunca o tivesse visto. Read-only.

Leia somente o pacote autocontido \`08-Mudanças/<slug>/verificacao.json\` (requisitos completos,
tarefas e evidência). Não reabra \`07-Specs\`: ele ainda não contém deltas não arquivados.

Para cada \`[req:ID]\` da mudança:
1. Leia o **critério de aceite do requisito** no spec — NÃO leia a implementação primeiro.
2. Ache o teste que cobre esse comportamento. Ele **discrimina**? (falharia sob uma
   implementação errada; afirma valor/estado persistido, não "o mock foi chamado").
3. Evidência \`arquivo:linha\`. Sem teste que discrimina = \`covered: false\` (é vermelho, não "quase").
4. Cheque o resultado observável contra o critério — não contra o código.

Grave \`08-Mudanças/<slug>/verdict.json\` no formato de \`verdict-template.json\`. \`ok: false\` se
qualquer \`[req:]\` não tem cobertura que discrimina. Não conserte aqui — gap vira tarefa de
correção. \`tasksHash\` e \`effectiveSpecHash\` vêm do pacote; alterações posteriores deixam o verdict stale.
---
`;

const REVIEWER_PROMPT_EN = `# Prompt — independent verification pass (read-only)

Hand this to the verifier sub-agent you spawn (via the native harness — Task/Agent on Claude).
It is NOT the author: fresh context, read-only, edits nothing.

---
You are the independent verifier of a wendkeep change. You did not write this code — enter as if
you'd never seen it. Read-only.

Read only the self-contained \`08-Changes/<slug>/verificacao.json\` package (complete requirements,
tasks, evidence). Do not reopen \`07-Specs\`: it does not contain unarchived deltas yet.

For each \`[req:ID]\`:
1. Read the requirement's **acceptance criterion** in the spec — do NOT read the implementation first.
2. Find the test covering that behaviour. Does it **discriminate**? (would fail under a wrong
   implementation; asserts a persisted value/state, not "the mock was called").
3. \`file:line\` evidence. No discriminating test = \`covered: false\` (red, not "almost").
4. Check the observable result against the criterion — not the code.

Write \`08-Changes/<slug>/verdict.json\` in the shape of \`verdict-template.json\`. \`ok: false\` if any
\`[req:]\` lacks discriminating coverage. Don't fix here — a gap becomes a fix task. \`tasksHash\`
and \`effectiveSpecHash\` come from the package (freshness seals; later task/spec edits make verdict stale).
---
`;

const PLAN_TEMPLATE_PT = `# Template — plano de tarefas (TDD, bite-sized)

## Impacto em specs
- \`spec_impact\`: \`required\` | \`none\`
- Capability/delta: \`specs/<capability>/spec.md\` ou justificativa de \`none\`

## Arquivos
- Criar: \`caminho/exato.mjs\`
- Modificar: \`caminho/existente.mjs:120-140\`
- Teste: \`tests/exato.test.mjs\`

## Tarefa N — <nome>
- **Consome:** <o que usa de tarefas anteriores — assinaturas exatas>
- **Produz:** <o que tarefas seguintes usam — nomes/tipos exatos>

- [ ] N.1 escreva o teste que falha (mostre o código do teste)  \`[req:<ID>]\`
- [ ] N.2 rode e veja falhar — pelo motivo certo (comando exato + saída esperada)
- [ ] N.3 implementação mínima (mostre o código)  \`[sensor:<id>]\` se precisa de prova
- [ ] N.4 rode e veja passar
- [ ] N.5 checkpoint: suíte verde · commit

## Regras
Caminhos exatos sempre. Código real em cada passo — nada de "TODO" / "tratar erros
apropriadamente" / "similar à Tarefa N". DRY, YAGNI. Nomes e assinaturas consistentes entre
tarefas (uma função é \`x()\` em toda parte). Cada tarefa termina num entregável testável sozinho.
`;

const PLAN_TEMPLATE_EN = `# Template — task plan (TDD, bite-sized)

## Spec impact
- \`spec_impact\`: \`required\` | \`none\`
- Capability/delta: \`specs/<capability>/spec.md\` or the \`none\` rationale

## Files
- Create: \`exact/path.mjs\`
- Modify: \`exact/existing.mjs:120-140\`
- Test: \`tests/exact.test.mjs\`

## Task N — <name>
- **Consumes:** <what it uses from earlier tasks — exact signatures>
- **Produces:** <what later tasks rely on — exact names/types>

- [ ] N.1 write the failing test (show the test code)  \`[req:<ID>]\`
- [ ] N.2 run and see it fail — for the right reason (exact command + expected output)
- [ ] N.3 minimal implementation (show the code)  \`[sensor:<id>]\` if it needs proof
- [ ] N.4 run and see it pass
- [ ] N.5 checkpoint: suite green · commit

## Rules
Exact paths always. Real code in every step — no "TODO" / "handle errors appropriately" /
"similar to Task N". DRY, YAGNI. Consistent names/signatures across tasks. Each task ends in an
independently testable deliverable.
`;

const DESIGN_TEMPLATE_PT = `# Template — documento de design

## Contexto
<o problema, o estado atual, por que agora>

## Abordagens consideradas
1. **<A>** — <trade-off>.
2. **<B>** — <trade-off>.
Recomendada: **<qual>** — <por quê>.

## Design
<arquitetura, componentes, fluxo de dados, tratamento de erro, estratégia de teste — em seções
escaladas ao tamanho do problema>

## Decisões e assumptions assinadas
- Assumo **X** porque **Y** — corrija se errado.

## Out-of-scope (o contrato do que NÃO muda)
| Item | Por que fora |
|---|---|
| <x> | <razão> |

## Aceite
<critérios verificáveis: para cada requisito, o teste que falha → passa>
`;

const DESIGN_TEMPLATE_EN = `# Template — design document

## Context
<the problem, the current state, why now>

## Approaches considered
1. **<A>** — <trade-off>.
2. **<B>** — <trade-off>.
Recommended: **<which>** — <why>.

## Design
<architecture, components, data flow, error handling, test strategy — sections scaled to the
size of the problem>

## Decisions and signed-off assumptions
- Assuming **X** because **Y** — correct me if wrong.

## Out-of-scope (the contract of what does NOT change)
| Item | Why out |
|---|---|
| <x> | <reason> |

## Acceptance
<verifiable criteria: for each requirement, the test that fails → passes>
`;

// As descriptions são o gatilho de ativação: o harness casa a description com o PEDIDO do
// usuário ("implementa X", "corrige Y"), não com abstrações ("mudança não-trivial"). Gatilhos
// concretos + instrução imperativa = a skill dispara sozinha (paridade Superpowers).
const WK_SKILLS_PT = [
  skill('wk-workflow', 'Use SEMPRE que o usuário pedir para implementar, criar, corrigir, refatorar, adicionar ou alterar código — qualquer tarefa de código não-trivial. Invoque ANTES de editar qualquer arquivo: orquestra o loop a2 (wendkeep change new → tarefas → verify → archive) e registra tudo no vault.', WORKFLOW),
  skill('wk-tdd', 'Use ao implementar qualquer comportamento — Red/Green/Refactor com testes que discriminam (derivados do spec, litmus não-raso, adequação).', TDD),
  skill('wk-debugging', 'Use quando algo falha, quebra, dá erro ou regride — depuração sistemática por hipótese antes de corrigir.', DEBUGGING),
  skill('wk-brainstorming', 'Use quando a ideia ainda é vaga ou o usuário quer discutir/planejar uma feature (inclusive em plan mode) — vira design aprovado, com closure gate e tabela out-of-scope, antes de código.', BRAINSTORMING, [{ name: 'design-template.md', content: DESIGN_TEMPLATE_PT }]),
  skill('wk-planning', 'Use após um design aprovado ou um plano aceito (inclusive plan mode) — decompõe em plano de tarefas TDD bite-sized e registra na change ativa.', PLANNING, [{ name: 'plan-template.md', content: PLAN_TEMPLATE_PT }]),
  skill('wk-verify', 'Use no verify deep — passe independente read-only (autor≠verificador) que re-deriva a cobertura do spec e grava verdict.json.', VERIFY, [{ name: 'spec-reviewer-prompt.md', content: REVIEWER_PROMPT_PT }, { name: 'verdict-template.json', content: VERDICT_TEMPLATE }]),
];

const WK_SKILLS_EN = [
  skill('wk-workflow', 'Use WHENEVER the user asks to implement, create, fix, refactor, add or change code — any non-trivial coding task. Invoke BEFORE editing any file: it orchestrates the a2 loop (wendkeep change new → tasks → verify → archive) and records everything in the vault.', WORKFLOW_EN),
  skill('wk-tdd', 'Use when implementing any behaviour — Red/Green/Refactor with tests that discriminate (spec-derived, non-shallow litmus, adequacy).', TDD_EN),
  skill('wk-debugging', 'Use when something fails, breaks, errors or regresses — systematic hypothesis-driven debugging before fixing.', DEBUGGING_EN),
  skill('wk-brainstorming', 'Use when the idea is still vague or the user wants to discuss/plan a feature (plan mode included) — turns it into an approved design, with a closure gate and out-of-scope table, before code.', BRAINSTORMING_EN, [{ name: 'design-template.md', content: DESIGN_TEMPLATE_EN }]),
  skill('wk-planning', 'Use after an approved design or an accepted plan (plan mode included) — decomposes it into a bite-sized TDD task plan recorded in the active change.', PLANNING_EN, [{ name: 'plan-template.md', content: PLAN_TEMPLATE_EN }]),
  skill('wk-verify', 'Use in verify deep — an independent read-only pass (author≠verifier) that re-derives spec coverage and writes verdict.json.', VERIFY_EN, [{ name: 'spec-reviewer-prompt.md', content: REVIEWER_PROMPT_EN }, { name: 'verdict-template.json', content: VERDICT_TEMPLATE }]),
];

// Skill set for a locale. WK_SKILLS stays the pt-BR set for back-compat.
export function wkSkills(localeId = 'pt-BR') {
  return localeId === 'en' ? WK_SKILLS_EN : WK_SKILLS_PT;
}
export const WK_SKILLS = WK_SKILLS_PT;

// Seed each skill into <brainDir>/skills/<name>/ if absent (non-destructive): SKILL.md plus any
// bundled template/prompt files. Existing files are never overwritten, so re-seeding an older
// install just fills in the new template files alongside its SKILL.md.
// { refresh: true } (sync-defs --reseed) SOBRESCREVE as wk-* com os seeds atuais — é como um
// vault existente recebe descriptions/HARD-GATE novos (edições manuais nas wk-* são perdidas).
export function seedWkSkills(brainDir, localeId = 'pt-BR', { refresh = false } = {}) {
  const created = [];
  for (const s of wkSkills(localeId)) {
    const dir = join(brainDir, 'skills', s.name);
    mkdirSync(dir, { recursive: true });
    const write = (name, content) => {
      const f = join(dir, name);
      if (refresh || !existsSync(f)) {
        writeFileSync(f, content, 'utf8');
        created.push(f);
      }
    };
    write('SKILL.md', s.body);
    for (const file of s.files || []) write(file.name, file.content);
  }
  return created;
}
