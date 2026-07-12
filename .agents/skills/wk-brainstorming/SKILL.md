---
name: wk-brainstorming
description: Use quando a ideia ainda é vaga ou o usuário quer discutir/planejar uma feature (inclusive em plan mode) — vira design aprovado, com closure gate e tabela out-of-scope, antes de código.
---
# Brainstorming — ideia vira design

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
Declare também a capability e se o design tem `spec_impact: required` ou `none`.

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
Use o `design-template.md` (nesta pasta da skill) pra estruturar o design (contexto, abordagens,
decisões assinadas, tabela out-of-scope, aceite).
