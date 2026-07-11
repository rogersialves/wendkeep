# Fase 2 — hooks multiagente

## Visão geral

- Data: 2026-07-10
- Prioridade: P0
- Status: concluída em 2026-07-11
- Dependência: Fase 1

Trocar a injeção exclusiva da change atual por uma visão global, preservando ponteiro único,
sentinelas por sessão e bloqueio de Stop restrito à atual.

## Requisitos

- `SessionStart` injeta `<open_changes>` com todas as pendências.
- `UserPromptSubmit` injeta `<open_changes_ping>` quando o hash global mudar.
- Sentinela `ctx` continua isolada por `session_id`.
- Nenhuma diferença de conteúdo baseada em `provider`.
- `change-nag` bloqueia somente pelas tarefas da change atual.
- Sem changes, `wk_skill_gate` mantém o comportamento atual.

## Arquivos

- Modificar `C:\GitHub\WendKeep\hooks\brain-inject.mjs`.
- Modificar `C:\GitHub\WendKeep\hooks\change-context.mjs`.
- Revisar `C:\GitHub\WendKeep\hooks\change-nag.mjs` e alterar apenas texto/testes se necessário.
- Modificar `C:\GitHub\WendKeep\tests\change-hooks.test.mjs`.
- Modificar `C:\GitHub\WendKeep\tests\process-router.test.mjs`.

## Fluxo

1. `brain-inject` chama `allChangesState` e renderiza todas as changes.
2. Grava na sentinela da sessão o hash global recém-injetado.
3. `change-context` recalcula o hash a cada prompt.
4. Hash igual: silêncio. Hash diferente: reinjeção global.
5. `change-nag` continua usando `quickGateState`, que consulta `CURRENT_CHANGE.md`.

## Passos

1. Criar teste SessionStart com A atual e B aberta; exigir todos os IDs.
2. Criar teste UserPromptSubmit: alterar tarefa de B deve reinjetar.
3. Criar teste de troca do ponteiro A→B.
4. Criar teste Claude/Codex com entradas diferentes e saída global equivalente.
5. Integrar renderer comum nos dois hooks.
6. Confirmar anti-loop e gate sem change.
7. Confirmar que Stop não bloqueia A por B.

## Aceite

- Toda sessão recebe backlog completo.
- Uma mudança de qualquer `tarefas.md` invalida a sentinela.
- Provider não muda visibilidade.
- Stop e verify não viram gates globais.

## Riscos

- Repetição excessiva: hash global + sentinela preservam quiet-by-default.
- Contexto grande: renderer compacto, uma linha por tarefa, sem truncamento oculto.

## Segurança

- Hooks permanecem fail-open em erro de leitura/escrita.
- Nenhum hook altera `tarefas.md` ou o ponteiro.

## Todo

- [ ] Testes de injeção global.
- [ ] Integração SessionStart.
- [ ] Integração UserPromptSubmit.
- [ ] Regressão Stop/gate.
