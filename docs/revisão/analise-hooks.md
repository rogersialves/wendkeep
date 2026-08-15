# Análise da cadeia de hooks

## Fluxo observado

```text
UserPromptSubmit
  -> session-ensure
  -> avança identidade e sequência no SESSION_REGISTRY

modelo / subagentes

Stop
  -> session-stop
       -> resolve identidade e transcript
       -> faz staging causal/memória
       -> insertIteration()
       -> refreshObservability()
       -> finaliza ou mantém a sessão

SubagentStop (paralelo)
  -> subagent-stop
  -> grava telemetria/observabilidade na mesma superfície do Vault
```

A configuração do consumidor fica fora do repositório; o contrato instalado pelo WendKeep
está no [registro de hooks](../../packages/integrations/src/host-hooks.mjs#L8-L22).

## Pontos de acionamento

| Evento | Hook | Evidência |
|---|---|---|
| `SessionStart` `startup\|clear\|compact` | `brain-inject` | [host-hooks.mjs:8-14](../../packages/integrations/src/host-hooks.mjs#L8-L14) |
| `SessionStart` `startup` | `session-start` | [host-hooks.mjs:15](../../packages/integrations/src/host-hooks.mjs#L15) |
| `UserPromptSubmit` | `session-ensure` | [host-hooks.mjs:16-17](../../packages/integrations/src/host-hooks.mjs#L16-L17) |
| `Stop` | `session-stop` | [host-hooks.mjs:16](../../packages/integrations/src/host-hooks.mjs#L16) |
| `SubagentStop` | `subagent-stop` | [host-hooks.mjs:21-22](../../packages/integrations/src/host-hooks.mjs#L21-L22) |

`change-context` e `change-nag` também rodam em `UserPromptSubmit`/`Stop`, mas não são
os responsáveis pelo bloco de iteração.

## Falha 1 — escrita concorrente pode ser perdida

O lock de nota espera até 2 segundos e retorna `LOCK_BUSY` quando não consegue entrar:
[session-note-io.mjs:120-175](../../hooks/session-note-io.mjs#L120-L175).

`mutateSessionNote()` converte esse resultado em `{ written: false, reason: 'busy' }`:
[session-note-io.mjs:177-209](../../hooks/session-note-io.mjs#L177-L209).

Quando a projeção descarta esse retorno, o callback não executa, a inserção permanece falsa e
o `session-stop` pode continuar sem retry, outbox ou erro persistido. O mecanismo permite,
portanto, que um turno termine sem marcador visível.

A ocorrência específica da sessão de referência não pode ser provada com os artefatos
versionados; o diagnóstico descreve o mecanismo, não atribui uma causa além da evidência.

## Falha 2 — saída antes da inserção

`shouldAbortStopAfterStaging()` pode interromper o fluxo quando a decisão causal ou o staging
de memória não pode prosseguir: [session-stop.mjs:907-915](../../hooks/session-stop.mjs#L907-L915).

Essa decisão ocorre antes de `insertIteration()`:
[session-stop.mjs:1270-1281](../../hooks/session-stop.mjs#L1270).

Sem um resultado durável, uma saída legítima fica visualmente semelhante a uma perda. Os
estados `skipped`, `duplicate`, `ambiguous` e `not_projected` precisam ser associados ao turno.

## Falha 3 — `refreshObservability()` não é tratado como resultado crítico

O publisher pode retornar `stale`, `conflict`, `degraded`, `missing`, `busy` ou `published`
conforme as relações de fronteira e o resultado do lock:
[session-observability.mjs:553-675](../../hooks/session-observability.mjs#L553-L675).

Se `refreshStopObservability()` reduz esses estados a falso e o chamador não persiste o
diagnóstico, `observability_dirty: true` fica sem caminho de recuperação observável.

## Falha 4 — parser confunde eventos sintéticos com prompts

Quando o filtro não classifica `subagent_notification` como evento sintético, uma mensagem
aceita como `user` entra em `userPrompts` e na conversa do turno:
[transcripts.mjs:217-255](../../packages/integrations/src/transcripts.mjs#L217-L255).

O título do bloco deriva do último prompt associado ao turno:
[session-stop.mjs:314-347](../../hooks/session-stop.mjs#L314-L347). Uma notificação de
subagente pode então virar título, pedido e fonte do resumo da iteração.

## Falha 5 — parser não cobre o formato de ferramenta usado pelo Codex

Se o parser reconhece `function_call`, `tool_search_call` e `web_search_call`, mas não
`custom_tool_call`, chamadas `exec` ficam fora da contagem ou geram uma lista incompleta.
O parser de uso precisa compartilhar a mesma normalização:
[token-usage.mjs:319-385](../../hooks/token-usage.mjs#L319-L385).

## Conclusão técnica

O registro causal é mais confiável que a nota como fonte de presença do turno: ele pode
conservar uma sequência contínua mesmo quando a projeção Markdown fica incompleta. A cadeia
de identidade funciona até o registro; a perda ocorre no caminho
`Stop -> staging -> escrita da nota -> observabilidade`, ou no tratamento de um turno
interrompido.

## Falha 6 — ação Git sem cerca de escopo

O segundo achado é diferente da perda de um marcador: uma sessão permaneceu identificada no
seu Vault, mas uma ferramenta executou Git no repositório WendKeep. A autorização existia para
uma change imediata do WendKeep; faltou confirmação mecânica quando o assunto voltou ao
projeto consumidor.

### O que os hooks protegem

O binding resolve o Vault a partir do projeto e valida o `projectId` contra
`.brain/PROJECT.json`: [project-vault.mjs:198-215](../../packages/vault/src/project-vault.mjs#L198-L215).
O `session-start` reutiliza a nota pelo `session_id` e pelo transcript, evitando split de sessão:
[session-start.mjs:221-252](../../hooks/session-start.mjs#L221-L252).

### O que não está protegido

1. A identidade de sessão resolve provider, transcript e conversa, mas não exige `projectId`,
   raiz do repositório, remoto ou branch
   ([session-identity.mjs:68-170](../../packages/integrations/src/session-identity.mjs#L68-L170)).
2. A camada de hooks do agente pode não registrar um `PreToolUse` para Git.
3. Mesmo quando acionado, um guard de mudança precisa validar remoto/branch e tratar `commit`,
   `push` e `pull` como autorizações separadas.
4. `session-stop` captura `process.cwd()` e `projectId` no encerramento, mas isso é telemetria
   posterior, não uma barreira antes da mutação
   ([session-stop.mjs:108-127](../../hooks/session-stop.mjs#L108-L127)).

### Interação com sessões paralelas

`CURRENT_SESSION` é uma visão e não deve ser a identidade primária. Mesmo com o roteamento
correto da nota, duas conversas podem compartilhar o mesmo processo de ferramenta e selecionar
`workdir` diferentes. O risco relevante é executar uma ação Git autorizada em um contexto de
projeto diferente daquele que o usuário está visualizando.

### Conclusão atualizada

O caminho `SessionStart -> session-ensure -> session-stop` identifica e projeta a sessão do
Vault, mas não é sozinho uma fronteira de segurança para ferramentas Git. A correção precisa
envolver a camada de execução, exigir escopo de projeto em cada ação mutável e tratar `commit`,
`push` e `pull` como autorizações independentes.
