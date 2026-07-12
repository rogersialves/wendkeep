# Incidente: resume Codex cria sessão órfã e recebe observabilidade Claude

Data: 2026-07-11  
Versão reproduzida: `wendkeep@0.37.0`  
Projeto consumidor: `C:\GitHub\NutriGym-Vision`  
Severidade proposta: alta — corrupção silenciosa da trilha de auditoria e dos custos

## Resumo

Ao retomar uma conversa existente do Codex, o WendKeep criou uma nova nota de sessão em vez de reabrir a nota canônica da conversa. Em seguida, a nota órfã, identificada como `provider: codex`, recebeu métricas, subagents e workflows de um transcript do Claude Code.

O comando `wendkeep cost rebuild` não causou a contaminação, mas também não a detectou: a entrada órfã tinha `transcript_path` vazio e foi removida silenciosamente do universo analisado.

## Identidades envolvidas

### Sessão canônica da conversa Codex

- ID: `019f4b83-277c-7001-a729-e5bf6e653331`
- Nota: `.NutriGymBrain/02-Sessões/2026/07-JUL/DIA 10/07-12-session.md`
- Início: `2026-07-10T07:12:55`
- Provider: `codex`
- Transcript correto: `.codex/sessions/2026/07/10/rollout-2026-07-10T07-11-59-019f4b83-277c-7001-a729-e5bf6e653331.jsonl`
- Estado atual: o `CURRENT_SESSION.md` voltou a apontar corretamente para esta sessão.

### Sessão órfã criada no resume

- ID: `019f5389-aa97-7fe0-8a9f-174eef7062ed`
- Nota: `.NutriGymBrain/02-Sessões/2026/07-JUL/DIA 11/20-36-session.md`
- Início: `2026-07-11T20:36:28`
- Provider no frontmatter: `codex`
- `transcript_path` no `SESSION_REGISTRY.json`: vazio
- Não existe rollout Codex local cujo nome contenha esse ID.

### Transcript indevidamente agregado

- ID: `22e840e9-4867-413f-8362-538fa57c40bd`
- Provider real: `anthropic`
- Transcript: `.claude/projects/.../22e840e9-4867-413f-8362-538fa57c40bd.jsonl`
- Nota Claude correta: `.NutriGymBrain/02-Sessões/2026/07-JUL/DIA 11/19-15-fizamos-algumas-alteracoes-no-designer-das-telas-do-ngv-pro.md`
- Dados inseridos indevidamente na nota Codex órfã: modelos `claude-fable-5` e `claude-opus-4.8`, 35 subagents e workflows `onda0-higiene-tema-pro` e `audit-pro-cockpit-redesign`.

## Linha do tempo comprovada

1. `2026-07-10 07:12:55`: criada a sessão Codex canônica `019f4b83...`.
2. `2026-07-11 20:36:28`: criada a nota órfã `20-36-session.md` com o novo ID `019f5389...`.
3. `2026-07-11 20:36:33`: o registry mantém a nova entrada ativa, mas com `transcript_path: ""`.
4. `2026-07-11 20:36:57`: a nota órfã é modificada e passa a conter o ledger Anthropic, 35 subagents e dois workflows Claude.
5. Depois disso, `wendkeep cost rebuild --apply` é executado. O relatório não contém `019f5389...`, pois a entrada sem transcript é filtrada antes da contagem.
6. A sessão canônica `019f4b83...` é posteriormente reaberta e volta a ser o ponteiro atual.

O `LastWriteTime` de `20-36-session.md` prova que a contaminação ocorreu antes do rebuild manual.

## Defeitos confirmados

### 1. Split de sessão quando a identidade muda e não há transcript

Em `hooks/session-start.mjs`, a reabertura depende de uma destas identidades:

- `CURRENT_SESSION.session_id === input.session_id`;
- entrada direta no registry para `input.session_id`;
- match por `transcript_path`.

Quando o cliente apresenta um ID novo no resume e omite `transcript_path`, nenhum caminho consegue reencontrar a conversa original. O código cai em `allocateSessionPath()` e cria uma nova nota.

Além disso, o caminho de criação em `session-start.mjs` não grava `transcript_path` no registry. A sessão resultante fica órfã desde o primeiro evento.

### 2. Caminhos de upsert podem apagar uma associação válida

Em `hooks/session-ensure.mjs`, os upserts usam:

```js
transcript_path: input.transcript_path || input.transcriptPath || ''
```

Se um evento posterior vier sem transcript, o valor vazio pode substituir uma associação anteriormente válida. A regra deve preservar o valor já registrado quando o evento não fornecer uma identidade nova.

### 3. Falta de barreira cross-provider na observabilidade

