---
name: wk-planning
description: Use após um design aprovado ou um plano aceito (inclusive plan mode) — decompõe em plano de tarefas TDD bite-sized e registra na change ativa.
---
# Planejamento — design vira plano de tarefas

Use depois de um design aprovado. Produza um plano que um dev sem contexto do projeto
consiga executar.

## Antes das tarefas

Mapeie os arquivos: quais criar/modificar e a responsabilidade de cada um. Arquivos que
mudam juntos ficam juntos; um arquivo, uma responsabilidade. É aqui que a decomposição
trava.

Resolva o contrato antes de decompor: `spec_impact: required` exige capability + delta real em
`specs/<capability>/spec.md`; `spec_impact: none` exige justificativa. Cada comportamento do
delta recebe ID e as tarefas correspondentes usam `[req:ID]`.

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
- Nomes/assinaturas consistentes entre tarefas (uma função é `x()` em toda parte).

## Template
Comece do `plan-template.md` (nesta pasta da skill) — a estrutura de arquivos + tarefas TDD.
