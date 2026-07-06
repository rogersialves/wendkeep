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

export const WK_SKILLS = [
  skill('wk-workflow', 'Use ao começar qualquer mudança não-trivial — orquestra o loop a2 (explore, propose, apply, verify, archive) nos comandos wendkeep.', WORKFLOW),
  skill('wk-tdd', 'Use ao implementar qualquer comportamento — Red/Green/Refactor com testes que discriminam (derivados do spec, litmus não-raso, adequação).', TDD),
  skill('wk-debugging', 'Use quando algo falha ou quebra — depuração sistemática por hipótese antes de corrigir.', DEBUGGING),
  skill('wk-brainstorming', 'Use quando a ideia ainda é vaga — vira design aprovado, com closure gate e tabela out-of-scope, antes de código.', BRAINSTORMING),
  skill('wk-planning', 'Use após um design aprovado — decompõe em plano de tarefas TDD bite-sized.', PLANNING),
  skill('wk-verify', 'Use no verify deep — passe independente read-only (autor≠verificador) que re-deriva a cobertura do spec e grava verdict.json.', VERIFY),
];

// Seed each skill into <brainDir>/skills/<name>/SKILL.md if absent (non-destructive).
export function seedWkSkills(brainDir) {
  const created = [];
  for (const s of WK_SKILLS) {
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
