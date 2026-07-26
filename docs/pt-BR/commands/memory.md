# Memória compartilhada e curadoria

**PT-BR** · [English](../../en/commands/memory.md)

## Objetivo

Inspecionar e curar CORE, SHARED, ledger, outbox e candidates sem confundir autoria canônica com
estado operacional gerado.

## Quando usar

Use no CI, antes de verify/archive, diante de avisos do doctor ou para decidir candidates.

## Quando não usar

Não edite `SHARED_MEMORY.md` ou `MEMORY_EVENTS.jsonl` à mão. Não use repair em vault legado que
apenas aguarda migração.

## Pré-requisitos

Informe o vault explicitamente em automações. Preserve backups e evidências antes de reparar.

## Sintaxe

```bash
npx wendkeep memory status [--gate] --vault <cofre>
npx wendkeep memory repair --vault <cofre>
npx wendkeep memory promote <candidate> --vault <cofre>
npx wendkeep memory reject <candidate> --vault <cofre>
npx wendkeep validate-memory [caminho-do-CORE]
npx wendkeep validate-memory --vault <cofre-v2>
```

## Opções e códigos de saída

- `memory status` é read-only; `--gate` retorna exit `1` apenas para estado bloqueante.
- Vault legado válido gera warning e exit `0`; corrupção, lag/hash divergente ou conflito ativo
  bloqueante gera exit `1`.
- `memory repair` trabalha sob lock, salva `.bak`, retém eventos válidos e reprojeta.
- `promote`/`reject` acrescentam decisão auditável; nunca reescrevem o ledger no lugar.
- `validate-memory <CORE.md>` valida cap de 25 linhas, seções e segredos.
- `validate-memory --vault` exige bundle v2 completo; não é o gate correto para vault legado.

## Exemplos

```bash
npx wendkeep memory status --gate --vault .MeuApp-vault
npx wendkeep validate-memory .MeuApp-vault/.brain/CORE.md
npx wendkeep memory promote candidate-123 --vault .MeuApp-vault
```

## Resultado esperado

O status imprime schema, revision, cursor, hash, eventos, outbox, candidates e conflitos. CORE
permanece canônico e curado à mão; SHARED permanece projeção operacional verificável.

## Erros comuns e diagnóstico

- `legacy`: siga o guia de migração; não é corrupção.
- Candidate pendente comum: warning recuperável, exige decisão humana quando apropriado.
- `event_cursor` ausente ou hash divergente em v2: preserve o bundle e avalie `memory repair`.
- `validate-memory --vault` falha no legado: valide apenas CORE ou migre primeiro.

## Próximos passos

Leia [migração de memória](memory-migration.md), [manutenção](maintenance-and-diagnostics.md) e
[verify](verify.md).
