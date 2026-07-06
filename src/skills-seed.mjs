// src/skills-seed.mjs — native, zero-dep process skills (Pilar A: the HOW layer).
// Seeded into the vault's .brain/skills; distributed by `wendkeep sync-defs` to
// .claude/skills. Wendkeep-flavored (reference change/verify), concise native prose.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function skill(name, description, body) {
  return { name, description, body: `---\nname: ${name}\ndescription: ${description}\n---\n${body}` };
}

const WORKFLOW = `# Loop a2 — o ciclo de trabalho do wendkeep

Use ao começar qualquer mudança não-trivial. O loop mantém memória (vault) e prova
(sensores) juntas, tudo linkado no grafo do Obsidian.

## Os passos

1. **Explore** — entenda o problema antes de propor. Leia o código/contexto relevante.
2. **Propose** — \`wendkeep change new <slug>\`. Isso cria \`08-Mudanças/<slug>/\` com:
   - \`proposta.md\` — *por quê* e *o que muda* (o WHAT).
   - \`design.md\` — a abordagem técnica.
   - \`tarefas.md\` — a lista de tarefas \`- [ ] N.N descrição\`.
   A mudança vira a *ativa* (ponteiro \`.brain/CURRENT_CHANGE.md\`) e é injetada no
   próximo SessionStart, então você retoma o trabalho em curso automaticamente.
3. **Apply** — implemente cada tarefa de \`tarefas.md\` com disciplina **wk-tdd**
   (teste vermelho antes do código). Marque \`- [x]\` ao concluir. Declare nas tarefas:
   - \`[sensor:<id>]\` — a prova automatizada (roda no verify).
   - \`[req:<ID>]\` — o requisito do spec que a tarefa satisfaz (ex.: \`[req:GATE-1]\`),
     quando a change mexe numa capability de \`07-Specs\`.
   Ex.: \`- [ ] 2.1 valida CORE [req:MEM-1] [sensor:memory-validation]\`.
4. **Verify** — \`wendkeep verify\` roda os sensores → \`evidencia.json\`. Depois
   \`wendkeep verify --deep\` monta o *pacote de verificação* pro passe independente.
5. **Verify deep** — a skill **wk-verify** (passe fresco, autor≠verificador) lê o pacote,
   re-deriva a cobertura do \`07-Specs\` e grava \`verdict.json\`. Change trivial (sem
   \`[req:]\`) recebe verdict automático — pula este passe.
6. **Archive** — \`wendkeep change archive <slug>\`. O *gate* exige sensores verdes **E**
   \`verdict.json\` cobrindo os \`[req:]\`. Passando, promove os deltas pro \`07-Specs\`,
   move a change pro \`_arquivo\` e gera um ADR em \`04-Decisões/\`.

## Regras

- Uma mudança ativa por vez. Termine (archive) antes de abrir outra.
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

Escreva a asserção a partir do *critério de aceite* do requisito (\`07-Specs\`), não lendo a
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

## Tabela out-of-scope

Liste explicitamente o que a mudança **não** faz. Escopo não declarado vira creep; a tabela
é o contrato do que ficou de fora — e base pra próxima change.

## Gate rígido

NÃO escreva código, scaffold nem tome ação de implementação até apresentar um design e o
usuário aprovar. Vale pra TODO projeto, por mais simples que pareça — "simples demais pra
precisar de design" é onde suposições não-checadas mais custam. O design pode ser curto,
mas tem que existir e ser aprovado.

Ao aprovar, o próximo passo é **wk-planning** (design → plano). Não pule pra implementação.
`;

const PLANNING = `# Planejamento — design vira plano de tarefas

Use depois de um design aprovado. Produza um plano que um dev sem contexto do projeto
consiga executar.

## Antes das tarefas

Mapeie os arquivos: quais criar/modificar e a responsabilidade de cada um. Arquivos que
mudam juntos ficam juntos; um arquivo, uma responsabilidade. É aqui que a decomposição
trava.

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
`;

