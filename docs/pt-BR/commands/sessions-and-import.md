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
npx wendkeep hook session-backfill --session <id> [--write]
npx wendkeep import [opções]
```

## Opções e códigos de saída

- `wendkeep hook <name>` lê o payload do agente em stdin; nomes válidos aparecem em `--help`.
- `SessionStart` abre uma activation, isto é, um epoch que continua ativo por vários `Stop`; só um
  novo `SessionStart` torna o epoch anterior superseded.
- `UserPromptSubmit` do agente principal avança o turno nativo da activation ativa. Um prompt de
  rollout Codex com `source.subagent` apenas registra o path para observabilidade: não avança a
  sequência, não entra em `turn_sequences` e não substitui o transcript principal. Se o prompt
  principal encontra um registry legado com o epoch fechado, abre exatamente uma activation de
  recuperação; repetir o mesmo prompt não abre outra.
- No Codex, `session_id` e o `turn_id` nativo bastam para resolver o turno. O Stop prova o ID no
  transcript e prefere `SESSION_REGISTRY.turn_sequences[turn_id]`; a ordem local do transcript é
  fallback para registry legado. Assim, turnos intercalados de subagents não tornam o Stop da mãe
  artificialmente `stale_turn`. O payload não precisa inventar `activation_id` ou `turn_sequence`.
- `Stop` aceita somente o turno comprovado pelo transcript e pela activation ativa compatível.
  Duplicatas são no-op; Stops stale/superseded não publicam memória nem sobrescrevem o checkpoint
  de um epoch mais novo.
- `Stop` recebe deadline absoluto de **45 s** desde a entrada do hook. A leitura verifica o relógio
  entre rollouts e a cada chunk; ao atingir o limite, devolve `degraded` antes do timeout do host.
- `SubagentStop` recebe deadline absoluto de **15 s** e resolve o rollout filho pelo campo oficial
  Codex `agent_transcript_path` (também aceita `agentTranscriptPath`); `transcript_path` continua
  identificando a sessão-mãe. Antes de qualquer escrita, `source.subagent`, ID, sessão canônica e
  `parent_thread_id` são validados; o pai deve corresponder a um root comprovado da sessão. Sinais
  que chegam na janela de **250 ms** são coalescidos: somente a maior sequência
  recompõe/publica, sem perder o último filho.
- A observabilidade usa tri-state: `complete` publica o snapshot integral; `none` representa zero
  comprovado por Stop causal ou scan offline estável; `degraded` preserva o snapshot anterior e
  diagnostics allowlisted. `SubagentStop` isolado nunca publica `none`.
- Cada tentativa terminal de `Stop`/`SubagentStop` deixa um recibo sanitizado em
  `.brain/SESSION_ITERATION_OUTCOMES.jsonl`, indexado por sessão, `turn_id` e estágio. Os estados
  distinguem `inserted`, `duplicate`, `skipped`, `aborted`, `busy`, `failed` e os status de
  observabilidade; o cursor só avança depois da confirmação da nota. O ledger é local, append-only,
  idempotente e nunca persiste prompt, payload, argumento bruto ou erro bruto.
- No Codex, `subagent_notification` continua sintético, `turn_aborted` é terminal explícito e
  `custom_tool_call_output` fecha a chamada existente sem contar uma segunda ferramenta.
- Ao compactar conversas em `## Iterações`, o hook escapa delimitadores de código cortados pelo
  limite de tamanho; backticks inline ou fences nunca ficam abertos para engolir a linha seguinte.
- `session list` lê `SESSION_REGISTRY`; `show` exibe uma sessão e `use` muda apenas o foco humano
  em `CURRENT_SESSION.md`.
- `import --source all|claude|codex`, `--since`, `--limit`, `--from` e `--codex-from` limitam escopo.
- `--dry-run`/`--json` permitem auditar antes de gravar; `--stamp-ids` e `--rescan-decisions`
  corrigem históricos específicos.
- `import` reconcilia a observabilidade mesmo quando nenhum `wk-turn` está ausente: schema legado,
  frontier stale ou manifest não comprovado disparam recomposição sem duplicar iterações. Um
  checkpoint fresco permanece byte-idêntico; `degraded` é reportado e não altera a nota.
