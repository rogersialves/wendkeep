# Migração de memória legada para v2

**PT-BR** · [English](../../en/commands/memory-migration.md)

## Objetivo

Converter um `SHARED_MEMORY.md` legado em bundle v2 auditável sem sobrescrever CORE nem promover
relatos antigos silenciosamente.

## Quando usar

Use quando `memory status` retorna `legacy` e a equipe está pronta para curar o conteúdo convertido.

## Quando não usar

Não migre automaticamente durante `init`, `sync`, SessionStop ou como tentativa de silenciar um
warning. Não aplique enquanto um backup/estado esperado não estiver claro.

## Pré-requisitos

- CORE válido e bytes legados preservados.
- Vault sem corrupção v2 parcial.
- Revisão humana dos candidates que serão criados.

## Sintaxe

```bash
npx wendkeep memory status --gate --vault <cofre>
npx wendkeep memory migrate --vault <cofre>
npx wendkeep memory migrate --apply --vault <cofre>
```

## Opções e códigos de saída

- Sem `--apply`, `wendkeep memory migrate` é dry-run e não grava.
- `--apply` cria backup, converte conteúdo legado em candidates e publica bundle v2 válido.
- Exit `0` indica prévia/aplicação consistente; exit diferente de zero preserva o estado original
  e informa a falha.

## Exemplos

```bash
npx wendkeep memory migrate --vault .MeuApp-vault
# revise a prévia
npx wendkeep memory migrate --apply --vault .MeuApp-vault
npx wendkeep memory status --gate --vault .MeuApp-vault
```

## Resultado esperado

O vault recebe ledger/projeção v2 coerentes, backup do SHARED legado e candidates para fatos sem
evidência. CORE não é editado e conteúdo não verificado não vira estado ativo automaticamente.

## Erros comuns e diagnóstico

- Dry-run mostra vault já v2: não aplique novamente.
- Bundle v2 parcial/corrompido: use status e repair; migração não é ferramenta de corrupção.
- Candidates numerosos: curate gradualmente com `memory promote`/`memory reject`.
- Warning legado após apply: confirme o vault efetivamente selecionado e o vínculo do projeto.

## Próximos passos

Volte para [memória e curadoria](memory.md) e execute
[manutenção e diagnóstico](maintenance-and-diagnostics.md).
