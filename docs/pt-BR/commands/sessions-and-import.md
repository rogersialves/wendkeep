# Sessões, hooks e importação

**PT-BR** · [English](../../en/commands/sessions-and-import.md)

## Objetivo

Entender como hooks capturam sessões ao vivo, como o registry seleciona conversas e quando usar a
importação retroativa.

## Quando usar

Use `session` para inspecionar/focar uma conversa e `import` para recuperar sessões anteriores à
instalação ou fora do registry atual.

## Quando não usar

Não invoque hooks manualmente sem o envelope JSON esperado. Não use import amplo antes de uma
prévia quando existirem forks/subagents possivelmente duplicados.

## Pré-requisitos

Hooks instalados para captura ao vivo; para import, acesso local aos diretórios de transcripts do
Claude/Codex e um vault vinculado ao projeto correto.

## Sintaxe

```bash
npx wendkeep hook <nome>
npx wendkeep session list
npx wendkeep session show <id>
npx wendkeep session use <id>
npx wendkeep import [opções]
```

## Opções e códigos de saída

- `wendkeep hook <name>` lê o payload do agente em stdin; nomes válidos aparecem em `--help`.
- `session list` lê `SESSION_REGISTRY`; `show` exibe uma sessão e `use` muda apenas o foco humano
  em `CURRENT_SESSION.md`.
- `import --source all|claude|codex`, `--since`, `--limit`, `--from` e `--codex-from` limitam escopo.
- `--dry-run`/`--json` permitem auditar antes de gravar; `--stamp-ids` e `--rescan-decisions`
  corrigem históricos específicos.
- Exit `0` indica processamento consistente; exit não zero indica configuração, fonte ou escrita
  inválida sem transformar isso em sucesso parcial silencioso.

## Exemplos

```bash
npx wendkeep session list
npx wendkeep session show 019abc-session-id
npx wendkeep import --source codex --since 2026-07-01 --dry-run --json
```

## Resultado esperado

Cada sessão canônica aponta para provider, transcript, arquivo de nota e custos correspondentes.
Importações repetidas do mesmo `session_id` são deduplicadas; o foco humano não encerra nem altera
a identidade da sessão ativa dos hooks.

## Erros comuns e diagnóstico

- Sessão ausente: confira provider, path do transcript e registry antes de importar novamente.
- Duplicatas de forks: limite por fonte/data e revise `forked_from_id`/`source.subagent`.
- Codex não captura: aprove os hooks e reinicie a sessão após `sync`.
- Custo contaminado: valide `session_id → session_file → transcript_path → provider`.

## Próximos passos

Leia [importação retroativa](retroactive-import.md),
[custos e observabilidade](costs-and-observability.md) e [notas](notes-and-knowledge.md).
