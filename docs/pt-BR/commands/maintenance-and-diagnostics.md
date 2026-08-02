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
npx --no-install wendkeep doctor [--vault <cofre>]
npx --no-install wendkeep sync-defs [--check|--reseed] --vault <cofre> --project <raiz>
npx --no-install wendkeep theme sync --vault <cofre>
npx --no-install wendkeep --version
npx --no-install wendkeep --help
```

## Opções e códigos de saída

- `doctor` é read-only; exit `0` aceita warnings recuperáveis e exit não zero indica falha.
- Em v2, `doctor`/`memory status --gate` correlacionam `last_memory_attempt` (mode, disposition,
  event IDs e checkpoint) com outbox, ledger e SHARED; não inferem saúde só pela revision atual.
- `revision: 0` após migração válida, sem attempt v2, é saudável. Attempt `degraded` cujos eventos
  continuam duráveis na outbox/ledger é warning recuperável.
- Attempt ambíguo, event ID perdido (ausente de ledger e outbox), estado `projected` apenas na
  outbox ou checkpoint divergente são falhas bloqueantes.
- Para observabilidade de sessão, `legacy`, `degraded`, `stale` e `manifest-unproven` exigem
  reconciliação ou evidência adicional. Somente `none` fresco e `complete` fresco são saudáveis:
  frontier, checkpoint, root stat e source manifest precisam concordar.
- O `doctor` permanece somente leitura/read-only. Ele recomenda primeiro o dry-run direcionado;
  somente depois da revisão humana orienta repetir com `--apply`.
- `sync-defs --check` detecta drift sem gravar; `--reseed` restaura skills `wk-*` do pacote.
- `theme sync` reaplica snippet CSS e grupos do grafo sem recriar o cofre.
- `wendkeep --version` imprime a versão executada; `wendkeep --help` lista a interface pública.

## Exemplos

Checklist pós-atualização:

```bash
npx --no-install wendkeep --version
npx --no-install wendkeep sync-defs --check --vault .MeuApp-vault --project .
npx --no-install wendkeep doctor --vault .MeuApp-vault
npx --no-install wendkeep memory status --gate --vault .MeuApp-vault
npx --no-install wendkeep memory candidates --active --vault .MeuApp-vault
npx --no-install wendkeep cost rebuild --session <id> --json --vault .MeuApp-vault
npx --no-install wendkeep cost rebuild --session <id> --json --vault .MeuApp-vault --apply
```

## Resultado esperado

O doctor nomeia sessões, registry, links, notas, preços, derivadas e memória como saudáveis ou
fornece um comando específico de diagnóstico/reparo. Na memória, ele distingue vazio inicial
válido, replay pendente recuperável e lifecycle perdido/divergente. Nenhum reparo é aplicado
implicitamente nem o conteúdo privado do erro do projector é reproduzido no relatório. Na
observabilidade de sessão, ele separa `none`/`complete` frescos de estado legado, degradado, stale
ou sem manifest comprovado e oferece um caminho dry-run antes de qualquer escrita.

## Erros comuns e diagnóstico

- `no vault`: execute da raiz vinculada ou passe `--vault`.
- `defs stale`: confirme a versão e rode `sync-defs --reseed`.
- Vault legado: é warning não bloqueante; o doctor mostra
  `npx --no-install wendkeep memory migrate --apply --vault <cofre>` com o Vault resolvido, mas a
  migração continua sendo opt-in e deve ser planejada separadamente.
- `degraded` + outbox íntegra: warning; preserve a outbox e permita replay idempotente.
- `ambiguous`, publicação perdida ou checkpoint divergente: bloqueante; preserve registry, ledger,
  outbox e SHARED para correlacionar `last_memory_attempt` antes de reparar.
- Bundle corrompido: preserve a evidência e use `memory status --gate` antes de `memory repair`.
- Conflito semântico ativo exige decisão humana: `memory repair` não escolhe vencedor. Liste os IDs
  seguros com `memory candidates --active --vault <cofre>`, revise a evidência e então use
  `memory promote <candidate-id> --event <event-id> --vault <cofre>` para selecionar um evento ou
  `memory reject <candidate-id> --vault <cofre>` para manter o valor operacional atual.
- Observabilidade `legacy`/`degraded`/`stale`/`manifest-unproven`: rode
  `npx --no-install wendkeep cost rebuild --session <id> --json --vault <cofre>`, revise diagnostics
  e só então autorize a segunda variante com `--apply`.

## Próximos passos

Veja [instalação e primeiro uso](getting-started.md), [memória](memory.md) e
[verificação de changes](verify.md).
