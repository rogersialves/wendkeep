# Memória compartilhada e curadoria

**PT-BR** · [English](../../en/commands/memory.md)

## Objetivo

Inspecionar e curar CORE, SHARED, ledger, outbox, attempts e candidates sem confundir autoria
canônica com estado operacional gerado.

`CORE.md` é a única camada manual e canônica: aceita até 40 linhas, alerta a partir de 35,
mantém o teto de 4 KiB e limita cada linha a 320 caracteres. `SHARED_MEMORY.md` é uma projeção
gerada pelo ledger e não deve ser editado à mão.

## Quando usar

Use no CI, antes de verify/archive, diante de avisos do doctor ou para decidir candidates.

## Quando não usar

Não edite `SHARED_MEMORY.md` ou `MEMORY_EVENTS.jsonl` à mão. Não use repair em vault legado que
apenas aguarda migração.

## Pré-requisitos

Informe o vault explicitamente em automações. Preserve backups e evidências antes de reparar.

## Sintaxe

```bash
npx wendkeep memory status [--gate] --vault <cofre>
npx wendkeep memory curate [--all] --vault <cofre>
npx wendkeep memory candidates [--active] --vault <cofre>
npx wendkeep memory rescope [--apply] --vault <cofre>
npx wendkeep memory repair --vault <cofre>
npx wendkeep memory recover-attempt <sessão> [--apply] --vault <cofre>
npx wendkeep memory reconcile <sessão-ambígua> --by-session <sessão-sucessora> --reason <motivo> [--apply] --vault <cofre>
npx wendkeep memory promote <candidate-id> [--event <event-id>] --vault <cofre>
npx wendkeep memory reject <candidate-id> --vault <cofre>
npx wendkeep validate-memory [caminho-do-CORE]
npx wendkeep validate-memory --vault <cofre-v2>
```

## Opções e códigos de saída

- `memory status` é read-only; `--gate` retorna exit `1` apenas para estado bloqueante.
- `memory curate` é o caminho recomendado para pessoas: por padrão mostra somente conflitos
  acionáveis. Em um terminal interativo, agrupa por nome amigável, mostra previews e contexto
  sanitizados e oferece escolhas numeradas, `P` para pular, `R` para rejeitar, `D` para detalhes
  técnicos e `Q` para sair. `--all` inclui handoffs de sessões comprovadamente encerradas; nesses
  casos, `H` encerra em lote somente as recomendações seguras, relendo a autoridade entre cada
  decisão. Toda escrita pede confirmação com padrão negativo: Enter ou `N` não grava. Pular ou
  sair preserva o restante para retomar em outra execução.
- O assistente aceita `--vault` e `--all`: não há `--yes` nem `--apply`. Em ambiente
  não-TTY/terminal não interativo, ele retorna exit `2` sem alterar bytes e orienta usar o fallback
  avançado `memory candidates --active`.
- `memory candidates` é read-only e imprime JSON determinístico com somente `candidate_id`,
  `reason`, `status`, `memory_key`, escopo quando presente e `event_ids`; não expõe valores nem conteúdo da memória e não
  cria lock nem altera o bundle. `--active` omite candidates terminais (`resolved`, `rejected` e
  `superseded`). Status ausente é normalizado para `active`.
- Em `memory candidates`, exit `0` indica inventário válido (inclusive vazio ou com conflitos),
  exit `1` indica sidecar inválido/topologia insegura e exit `2` indica `--vault` ausente, opção
  desconhecida/duplicada, argumento extra ou valor indevido em `--active`.
- O `Stop` grava os eventos na outbox antes de reconhecer `last_memory_attempt: enqueued`; depois o
  projector roda fora do lock do registry. Retry do mesmo attempt reutiliza os event IDs congelados
  e pode projetá-los no máximo uma vez.
- Projector busy/falho persiste `degraded`, preserva a outbox e avisa que há replay. Um Stop/retry
  seguinte reaproveita essa tentativa; não reconstrói o handoff com dados transitórios novos.
- O outcome só atualiza `memory_status`/checkpoint se activation, epoch, turno e attempt ainda forem
  exatamente os mesmos. Resultado stale/superseded não apaga nem sobrescreve checkpoint mais novo.
