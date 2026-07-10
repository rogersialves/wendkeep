# Visibilidade global de pendências com ponteiro único

## Contexto

O WendKeep permite que existam várias mudanças abertas em `08-Mudanças`, mas usa
`.brain/CURRENT_CHANGE.md` como ponteiro global para a mudança em foco. Atualmente, os hooks de
contexto, o aviso de encerramento e os comandos sem `--change` consultam apenas esse ponteiro.

Quando Claude Code trabalha na change A e Codex trabalha na change B, trocar o ponteiro faz a LLM
seguinte enxergar somente a mudança atual. As demais mudanças continuam no vault, porém suas
pendências não entram no contexto operacional. Isso dificulta retomar no Claude uma change iniciada
no Codex, ou o inverso.

## Objetivo

Manter um único ponteiro global e, ao mesmo tempo, tornar todas as mudanças e tarefas abertas
visíveis para qualquer LLM nos hooks e no CLI.

## Decisões

1. `.brain/CURRENT_CHANGE.md` continua com o formato `change: <slug>` e permanece como fonte única
   da mudança em foco.
2. O provedor da sessão não determina propriedade. Claude, Codex ou outro agente podem visualizar,
   atualizar, verificar e concluir qualquer change.
3. Visibilidade global não significa gate global: `done`, `verify`, `archive` e `abandon` sem
   `--change` atuam somente na change apontada.
4. Pendências de uma change não podem bloquear o encerramento ou archive de outra.
5. A lista global é calculada a partir das pastas ativas e de seus `tarefas.md`; não será mantido um
   segundo índice persistente.

## Modelo de dados derivado

`change-core.mjs` fornecerá uma projeção das mudanças abertas. Cada item terá:

- `slug`;
- `current`, verdadeiro somente para o slug de `CURRENT_CHANGE.md`;
- tarefas abertas, sem filtro por provedor ou sessão;
- total de tarefas concluídas e abertas;
- aviso de leitura, quando `tarefas.md` estiver ausente ou ilegível.

A projeção será ordenada com a change atual primeiro e as demais por slug. Um hash global estável
será calculado com o ponteiro, slugs e conteúdo relevante de todas as listas de tarefas. Assim, os
hooks reinjetam o contexto quando uma tarefa de qualquer change mudar ou quando o ponteiro trocar.

## Hooks

### SessionStart

`brain-inject` substituirá a injeção exclusiva `<active_change>` por `<open_changes>`:

- identifica explicitamente a change `ATUAL`;
- lista todas as changes abertas;
- mostra todas as tarefas pendentes de cada change;
- informa que comandos sem `--change` usam o ponteiro global;
- informa que uma change pode ser assumida por outro agente.

Não haverá limite global silencioso que esconda changes ou tarefas. Se for necessário proteger o
budget, a saída poderá ser compactada por tarefa em uma linha, mas todos os IDs pendentes deverão
permanecer visíveis.

### UserPromptSubmit

`change-context` usará o hash da projeção global. Quando qualquer change, tarefa ou ponteiro mudar,
o hook reinjetará `<open_changes_ping>` com a mesma visão global. A sentinela continuará sendo por
sessão para evitar repetição sem mudança de estado.

### Stop

`change-nag` continuará examinando apenas a change atual. O texto do bloqueio deverá mencionar o
slug e poderá lembrar que as demais changes continuam abertas, mas nunca bloqueará A por pendências
de B.

## CLI

### `wendkeep change list`

Exibirá todas as changes abertas, com a atual primeiro, contagens e cada tarefa pendente. Changes
arquivadas continuam resumidas separadamente.

### `wendkeep change status`

- sem slug: mostra a visão global de todas as changes abertas;
- com slug: mantém o detalhe de uma única change;
- a change atual é sempre marcada explicitamente.

### Comandos mutáveis e verificação

`change done`, `change undone`, `verify`, `archive` e `abandon` preservam a regra atual:

- sem `--change`, usam `CURRENT_CHANGE.md`;
- com slug ou `--change`, operam sobre a change indicada, quando o comando já oferece esse formato.

Executar `wendkeep change new <slug-existente>` mantém os arquivos e torna essa change a atual. Esse
é o fluxo explícito para uma LLM assumir como foco uma change iniciada por outra.

## Falhas e consistência

- Ponteiro vazio: todas as changes são listadas, sem marca `ATUAL`; comandos implícitos continuam
  recusados.
- Ponteiro órfão: a projeção lista as changes existentes e emite aviso sobre o slug ausente.
- `tarefas.md` ausente ou ilegível: a change não desaparece; aparece com aviso de leitura.
- Nenhuma change aberta: hooks permanecem silenciosos e o gate `wk_skill_gate` continua funcionando.
- Dados de `provider` e `session_id` não serão usados para filtrar ou atribuir propriedade.

## Compatibilidade

- O formato de `CURRENT_CHANGE.md` não muda.
- Vaults existentes não exigem migração.
- Scripts que usam `status <slug>` e opções `--change` mantêm o comportamento.
- A saída humana de `change list` e de `status` sem slug será ampliada; não há contrato JSON atual a
  preservar.

## Testes de aceitação

1. Com A e B abertas e A no ponteiro, a projeção retorna A primeiro e todas as pendências de A e B.
2. Trocar o ponteiro para B altera a marca `current` e o hash, sem ocultar A.
3. Alterar uma tarefa de uma change não atual altera o hash do `change-context`.
4. `brain-inject` e `change-context` mostram todos os IDs pendentes, independentemente do provedor.
5. `change list` e `change status` sem slug listam todas as pendências; `status A` detalha apenas A.
6. `change-nag`, `verify` e `archive` consideram somente a change apontada quando não recebem slug.
7. Uma change sem `tarefas.md` aparece com aviso e não remove as demais da listagem.
8. Sem changes abertas, a ativação existente de `wk-workflow` continua inalterada.

## Fora de escopo

- Ponteiro por agente, sessão ou provedor.
- Locks, leases ou ownership exclusivo de changes.
- Execução simultânea de comandos mutáveis no mesmo arquivo `tarefas.md`.
- Bloqueio global causado por pendências de changes não selecionadas.
- Novo formato persistente ou migração de `CURRENT_CHANGE.md`.