Uma nota com `provider: codex` recebeu um transcript `anthropic`. A escrita deveria ser rejeitada antes de alterar frontmatter ou o grupo `## Agentes, tokens e custos`.

O artefato prova a contaminação, embora o evento/caller exato que escreveu a seção ainda precise de instrumentação. Registrar no ledger apenas o ID do transcript não é suficiente para auditar qual hook iniciou a mutação.

### 4. `cost rebuild` omite sessões quebradas e reporta sucesso

Em `src/rebuild-costs.mjs`, as entradas são filtradas assim:

```js
.filter((e) => e.session_file && e.transcript_path)
```

Consequências:

- sessões com nota, mas sem transcript, não entram em `scanned`;
- não entram em `missing`;
- não entram em `errors`;
- o comando pode informar `0 sem fonte · 0 erros` mesmo com sessões órfãs no registry.

No incidente, o dry-run informou `172 lidas · 170 alteradas · 2 iguais · 0 sem fonte · 0 erros`, ocultando `019f5389...`.

## Reprodução mínima sugerida

### Caso A — resume sem identidade suficiente

1. Registrar sessão ativa `A`, nota `N` e transcript Codex `T`.
2. Executar `session-start` como resume da mesma conversa, mas com `session_id = B` e sem `transcript_path`.
3. Resultado atual: cria nova nota `N2` e registry `B` sem transcript.
4. Resultado esperado: não criar nota definitiva enquanto a identidade for ambígua; reabrir `N` somente com uma chave estável comprovada.

### Caso B — transcript de provider incompatível

1. Criar nota com `provider: codex`.
2. Tentar `updateSessionObservability()` com transcript Anthropic.
3. Resultado observado no incidente: ledger Claude foi persistido na nota Codex.
4. Resultado esperado: abortar a mutação, manter o arquivo byte a byte e registrar erro estruturado de incompatibilidade.

### Caso C — rebuild com registry órfão

1. Criar entrada com `session_file` válido e `transcript_path: ""`.
2. Executar `wendkeep cost rebuild`.
3. Resultado atual: entrada invisível e relatório verde.
4. Resultado esperado: entrada em `missing` ou `invalid`, com motivo `empty_transcript_path`; modo `--apply` não deve alterar a nota.

## Correção proposta

1. Definir uma identidade canônica de conversa separada de `turn_id` e de IDs efêmeros de resume.
2. No Codex, priorizar o ID estável do thread/rollout. Se ele não estiver disponível, adiar a criação da nota em vez de fabricar uma segunda sessão ativa.
3. Preservar `registry.transcript_path` quando hooks posteriores não fornecerem transcript.
4. Antes de atualizar observabilidade, validar:
   - registry `session_file <-> transcript_path`;
   - provider do transcript contra provider da nota;
   - ID do transcript contra `usage_por_transcript` existente.
5. Incluir em cada atualização de observabilidade metadados de auditoria: hook/caller, timestamp, session ID e transcript ID.
6. Fazer `cost rebuild` enumerar todas as entradas com `session_file`, classificando transcript vazio, inexistente ou incompatível como problema explícito.
7. Adicionar opção direcionada e segura: `cost rebuild --session <session-id>` deve falhar de forma visível quando a sessão existe mas não tem fonte.

## Testes de regressão obrigatórios

- `session-start` não cria nota duplicada quando o cliente rotaciona ID durante resume.
- `session-start`/`session-ensure` nunca substituem transcript válido por string vazia.
- duas sessões concorrentes, Codex e Claude, nunca compartilham nota nem ledger.
- `updateSessionObservability` rejeita provider incompatível sem modificar o arquivo.
- `cost rebuild` reporta registry órfão em vez de filtrá-lo silenciosamente.
- `cost rebuild --apply` é idempotente e não altera nota sem vínculo registry válido.
- o `CURRENT_SESSION.md` pode ser sobrescrito por outra conversa sem alterar o roteamento por identidade da sessão atual.

## Critérios de aceite para publicação NPM

- Retomar a conversa `019f4b83...` sempre reabre `07-12-session.md`.
- Nenhuma nota adicional é criada quando a identidade do resume é insuficiente; o hook emite diagnóstico acionável.
- Métricas Anthropic jamais são persistidas em nota `provider: codex`, e vice-versa.
- O rebuild lista entradas órfãs e retorna estado não verde quando executado de forma direcionada nelas.
- Todos os testes concorrentes e de reabertura passam em Windows com caminhos Codex e Claude reais/normalizados.

## Estado dos dados afetados

Este relatório não corrige nem remove automaticamente:

- `20-36-session.md`;
- a entrada `019f5389...` no registry;
- o ledger Claude indevidamente anexado.

A preservação é intencional até existir uma rotina de reparo auditável. Apagar manualmente agora destruiria evidência do incidente.
