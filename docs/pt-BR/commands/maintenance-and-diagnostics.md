# Manutenção e diagnóstico

**PT-BR** · [English](../../en/commands/maintenance-and-diagnostics.md)

## Objetivo

Inspecionar a saúde do cofre e manter definições, tema e versão alinhados sem usar comandos de
change como teste global.

## Quando usar

Use depois de instalar/atualizar, diante de warnings dos hooks ou antes de iniciar uma change.

## Quando não usar

Não use `wendkeep verify` quando nenhuma change estiver ativa. Ele prova tarefas de uma change;
não substitui o doctor.

## Pré-requisitos

Execute na raiz do projeto ou informe `--project`/`--vault` explicitamente.

## Sintaxe

```bash
npx wendkeep doctor [--vault <cofre>]
npx wendkeep sync-defs [--check|--reseed] --vault <cofre> --project <raiz>
npx wendkeep theme sync --vault <cofre>
npx wendkeep --version
npx wendkeep --help
```

## Opções e códigos de saída

- `doctor` é read-only; exit `0` aceita warnings recuperáveis e exit não zero indica falha.
- `sync-defs --check` detecta drift sem gravar; `--reseed` restaura skills `wk-*` do pacote.
- `theme sync` reaplica snippet CSS e grupos do grafo sem recriar o cofre.
- `wendkeep --version` imprime a versão executada; `wendkeep --help` lista a interface pública.

## Exemplos

Checklist pós-atualização:

```bash
npx wendkeep --version
npx wendkeep sync-defs --check --vault .MeuApp-vault --project .
npx wendkeep doctor --vault .MeuApp-vault
npx wendkeep memory status --gate --vault .MeuApp-vault
```

## Resultado esperado

O doctor nomeia sessões, registry, links, notas, preços, derivadas e memória como saudáveis ou
fornece um comando específico de diagnóstico/reparo. Nenhum reparo é aplicado implicitamente.

## Erros comuns e diagnóstico

- `no vault`: execute da raiz vinculada ou passe `--vault`.
- `defs stale`: confirme a versão e rode `sync-defs --reseed`.
- Vault legado: é warning não bloqueante; planeje `memory migrate --apply` separadamente.
- Bundle corrompido: preserve a evidência e use `memory status --gate` antes de `memory repair`.

## Próximos passos

Veja [instalação e primeiro uso](getting-started.md), [memória](memory.md) e
[verificação de changes](verify.md).
