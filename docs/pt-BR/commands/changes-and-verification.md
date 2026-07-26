# Changes, specs, sensores e archive

**PT-BR** · [English](../../en/commands/changes-and-verification.md)

## Objetivo

Conduzir uma mudança desde a intenção registrada até uma decisão arquivada, ligando requisitos,
tarefas, sensores, evidência e verdict no grafo do cofre.

## Quando usar

Use para qualquer implementação não trivial ou correção que precise deixar prova auditável.

## Quando não usar

Não crie uma change para consultar saúde, importar sessões ou executar manutenção read-only.

## Pré-requisitos

Tenha o projeto inicializado, um vault saudável e `wendkeep.sensors.json` válido na raiz.

## Sintaxe

```bash
npx wendkeep change new <slug>
npx wendkeep change status [slug]
npx wendkeep spec effective --change <slug>
npx wendkeep sensors list
npx wendkeep verify [--deep] [--change <slug>]
npx wendkeep change archive <slug>
```

## Opções e códigos de saída

- `wendkeep change new <slug> [--simple]` cria proposta, design, tarefas e ponteiro ativo.
- `change use`, `list`, `show`, `status`, `diff`, `done` e `undone` inspecionam ou atualizam o
  trabalho sem arquivar.
- `change continue <arquivada> <nova>` abre continuação sem herdar evidência antiga.
- `change bind <slug> --session <id>` liga uma sessão existente.
- `change relink [--apply]` e `change backlink [--apply]` reparam o grafo; dry-run é o padrão.
- `change abandon <slug>` descarta sem ADR; `archive --force` exige decisão humana explícita.
- `wendkeep spec list|show|effective|migrate|rebase` administra contratos vivos e deltas.
- `wendkeep sensors list|add` administra provas executáveis.
- Exit `0` indica comando concluído; os gates usam exit `1` para prova vermelha e exit `2` para
  contexto/uso inválido.

## Exemplos

```bash
npx wendkeep change new login-tenant
npx wendkeep spec effective --change login-tenant
npx wendkeep change done 1.1 --change login-tenant
npx wendkeep verify --change login-tenant
npx wendkeep verify --deep --change login-tenant
npx wendkeep change archive login-tenant
```

Para adicionar um sensor:

```bash
npx wendkeep sensors add api-contracts "npm run test:contracts" --severity critical
```

## Resultado esperado

A change arquivada move seu delta para o spec vivo, preserva proposta/design/tarefas/evidência e
gera um ADR. O archive só passa com tarefas fechadas, sensores exigidos verdes e verdict atual.

## Erros comuns e diagnóstico

- `no change`: selecione com `change use <slug>` ou informe `--change`.
- `spec_impact: pending`: defina `required` com delta ou `none` com justificativa real.
- Sensor não executado: mantenha `[sensor:id]` na mesma linha do checkbox da tarefa.
- Evidência stale: rode novamente `verify` e `verify --deep` depois de alterar tarefas/spec.
- Rebase em conflito: resolva o delta ou use `--accept-current` apenas quando isso for a decisão.

## Próximos passos

Leia o guia profundo de [verify](verify.md) e a referência de
[manutenção e diagnóstico](maintenance-and-diagnostics.md).
