# Sessões, hooks e importação

**PT-BR** · [English](../../en/commands/sessions-and-import.md)

## Objetivo

Entender como os hooks capturam sessões ao vivo, como activation/turno preservam causalidade no
registry e quando usar a importação retroativa. No perfil `OFF`, o Vault continua ativo: hooks de
sessão, identidade, memória, custos e persistência pertencem ao Keep Core, não ao Wend Runtime.

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
- `SessionStart` abre uma activation, isto é, um epoch que continua ativo por vários `Stop`; só um
  novo `SessionStart` torna o epoch anterior superseded.
- `UserPromptSubmit` avança o turno nativo da activation ativa. Se encontrar um registry legado
  com o epoch fechado, abre exatamente uma activation de recuperação; repetir o mesmo prompt não
  abre outra.
- No Codex, `session_id`, o `turn_id` nativo e a ordem observada no transcript bastam para resolver
  o turno. O payload do hook não precisa inventar `activation_id` nem `turn_sequence`.
- `Stop` aceita somente o turno comprovado pelo transcript e pela activation ativa compatível.
  Duplicatas são no-op; Stops stale/superseded não publicam memória nem sobrescrevem o checkpoint
  de um epoch mais novo.
- Ao compactar conversas em `## Iterações`, o hook escapa delimitadores de código cortados pelo
  limite de tamanho; backticks inline ou fences nunca ficam abertos para engolir a linha seguinte.
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
O registry mantém um epoch de `SessionStart` por activation e o turno nativo mais recente; vários
`Stop` podem confirmar turnos do mesmo epoch sem fechá-lo. Importações repetidas do mesmo
`session_id` são deduplicadas; o foco humano não encerra nem altera a identidade dos hooks. Cada
iteração automática permanece Markdown válido mesmo quando uma fala precisa ser truncada.

## Erros comuns e diagnóstico

- Sessão ausente: confira provider, path do transcript e registry antes de importar novamente.
- `Stop ambiguous`: o `turn_id` não foi comprovado pelo transcript ou nenhuma activation ativa
  compatível foi encontrada; o attempt fica observável, mas não publica memória.
- Stop atrasado aparece como `stale_turn`/`superseded`: o epoch mais novo e seu checkpoint são
  preservados; não force a reaplicação do payload antigo.
- Duplicatas de forks: limite por fonte/data e revise `forked_from_id`/`source.subagent`.
- Codex não captura: aprove os hooks e reinicie a sessão após `sync`.
- Custo contaminado: valide `session_id → session_file → transcript_path → provider`.

## Próximos passos

Leia [Perfis de Operação](operating-profiles.md), [importação retroativa](retroactive-import.md),
[custos e observabilidade](costs-and-observability.md) e [notas](notes-and-knowledge.md).
