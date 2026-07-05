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
   (teste vermelho antes do código). Marque \`- [x]\` ao concluir cada uma.
   Em tarefas cujo resultado precisa de *prova*, declare o sensor no fim da linha:
   \`- [ ] 2.1 valida CORE [sensor:memory-validation]\`.
4. **Verify** — \`wendkeep verify\`. Roda os sensores declarados pelas tarefas e grava
   \`evidencia.json\`. Verde = prova registrada.
5. **Archive** — \`wendkeep change archive <slug>\`. O *gate* trava se algum sensor
   declarado não estiver verde. Passando, move a mudança pro \`_arquivo\` e gera um ADR
   em \`04-Decisões/\`.

## Regras

- Uma mudança ativa por vez. Termine (archive) antes de abrir outra.
- Se uma tarefa não precisa de prova automatizada, não declare sensor — o gate só exige
  o que você declarou. Sem \`[sensor:]\`, o archive não trava.
- A proposta linka a sessão de origem; a sessão linka a mudança ativa. É de propósito:
  o grafo do Obsidian mostra plano↔sessão↔decisão.
`;

const TDD = `# TDD — Red, Green, Refactor

Use ao implementar qualquer comportamento. Nunca escreva código de produção sem um
teste vermelho pedindo por ele.

## O ciclo

1. **Red** — escreva o menor teste que falha por faltar o comportamento desejado.
2. **Rode e veja falhar** — confirme que falha *pelo motivo certo* (não por erro de
   import/typo). Um teste que nunca falhou não prova nada.
3. **Green** — o código mínimo que faz o teste passar. Nada além disso.
4. **Refactor** — limpe com os testes verdes te protegendo. Rode de novo.

## Regras

- Um comportamento por teste. Nome do teste descreve o comportamento, não a implementação.
- Passos pequenos: um ciclo red→green leva minutos, não horas.
- Não teste detalhe interno que você vai refatorar — teste a interface observável.
- Bug encontrado = primeiro um teste que o reproduz (vermelho), depois a correção (verde).
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

export const WK_SKILLS = [
  skill('wk-workflow', 'Use ao começar qualquer mudança não-trivial — orquestra o loop a2 (explore, propose, apply, verify, archive) nos comandos wendkeep.', WORKFLOW),
  skill('wk-tdd', 'Use ao implementar qualquer comportamento — disciplina Red, Green, Refactor.', TDD),
  skill('wk-debugging', 'Use quando algo falha ou quebra — depuração sistemática por hipótese antes de corrigir.', DEBUGGING),
  skill('wk-brainstorming', 'Use quando a ideia ainda é vaga — transforma ideia em design aprovado antes de código.', BRAINSTORMING),
  skill('wk-planning', 'Use após um design aprovado — decompõe em plano de tarefas TDD bite-sized.', PLANNING),
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
