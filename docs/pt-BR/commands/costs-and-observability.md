# Custos e observabilidade

**PT-BR** · [English](../../en/commands/costs-and-observability.md)

## Objetivo

Medir sessões, prompts, modelos e custo de IA, além de reconstruir históricos a partir dos
transcripts canônicos quando necessário.

## Quando usar

Use `stats` para visão rápida, `cost` para análise e `cost rebuild` quando notas antigas não têm
custos confiáveis.

## Quando não usar

Não aplique rebuild antes de validar provider e transcript de cada sessão. Não compare custos de
projetos com registries misturados.

## Pré-requisitos

Registry consistente, tabela de preços completa e acesso aos transcripts das sessões reconstruídas.

## Sintaxe

```bash
npx wendkeep stats [--vault <cofre>] [--json]
npx wendkeep cost [--since <data>] [--top [N]] [--trend day|week|month] [--write] [--json]
npx wendkeep cost rebuild [--session <id|arquivo>] [--limit N] [--apply] [--json]
```

## Opções e códigos de saída

- `wendkeep stats` gera uma linha compartilhável ou JSON.
- `wendkeep cost` agrega total/modelo/dia; `--trend` inclui projeção e `--write` atualiza
  `00-Custo.md`.
- `wendkeep cost rebuild` é dry-run por padrão; `--apply` grava notas e
  `.brain/COST_REBUILD.json`.
- Exit `0` indica cálculo consistente; não zero indica registry, preço, transcript ou parsing
  insuficiente.

## Exemplos

```bash
npx wendkeep stats --vault .MeuApp-vault
npx wendkeep cost --since 2026-07-01 --top 10 --trend week
npx wendkeep cost rebuild --session 019abc --json
```

## Resultado esperado

Totais preservam dimensões de input/output/cache/reasoning por modelo e período. Rebuild mostra a
prévia antes de alterar notas e deixa um relatório reproduzível quando aplicado.

## Erros comuns e diagnóstico

- Modelo sem preço: atualize a tabela antes de aceitar o total.
- Custos de provider errado: valide a cadeia de identidade da sessão.
- Transcript ausente: não estime silenciosamente; mantenha a lacuna visível.
- Total duplicado por subagent/fork: confirme relação pai/subagent e deduplicação do registry.

## Próximos passos

Veja [sessões e importação](sessions-and-import.md), [importação retroativa](retroactive-import.md)
e [manutenção](maintenance-and-diagnostics.md).