- Vault legado válido gera warning e exit `0`. Em v2, o status correlaciona
  `last_memory_attempt`, disposition, outbox, ledger, SHARED e checkpoint: attempt ambíguo,
  publicação perdida ou checkpoint divergente bloqueiam; `degraded` com outbox íntegra é warning.
- `memory repair` é exclusivamente estrutural: trabalha sob locks com owner PID/token, salva
  `.bak`, retém eventos válidos e reprojeta. Quando reconhece um checkpoint pré-0.59 válido com
  cursor causal, migra-o por CAS para a fronteira física. Também reconhece um prefixo histórico
  assert-only somente quando revision, cursor, hash, identidade, turns e o espelho
  `memory_checkpoint` reproduzem exatamente a semântica antiga; o alvo é o replay atual daquele
  prefixo, sem absorver eventos posteriores. Ambos os casos fazem CAS do attempt e do espelho e
  registram backup/auditoria. A única exceção estreita de acknowledgement cobre attempts
  `enqueued`/`degraded` cuja outbox foi congelada e cujos event IDs a mesma execução do repair
  consumiu integralmente; cobertura parcial não altera o attempt. O repair não varre nem
  reclassifica attempts históricos e não aceita tuple, operação ou espelho que não seja
  rederivado integralmente.
- Desde a 0.66.4, `memory recover-attempt` é dirigido a uma única sessão e faz dry-run por padrão.
  A sessão deve existir no registry e possuir o último attempt `v2`, `applied`, em `enqueued` ou
  `degraded`, com `event_ids` não vazios e únicos. Todos os eventos devem estar integralmente no
  ledger, pertencer ao mesmo projeto/sessão/activation/epoch/turn do attempt, não pode haver evento
  posterior da mesma sessão nem evento alvo restante na outbox, e SHARED/candidates devem
  reproduzir byte a byte a projeção integral do ledger. Um attempt já `projected` só é aceito com
  checkpoint válido e retorna `unchanged`.
- Com `--apply`, `memory recover-attempt` altera somente `SESSION_REGISTRY`: marca
  `last_memory_attempt`/`memory_status` como `projected` e grava o checkpoint idêntico no attempt e
  em `memory_checkpoint`. Ledger, CORE, SHARED, candidates, outbox e notas permanecem byte-intactos.
  O comando valida novamente toda a autoridade sob `MEMORY.lock`, faz CAS do attempt, activation,
  epoch, turno e checkpoint e falha fechado se qualquer byte/contexto mudar. Lock ocupado não é
  colhido; retry após aplicação retorna `unchanged` sem escrita.
- `memory reconcile` é dry-run por padrão. `--apply` exige duas sessões nomeadas e motivo, faz CAS
  do attempt exato, salva backup do registry e limita a mutação ao attempt ambíguo e à sucessora.
  O replay é CORE-aware, usa cursor físico do ledger no checkpoint e não reescreve ledger, CORE ou
  notas, nem consome a outbox. Repetir a mesma decisão aplicada é idempotente.
- O projector admite eventos completos de forma determinística e prioriza estado operacional
  crítico até o limite de 48 linhas/6144 bytes. `projection_mode`, `projected_events` e
  `omitted_events` tornam o recorte verificável; revision, cursor e `state_hash` continuam cobrindo
  o ledger integral. O gate aceita somente a omissão que rederiva exatamente da mesma política.
- `memory rescope` é dry-run por padrão e lista somente IDs, chaves e escopos planejados. Com
  `--apply`, anexa eventos explícitos de projeto, work session, change, branch ou worktree e mantém
  os bytes históricos como prefixo do ledger. Eventos legados de `handoff.latest` que participam
  de candidates também são reescopados individualmente quando possuem identidade de sessão
  comprovável: isso separa workflows independentes sem selecionar vencedor. Ambiguidades que
  permanecem no mesmo escopo continuam sob curadoria; uma repetição retorna `unchanged`.
  Se o doctor indicar memória estruturalmente bloqueada, execute primeiro `memory repair`, confirme
  `memory status --gate` verde e só então volte ao dry-run; não aplique rescope sobre uma projeção
  inválida.