const VERIFY = `# Verificação independente — o passe fresco

Use no passo *verify deep* do loop, depois de \`wendkeep verify --deep\`. Você é o
**verificador**, não o autor — mesmo tendo escrito o código, entre neste passe como se
nunca tivesse visto a implementação. Contexto fresco, read-only.

## O que fazer

1. Leia o pacote \`08-Mudanças/<slug>/verificacao.json\` (requisitos, tarefas, evidência).
2. **Re-derive a cobertura do \`07-Specs\`** — pra cada \`[req:ID]\` da change, cheque se o
   comportamento definido no requisito está coberto por um teste que discrimina (não
   passaria sob impl errada). Evidência \`arquivo:linha\`.
3. Outcome check ancorado no spec: o resultado observável bate com o critério de aceite?
4. Grave \`08-Mudanças/<slug>/verdict.json\`:
   \`{ "slug": "...", "ok": true, "coverage": [{ "req": "GATE-1", "covered": true, "evidence": "arquivo:linha" }], "tasksHash": "<copie do verificacao.json>", "notes": [] }\`.
   O \`tasksHash\` vem do pacote — é o selo de frescor; sem ele (ou com tarefas alteradas
   depois), o gate rejeita o verdict como stale.

## Regras

- **Autor ≠ verificador.** No Claude, spawn um sub-agente read-only pra este passe
  (isolamento real). Nos outros, entre num contexto limpo e re-derive do spec, não da memória.
- \`ok: false\` se algum requisito não tem cobertura que discrimina. Gap não é "quase lá" — é vermelho.
- Não conserte aqui. Gap vira tarefa de correção na change; re-verifica depois.
- O gate do \`archive\` **exige** \`verdict.json\` com \`ok\` cobrindo todo \`[req:]\`. Sem isso, não arquiva.
`;

const WORKFLOW_EN = `# The a2 loop — wendkeep's work cycle

Use it when starting any non-trivial change. The loop keeps memory (vault) and proof
(sensors) together, wikilinked in the Obsidian graph.

## Steps

1. **Explore** — understand the problem before proposing.
2. **Propose** — \`wendkeep change new <slug>\` scaffolds \`08-Changes/<slug>/\`
   (proposta/design/tarefas + a \`specs/\` delta). The change becomes *active* and is
   injected at the next SessionStart.
3. **Apply** — implement each task in tarefas.md with **wk-tdd** (red test first). Tag tasks:
   \`[sensor:<id>]\` (automated proof) and \`[req:<ID>]\` (the spec requirement it satisfies).
4. **Verify** — \`wendkeep verify\` runs the sensors; then \`wendkeep verify --deep\` builds
   the verification package.
5. **Verify deep** — the **wk-verify** skill (fresh, author≠verifier) writes \`verdict.json\`.
   A trivial change (no \`[req:]\`) gets an auto verdict.
6. **Archive** — \`wendkeep change archive <slug>\`. The gate needs green sensors AND a
   verdict AND no open tasks. It promotes the delta into \`07-Specs\` and mints an ADR.

## Rules
- One active change at a time. Finish (archive) before starting another.
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
Write assertions from the requirement's acceptance criteria (\`07-Specs\`), not by reading the
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

## Out-of-scope table
List explicitly what the change does **not** do. Undeclared scope becomes creep.

## Hard gate
No code / scaffold / implementation action until a design is presented and approved. Then go to
**wk-planning**.
`;

const PLANNING_EN = `# Planning — design into a task plan

Use it after an approved design. Produce a plan an engineer with no project context can execute.

## Before tasks
Map the files: what to create/modify and each one's responsibility. Files that change together
live together; one file, one responsibility.

## Bite-sized tasks (TDD)
Each task ends in an independently testable deliverable. Each step is a 2–5 min action:
write the failing test (show code) → run and see it fail (exact command + expected) → minimal
implementation (show code) → run and see it pass → checkpoint: suite green.

## Rules
- Exact file paths, always. Real code in each step — no "TODO", "handle errors appropriately",
  "similar to Task N". DRY, YAGNI. Consistent names/signatures across tasks.
`;

