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
npx wendkeep cost rebuild [--session <id|arquivo>] [--limit N] [--max-graph-nodes N] [--max-fallback-days N] [--max-fallback-candidates N] [--apply] [--json]
```

## Opções e códigos de saída

- `wendkeep stats` gera uma linha compartilhável ou JSON.
- `wendkeep cost` agrega total/modelo/dia; `--trend` inclui projeção e `--write` atualiza
  `00-Custo.md`.
- `wendkeep cost rebuild` é dry-run por padrão e tem **zero escrita**: não adquire lock de
  gravação, não altera nota, registry ou runtime e não cria `.brain/COST_REBUILD.json`.
- `--apply` publica somente candidatos `complete` ou `none`. O estado `none` só zera a seção
  quando um scan offline estável comprovou que nenhum subagente foi iniciado.
- Um candidato `degraded` ou `stale` produz exit `1` e preserva a nota sem alteração; o lote
  continua para que outras sessões seguras possam ser processadas e o relatório exponha os
  códigos sanitizados.
- Os overrides `--max-graph-nodes`, `--max-fallback-days` e `--max-fallback-candidates` são
  exclusivamente para rebuild direcionado com `--session`. Usá-los sem `--session` é uso inválido
  e produz exit `2`; hooks, import e rebuild em lote mantêm os limites padrão.
- Exit `0` significa preview/aplicação consistente; exit `1` indica resultado parcial
  `degraded`/`stale`; exit `2` indica sintaxe ou contexto inválido.

## Exemplos

```bash
npx wendkeep stats --vault .MeuApp-vault
npx wendkeep cost --since 2026-07-01 --top 10 --trend week
npx wendkeep cost rebuild --session 019abc --json
npx wendkeep cost rebuild --session 019abc --max-graph-nodes 8192 --json
npx wendkeep cost rebuild --session 019abc --apply
```

## Resultado esperado

Totais preservam dimensões de input/output/cache/reasoning por modelo e período. A composição
tri-state devolve `complete`, `none` ou `degraded`, mais frontier, manifest e diagnostics
sanitizados. Rode e revise o dry-run antes de repetir o mesmo comando com `--apply`; uma segunda
aplicação semanticamente idêntica preserva nota, checkpoint, relatório e mtime.

## Erros comuns e diagnóstico

- Modelo sem preço: atualize a tabela antes de aceitar o total.
- Custos de provider errado: valide a cadeia de identidade da sessão.
- Transcript ausente: não estime silenciosamente; mantenha a lacuna visível.
- Total duplicado por subagent/fork: confirme relação pai/subagent e deduplicação do registry.
- `degraded`/`stale`: preserve a nota e investigue diagnostics/frontier antes de autorizar apply.
- Override rejeitado: acrescente `--session <id|arquivo>` ou remova os três limites direcionados.

## Próximos passos

Veja [sessões e importação](sessions-and-import.md), [importação retroativa](retroactive-import.md)
e [manutenção](maintenance-and-diagnostics.md).