- Registradores como `git.local-head`, `handoff.latest`, `quality.latest-*` e
  `change.<slug>.status` só competem dentro do mesmo escopo. Resolução automática ainda exige o
  mesmo projeto e linhagem causal; decisões, constraints e blockers incompatíveis permanecem sob
  curadoria. Uma chave ambígua é omitida de SHARED sem remover CORE ou chaves independentes. Com
  `active_contexts` inicializado, o `Stop` deriva `work_session_id`, `repository_id`, `worktree_id`,
  branch e `change_slug` do active context causal. Identidade divergente no handoff falha antes de
  CAS, nota, outbox ou ledger; o fallback legado só existe sem o store contextual.
- `.brain/EVIDENCE_INDEX.jsonl` divide documentos por headings e blocos e registra arquivo,
  heading, tipo, change, sessão, work session, autoridade, data, validade e hash. `/brain-recall`
  e o hook `UserPromptSubmit` usam BM25, frase exata, pesos por campo, autoridade, validade,
  recência limitada e diversidade para retornar o trecho do match com proveniência. No recall
  automático, o hook é somente leitura: não migra `CURRENT_CHANGE.md` nem altera o registry;
  exclui linhas pertencentes a sessão ou change irmã ativa e preserva linhas globais ou históricas
  sem owner ativo. `/brain-recall` explícito permanece global.
- Toda rota de memória valida a topologia física de `.brain`, ledger, outbox, CORE, SHARED,
  candidates, registry, notas, backups, temporários e sidecars antes de ler ou escrever. Junction,
  symlink, reparse point ou hardlink falham fechados sem tocar bytes externos. Locks publicam owner
  e lease atomicamente, não colhem PID vivo apenas por idade e só liberam a lease adquirida.
- `promote`/`reject` acrescentam uma decisão auditável e idempotente ao ledger. Replay e repair
  preservam a decisão e não recriam o candidate resolvido. Para candidate `conflict`, use
  `memory promote <candidate-id> --event <event-id>` com um evento pertencente ao candidate; não há
  vencedor implícito por data ou ID.
  `reject` preserva o valor operacional atual. Candidate `blocked_by_core` só pode ser rejeitado:
  promover exige antes alterar CORE pela curadoria canônica. Se o evento escolhido ainda pertence
  ao último attempt `projected` correspondente, a promoção também atualiza causalmente checkpoint
  e espelho; o JSON retorna `checkpointRefreshed`, e um attempt concorrente mais novo não é tocado.
  A decisão conserva, sem coerção para string, o valor JSON já validado e copia do evento escolhido
  `canonical_session_id`, activation/epoch, `source_turn_id` e `turn_sequence`. Por isso, um Stop
  posterior da mesma sessão/activation avança o valor em vez de abrir outro candidate. Durante o
  replay, um candidate transitório é reavaliado e, quando a supersession causal é provada,
  reancorado contra a fonte moderna final; a promoção explícita usa essa nova âncora e inclui
  somente os predecessores físicos necessários. Mesma
  sessão/activation/epoch e turno maior aplica o Stop; turno menor fica superseded. Identidade
  divergente, incompleta ou ambígua mantém o candidate para curadoria. `memory repair` compara o
  replay anterior e o atual e só migra checkpoint+espelho com identidade exata, backup, audit e
  CAS; ele não reordena, reescreve nem acrescenta evento ao ledger.
- `validate-memory <CORE.md>` valida cap rígido de 40 linhas, alerta em 35, 4 KiB, 320 caracteres
  por linha, seções e segredos/PII.
- `validate-memory --vault` também compara a cobertura semântica do ledger com SHARED e imprime
  código, contagens e chaves ativas/projetadas/ausentes. Bundle v2 vazio é neutro; evento
  projetável ausente, placeholders exclusivos ou link de decisão morto geram diagnóstico
  degradado/bloqueante sem expor valores.
- `validate-memory --vault` exige bundle v2 completo; não é o gate correto para vault legado.
- Para `recover-attempt`, exit `0` indica dry-run/apply válido, inclusive `unchanged`; exit `1`
  indica falha de pré-condição, autoridade, CAS, topologia ou lock; exit `2` indica
  sessão/`--vault` ausente, opção desconhecida/duplicada, argumento extra ou valor inválido.

## Exemplos