const VERIFY_EN = `# Independent verification — the fresh pass

Use it in the *verify deep* step, after \`wendkeep verify --deep\`. You are the **verifier**, not
the author — even if you wrote the code, enter as if you'd never seen it. Fresh context, read-only.

## What to do
1. Read the package \`08-Changes/<slug>/verificacao.json\` (requirements, tasks, evidence).
2. **Re-derive coverage from \`07-Specs\`** — for each \`[req:ID]\`, check the requirement's behaviour
   is covered by a test that discriminates (wouldn't pass under a wrong impl). \`file:line\` evidence.
3. Spec-anchored outcome check: does the observable result match the acceptance criterion?
4. Write \`08-Changes/<slug>/verdict.json\`:
   \`{ "slug": "...", "ok": true, "coverage": [{ "req": "GATE-1", "covered": true, "evidence": "file:line" }], "tasksHash": "<copy from the package>", "notes": [] }\`.

## Rules
- **Author ≠ verifier.** On Claude, spawn a read-only sub-agent for real isolation.
- \`ok: false\` if any requirement lacks discriminating coverage. A gap is red, not "almost".
- Don't fix here — a gap becomes a fix task; re-verify after.
- The archive gate **requires** a fresh \`verdict.json\` (matching \`tasksHash\`) covering every \`[req:]\`.
`;

const WK_SKILLS_PT = [
  skill('wk-workflow', 'Use ao começar qualquer mudança não-trivial — orquestra o loop a2 (explore, propose, apply, verify, archive) nos comandos wendkeep.', WORKFLOW),
  skill('wk-tdd', 'Use ao implementar qualquer comportamento — Red/Green/Refactor com testes que discriminam (derivados do spec, litmus não-raso, adequação).', TDD),
  skill('wk-debugging', 'Use quando algo falha ou quebra — depuração sistemática por hipótese antes de corrigir.', DEBUGGING),
  skill('wk-brainstorming', 'Use quando a ideia ainda é vaga — vira design aprovado, com closure gate e tabela out-of-scope, antes de código.', BRAINSTORMING),
  skill('wk-planning', 'Use após um design aprovado — decompõe em plano de tarefas TDD bite-sized.', PLANNING),
  skill('wk-verify', 'Use no verify deep — passe independente read-only (autor≠verificador) que re-deriva a cobertura do spec e grava verdict.json.', VERIFY),
];

const WK_SKILLS_EN = [
  skill('wk-workflow', 'Use when starting any non-trivial change — orchestrates the a2 loop (explore, propose, apply, verify, archive) over the wendkeep commands.', WORKFLOW_EN),
  skill('wk-tdd', 'Use when implementing any behaviour — Red/Green/Refactor with tests that discriminate (spec-derived, non-shallow litmus, adequacy).', TDD_EN),
  skill('wk-debugging', 'Use when something fails or breaks — systematic hypothesis-driven debugging before fixing.', DEBUGGING_EN),
  skill('wk-brainstorming', 'Use when the idea is still vague — turns it into an approved design, with a closure gate and out-of-scope table, before code.', BRAINSTORMING_EN),
  skill('wk-planning', 'Use after an approved design — decomposes it into a bite-sized TDD task plan.', PLANNING_EN),
  skill('wk-verify', 'Use in verify deep — an independent read-only pass (author≠verifier) that re-derives spec coverage and writes verdict.json.', VERIFY_EN),
];

// Skill set for a locale. WK_SKILLS stays the pt-BR set for back-compat.
export function wkSkills(localeId = 'pt-BR') {
  return localeId === 'en' ? WK_SKILLS_EN : WK_SKILLS_PT;
}
export const WK_SKILLS = WK_SKILLS_PT;

// Seed each skill into <brainDir>/skills/<name>/SKILL.md if absent (non-destructive).
export function seedWkSkills(brainDir, localeId = 'pt-BR') {
  const created = [];
  for (const s of wkSkills(localeId)) {
    const dir = join(brainDir, 'skills', s.name);
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'SKILL.md');
    if (!existsSync(f)) {
      writeFileSync(f, s.body, 'utf8');
      created.push(f);
    }
  }
  return created;
}
