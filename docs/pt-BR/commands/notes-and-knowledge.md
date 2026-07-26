# Notas derivadas e grafo de conhecimento

**PT-BR** · [English](../../en/commands/notes-and-knowledge.md)

## Objetivo

Criar, reparar, numerar e navegar decisões, bugs e aprendizados mantendo proveniência e wikilinks.

## Quando usar

Use para registrar conhecimento durável ou reparar notas históricas diagnosticadas pelo doctor.

## Quando não usar

Não edite numeração e wikilinks em massa à mão. Não use `--apply` sem conferir a prévia.

## Pré-requisitos

Vault vinculado, sessão de origem identificável e backup antes de renumerações amplas.

## Sintaxe

```bash
npx wendkeep dashboard [--force]
npx wendkeep note new --type bug|learning "<título>"
npx wendkeep note relink [--apply]
npx wendkeep note repair-frontmatter [--apply]
npx wendkeep note repair-sections [--apply]
npx wendkeep renumber-decisions [--apply]
npx wendkeep renumber-bugs [--apply]
npx wendkeep renumber-learnings [--apply]
npx wendkeep lesson add "<título>" "<lição>"
```

## Opções e códigos de saída

- `note new` cria `BUG-NNNN` ou `APR-NNNN` no mês e aceita `--date`.
- `note relink`, `repair-frontmatter`, `repair-sections` e `renumber-*` são dry-run por padrão;
  `--apply` grava e `--json` facilita auditoria.
- `dashboard --force` regenera Bases/MOC quando necessário.
- `lesson add` aceita `--change <slug>` e `--vault` para ligar aprendizado local.
- Exit `0` indica prévia/aplicação consistente; não zero deixa o reparo incompleto explícito.

## Exemplos

```bash
npx wendkeep note new --type bug "refresh expira durante upload"
npx wendkeep note relink --json
npx wendkeep renumber-decisions --json
# revise antes de repetir com --apply
npx wendkeep dashboard --force
```

## Resultado esperado

Notas derivadas vivem na pasta do mês, têm numeração global do tipo e backlink para a sessão. Os
reparos preservam frontmatter válido e reescrevem wikilinks quando arquivos mudam.

## Erros comuns e diagnóstico

- Nota órfã sem fonte modal: `note relink` informa que não consegue inferir e não inventa vínculo.
- Frontmatter empilhado: use repair sob o mesmo lock dos hooks.
- Links cinza após renumber/archive: rode prévia de relink e confirme ambiguidades.
- Título sensível: remova secrets/PII antes de persistir.

## Próximos passos

Veja [sessões e importação](sessions-and-import.md),
[custos e observabilidade](costs-and-observability.md) e [manutenção](maintenance-and-diagnostics.md).