- No encerramento definitivo, o Stop fecha a activation e a sessão como `done` no
  `SESSION_REGISTRY.json` depois de memória/observabilidade; `CURRENT_SESSION.md` é uma visão
  derivada e deixa de listar a sessão finalizada. Hooks resolvem identidade pelo registry e pelo
  transcript, nunca pelo ponteiro global.
- `hook session-backfill` recupera `wk-turn` ausente da sessão selecionada. Sem `--write`, apenas
  relata. Em Codex, `missingTurns` contém somente turnos com `task_complete`; turnos ainda abertos
  aparecem em `incompleteTurns` e nunca são gravados. `--write` aplica apenas os candidatos
  concluídos e uma segunda execução é idempotente.
- Exit `0` indica processamento consistente; exit não zero indica configuração, fonte ou escrita
  inválida sem transformar isso em sucesso parcial silencioso.

## Exemplos

```bash
npx wendkeep session list
npx wendkeep session show 019abc-session-id
npx wendkeep hook session-backfill --session 019abc-session-id
npx wendkeep hook session-backfill --session 019abc-session-id --write
npx wendkeep import --source codex --since 2026-07-01 --dry-run --json
```

## Resultado esperado

Cada sessão canônica aponta para provider, transcript, arquivo de nota e custos correspondentes.
O registry mantém um epoch de `SessionStart` por activation e o turno nativo mais recente; vários
`Stop` podem confirmar turnos do mesmo epoch sem fechá-lo. Importações repetidas do mesmo
`session_id` são deduplicadas; o foco humano não encerra nem altera a identidade dos hooks. Cada
iteração automática permanece Markdown válido mesmo quando uma fala precisa ser truncada.
Metadados internos terminais completos ou truncados são removidos somente das mensagens do
assistente; uma reprodução escrita pelo usuário permanece no transcript. Na nota, tags XML-like
são codificadas como texto visível — inclusive placeholders como `<session>` — sem alterar
autolinks `<https://...>`. Reimport e `SessionStop` compartilham o mesmo normalizador idempotente;
ao finalizar uma nota antiga, somente campos gerados reconhecíveis em `Iterações` e
`Encerramento` são migrados, sem reescrever a prosa autoral. Hooks
duplicados/stale convergem no mesmo frontier, e importações podem atualizar só a observabilidade
sem criar um novo bloco de turno.
O recibo de cada tentativa em `SESSION_ITERATION_OUTCOMES.jsonl` permite diferenciar uma duplicata
confirmada de um lock ocupado ou de um caminho que foi pulado, sem reabrir a sessão original.

## Erros comuns e diagnóstico

- Sessão ausente: confira provider, path do transcript e registry antes de importar novamente.
- `Stop ambiguous`: o `turn_id` não foi comprovado pelo transcript ou nenhuma activation ativa
  compatível foi encontrada; o attempt fica observável, mas não publica memória.
- Stop atrasado aparece como `stale_turn`/`superseded`: o epoch mais novo e seu checkpoint são
  preservados; não force a reaplicação do payload antigo.
- `session-backfill` lista `incompleteTurns`: aguarde o `task_complete`/Stop desse turno e repita;
  não edite a nota nem force o turno parcial. Quando o mesmo turno recebe `task_complete`, a
  próxima execução passa a considerá-lo elegível. Transcripts Claude preservam o contrato
  histórico e não exigem esse evento Codex.
- Duplicatas de forks: limite por fonte/data e revise `forked_from_id`/`source.subagent`.
- Codex não captura: aprove os hooks e reinicie a sessão após `sync`.
- Custo contaminado: valide `session_id → session_file → transcript_path → provider`.
- Observabilidade `degraded`: preserve a nota e rode o rebuild direcionado em dry-run; não force
  um snapshot parcial sobre o último `complete`.
- Ledger de resultado ausente ou com `busy`: preserve o transcript e a nota, confira o lock do Vault
  e repita o hook/replay limitado; nunca marque o turno como projetado manualmente.

## Próximos passos

Leia [Perfis de Operação](operating-profiles.md), [importação retroativa](retroactive-import.md),
[custos e observabilidade](costs-and-observability.md) e [notas](notes-and-knowledge.md).
