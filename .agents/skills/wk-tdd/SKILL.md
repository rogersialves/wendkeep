---
name: wk-tdd
description: Use ao implementar qualquer comportamento — Red/Green/Refactor com testes que discriminam (derivados do spec, litmus não-raso, adequação).
---
# TDD — Red, Green, Refactor (testes que discriminam)

Use ao implementar qualquer comportamento. Nunca escreva código de produção sem um teste
vermelho pedindo por ele — e nunca escreva um teste que passaria sob a implementação errada.

## O ciclo

1. **Red** — o menor teste que falha por faltar o comportamento.
2. **Rode e veja falhar** — pelo motivo certo (não import/typo). Teste que nunca falhou não prova nada.
3. **Green** — o código mínimo pra passar.
4. **Refactor** — limpe com os verdes te protegendo.

## Derive do spec, não do código

Escreva a asserção a partir do *critério de aceite* da spec efetiva
(`wendkeep spec effective --change <slug>`), não lendo a
implementação. Cada asserção mira o resultado que o spec definiu. Escrever o teste lendo o
código = ele só confirma o que o código já faz, bugs inclusos.

## Litmus não-raso

Rejeite asserção que passaria sob uma implementação errada. Afirme **valor ou estado
persistido**, nunca "o mock foi chamado". "Testado depois" é rejeitado — o teste nasce
junto com o código da tarefa.

## Adequação (necessário e suficiente)

- Todo critério de aceite tem uma asserção — com evidência `arquivo:linha`.
- Todo teste rastreia um requisito (`[req:ID]`). Teste sem requisito = escopo à toa.
- Nem raso, nem inflado: cobre o que o spec pede, nada além.

## Aprende o projeto

Antes de escrever, amostre 5–10 testes existentes: estilo, localização, framework,
profundidade por camada — trate essa profundidade como *piso*, nunca teto. Leia
`AGENTS.md` / `.cursor/rules` / configs de CI pros padrões declarados.

## Regras

- Um comportamento por teste; o nome descreve o comportamento, não a implementação.
- Bug encontrado = primeiro o teste que o reproduz (vermelho), depois a correção.
