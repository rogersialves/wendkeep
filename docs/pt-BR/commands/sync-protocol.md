# Protocolo local-first de sync

**PT-BR** · [English](../../en/commands/sync-protocol.md)

## Objetivo

Sincronizar estado autorado e trabalho ativo entre máquinas sem transformar o backend em autoridade. O protocolo usa revisões, compare-and-swap (CAS), causalidade, outbox durável, leases expirantes e conflitos explícitos; não usa last-write-wins silencioso.

## Quando usar

Use `wendkeep sync push` e `pull` quando o mesmo projeto precisa compartilhar seu estado portátil entre dispositivos, branches ou worktrees. O sync é opcional e só cria runtime depois de uma operação de escrita.

## Quando não usar

Não use como backup de dados privados, transporte de transcripts ou substituto de Git. CORE, credenciais e runtime local não entram no protocolo. Conteúdo privado só pode ser enviado como envelope E2E autenticado.

## Pré-requisitos

O projeto deve estar vinculado a um Vault e possuir `.wendkeep/portable/state.json`, gerado por `wendkeep portable export`. Defina identidades estáveis de ator e dispositivo. Escolha um backend por `--remote` ou `--url`; tokens são lidos apenas da variável indicada por `--token-env`.

## Sintaxe

```text
wendkeep sync status [--project <dir>] [--json]
wendkeep sync push --actor <id> --device <id> (--remote <dir> | --url <url>)
wendkeep sync pull (--remote <dir> | --url <url>) [--no-import]
wendkeep sync conflicts [--json]
wendkeep sync resolve --record <chave> --select <evento> --reason <texto> --actor <id> --device <id> (--remote <dir> | --url <url>)
```

## Opções e códigos de saída

`--remote` usa o adaptador de referência em filesystem; `--url` usa HTTP substituível. `--token-env NOME` lê o segredo sem gravá-lo. `--no-import` baixa e valida sem aplicar ao estado portátil. O código `0` indica convergência, `1` falha operacional, `2` uso inválido ou conflito que exige decisão humana.

## Exemplos

```powershell
wendkeep portable export --project .
wendkeep sync push --project . --actor roger --device desktop --remote D:\wk-sync
wendkeep sync pull --project . --remote D:\wk-sync
wendkeep sync conflicts --project . --json
```

## Resultado esperado

Reenvios são idempotentes. Eventos fora de ordem aguardam seus pais causais. Escritas concorrentes da mesma revisão formam um conjunto de conflito estável, independente da ordem de chegada. Uma resolução gera novo evento e decisão auditável; tombstones e histórico de lease são preservados.

O `doctor`, o snapshot sanitizado do Observer e a superfície semântica MCP expõem apenas saúde, contagens e metadados de candidatos; payload autoral e caminhos locais não são retornados por essas consultas.

## Erros comuns e diagnóstico

Use `wendkeep doctor` e `wendkeep sync status`. `WENDKEEP_SYNC_BACKEND_UNAVAILABLE` mantém eventos no outbox para retry. `WENDKEEP_SYNC_OUTBOX_CORRUPT` bloqueia envio até revisão local. Conflitos aparecem em `sync conflicts` e nunca são resolvidos automaticamente.

Modelo de ameaças: entrega duplicada, replay e reordenação são neutralizados por hashes, IDs idempotentes, revisões e pais causais. Partições mantêm o outbox. Relógios de clientes não decidem o vencedor de lease. Backend malicioso pode omitir ou reter eventos, mas não pode forjar conteúdo sem quebrar hashes nem ler envelopes privados AES-256-GCM. Metadados de chaves e horários ainda podem vazar; perda de chave privada é irrecuperável. Rollback do backend é detectável por cursor/revisão, mas disponibilidade continua sendo responsabilidade do operador.

## Próximos passos

Revise conflitos com `wendkeep sync conflicts`, resolva-os explicitamente e confirme o estado com `wendkeep portable diff`. Veja também [Estado portátil](portable.md) e [Observer local](observer.md).