```bash
npx wendkeep memory status --gate --vault .MeuApp-vault
npx wendkeep memory curate --vault .MeuApp-vault
npx wendkeep memory candidates --active --vault .MeuApp-vault
npx wendkeep memory rescope --vault .MeuApp-vault
npx wendkeep memory rescope --apply --vault .MeuApp-vault
npx wendkeep memory recover-attempt sessao-123 --vault .MeuApp-vault
npx wendkeep memory recover-attempt sessao-123 --apply --vault .MeuApp-vault
npx wendkeep memory reconcile antiga --by-session atual --reason "entrega continuada" --vault .MeuApp-vault
npx wendkeep memory reconcile antiga --by-session atual --reason "entrega continuada" --apply --vault .MeuApp-vault
npx wendkeep validate-memory .MeuApp-vault/.brain/CORE.md
npx wendkeep memory promote candidate-123 --event mem-escolhido --vault .MeuApp-vault
npx wendkeep memory reject candidate-456 --vault .MeuApp-vault
```

## Resultado esperado

O status imprime schema, revision, cursor, hash, eventos, outbox, candidates, conflitos e o estado
causal do último attempt. CORE permanece canônico e curado à mão; SHARED permanece projeção
operacional verificável. Depois de uma projeção bem-sucedida, o checkpoint do attempt pode ser um
prefixo válido de uma projeção global que já avançou com eventos concorrentes.

`memory candidates` retorna `status: "ok"` e a lista sanitizada de candidates em ordem estável;
com `--active`, a lista contém somente decisões ainda abertas para curadoria humana.

## Erros comuns e diagnóstico

- `legacy`: siga o guia de migração; não é corrupção.
- `revision: 0` logo após migração válida, sem attempt v2, é saudável; não rode repair só para
  fabricar o primeiro evento.
- `degraded` com todos os event IDs presentes no ledger ou na outbox íntegra é recuperável; deixe o
  replay idempotente concluir. Event ID ausente nos dois lugares indica publicação perdida.
- Status/doctor informa `acknowledgement projetado pendente` e sugere
  `memory recover-attempt <sessão>`: preserve os artefatos, revise primeiro o JSON do dry-run e só
  use `--apply` se `eligible: true`. `dry-run` confirma elegibilidade; `applied` atualiza
  registry/checkpoint; `unchanged` indica que a recuperação já foi aplicada de forma idempotente.
- `recover-attempt` recusa evento ausente/divergente, outbox alvo ainda presente, SHARED/candidates
  stale, attempt histórico, sessão/contexto causal divergente, checkpoint inválido ou lock ocupado.
  Não tente contornar o gate com edição manual: rode novamente `memory status --gate`, preserve a
  evidência e resolva a autoridade divergente.
- Attempt `ambiguous`, attempt `applied` sem event IDs, evento `projected` apenas na outbox ou
  checkpoint divergente são bloqueantes: preserve os artefatos e investigue antes de repair. Se a
  ambiguidade for comprovadamente substituída por uma sessão sucessora, revise o dry-run de
  `memory reconcile` antes de autorizar `--apply`; o comando falha se o attempt ambíguo tiver IDs.
- Candidate pendente comum: warning recuperável, exige decisão humana quando apropriado.
- `promote` informa que `--event` é obrigatório: leia os `event_ids` do candidate, compare a
  proveniência/valor e indique explicitamente o vencedor. ID que não pertence ao candidate falha
  sem mutar ledger ou projeções.
- Promoção feita pela 0.66.1 seguida de candidate transitório: atualize para a 0.66.3, preserve um
  backup e rode `memory repair`. Não publique nem instale a 0.66.2. O repair só migra o checkpoint
  quando o replay anterior, a identidade do attempt e o evento novo coincidem exatamente; conflito
  real continua bloqueado para escolha humana com `promote`/`reject`.
- `promote` informa que o candidate não corresponde mais à projeção causal: nenhum evento foi
  anexado. Rode `memory status`, releia o candidate atual e não force uma linhagem diferente.
- `event_cursor` ausente ou hash divergente em v2: preserve o bundle e avalie `memory repair`.
- `validate-memory --vault` falha no legado: valide apenas CORE ou migre primeiro.

## Próximos passos

Leia [migração de memória](memory-migration.md), [manutenção](maintenance-and-diagnostics.md) e
[verify](verify.md).
