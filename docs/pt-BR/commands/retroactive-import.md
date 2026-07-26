# Importação retroativa segura

**PT-BR** · [English](../../en/commands/retroactive-import.md)

## Objetivo

Importar sessões históricas de Claude e Codex com escopo controlado, identidade estável e revisão
antes da escrita.

## Quando usar

Use ao instalar o WendKeep num projeto existente, recuperar uma faixa de datas ou reprocessar
decisões sem importar o mundo inteiro.

## Quando não usar

Não use `--source all` sem dry-run em máquinas com muitos projetos, forks ou rollouts de subagents.
Não trate transcript importado como evidência de implementação atual.

## Pré-requisitos

Confirme projeto, vault, provider, diretório fonte e janela temporal. Faça backup se o registry já
contiver reparos manuais.

## Sintaxe

```bash
npx wendkeep import --dry-run --json
npx wendkeep import --source claude|codex|all [--since <data>] [--limit <n>]
npx wendkeep import --from <claude-dir> --codex-from <codex-dir>
npx wendkeep import --stamp-ids | --rescan-decisions
```

## Opções e códigos de saída

- `--source` limita provider; `--since` e `--limit` limitam volume.
- `--from`/`--codex-from` substituem diretórios descobertos.
- `--dry-run` não grava e `--json` produz relatório auditável.
- `--stamp-ids` preenche IDs em notas existentes; `--rescan-decisions` reaplica extração de prosa.
- Exit `0` indica varredura/importação consistente; exit diferente de zero exige resolver fonte,
  parsing ou identidade antes de repetir.

## Exemplos

```bash
npx wendkeep import --source codex --since 2026-07-20 --limit 20 --dry-run --json
# confira accepted/skipped/forks
npx wendkeep import --source codex --since 2026-07-20 --limit 20
```

## Resultado esperado

Sessões aceitas entram uma vez por `session_id`, com provider e transcript corretos. Duplicatas
canônicas são ignoradas; forks/subagents preservam relação de origem em vez de copiar toda a
história herdada como uma nova conversa independente.

## Erros comuns e diagnóstico

- Contaminação entre projetos: pare e confira cwd, binding e filtros antes de limpar qualquer nota.
- Fork comum importado como sessão cheia: inspecione `forked_from_id` e payload de origem.
- Nota sem `session_id`: use `--stamp-ids` somente após dry-run.
- Decisões faltantes em nota já importada: prefira `--rescan-decisions` a duplicar a sessão.

## Próximos passos

Volte para [sessões e hooks](sessions-and-import.md), gere [custos](costs-and-observability.md) e
revise [notas derivadas](notes-and-knowledge.md).
