---
title: Reforço da captura de planos, mudanças e specs
date: 2026-07-09
status: aguardando-revisao
scope: WendKeep e integração local NutriGym Vision
---

# Reforço da captura de planos, mudanças e specs

## Contexto

O fluxo esperado é:

```text
sessão/transcript
  -> plano aprovado
  -> 08-Mudanças/<slug>/
  -> delta de requisitos verificado
  -> archive
  -> 07-Specs/<capability>.md
```

Na sessão Claude Code `47e1748f-c769-4dab-abba-365faa5e440e`, esse fluxo se rompeu em três pontos:

1. `plan-capture` recebeu o payload estruturado atual de `ExitPlanMode`, mas exigiu uma frase textual legada e devolveu `{}`.
2. Hooks de alta frequência usaram `node node_modules/wendkeep/...`, relativo ao `cwd`; ao trabalhar em `mobile-app` ou `backend-core`, ocorreram 52 falhas `MODULE_NOT_FOUND`.
3. As mudanças ficaram com `specs: []` e apenas o placeholder `specs/exemplo/spec.md`. O archive aceitou esse estado e promoveu zero contratos para `07-Specs`.

`07-Specs` continuará sendo o contrato vivo do produto. Planos brutos e deltas em elaboração pertencem a `08-Mudanças`; somente requisitos verificados serão promovidos no archive.

## Abordagens consideradas

### 1. Reforço em camadas — recomendada

Corrige o payload e o caminho dos hooks, introduz uma classificação explícita de impacto em specs, endurece verify/archive, atualiza as skills e repara os artefatos atuais.

Vantagens: corrige a causa raiz, impede recorrência silenciosa e preserva a arquitetura atual. Desvantagem: altera o contrato do scaffold e exige migração compatível para mudanças antigas.

### 2. Hotfix mínimo

Corrige apenas `extractPlan()` e troca os comandos relativos por comandos ancorados na raiz.

Vantagens: patch pequeno e baixo risco imediato. Desvantagem: mudanças grandes continuariam podendo ser arquivadas com `specs: []`; `07-Specs` permaneceria dependente da memória do agente.

### 3. Reescrita orientada a eventos

Substitui hooks e arquivos intermediários por um log único de eventos, do qual sessões, mudanças e specs seriam projeções reconstruíveis.

Vantagens: rastreabilidade máxima. Desvantagem: escopo e risco desproporcionais para a falha observada, com migração ampla do vault.

## Decisão

Adotar a abordagem 1, mantendo o desenho atual do WendKeep e acrescentando invariantes explícitas nos pontos de entrada e fechamento.

## Desenho técnico

### 1. Resolução estável dos hooks

- Os hooks Claude de alta frequência usarão a forma exec (`command: node`, `args: ["${CLAUDE_PROJECT_DIR}/node_modules/wendkeep/hooks/<nome>.mjs"]`); nenhum comando dependerá do `cwd` da ferramenta.
- O `init --force` reconhecerá e migrará tanto o comando relativo legado quanto o novo comando ancorado, sem duplicar grupos.
- Os hooks portáteis continuarão disponíveis por `wendkeep hook <nome>`.
- A suíte executará comandos de hook simulando a raiz, `mobile-app` e `backend-core`.

### 2. Captura compatível e observável de planos

`extractPlan(input)` seguirá esta ordem:

1. aceitar `tool_response.plan` quando `tool_response` for o objeto estruturado de um `PostToolUse:ExitPlanMode` bem-sucedido;
2. aceitar `tool_input.plan`/`toolInput.plan` para versões compatíveis;
3. manter os formatos textuais legados (`Approved Plan` e `saved to:`);
4. preservar rejeições explícitas como no-op.

Uma aprovação com plano presente que não puder ser persistida deixará de falhar silenciosamente: o hook escreverá erro diagnóstico em `stderr` e retornará contexto acionável, sem derrubar o Claude Code.

Ao criar uma mudança automaticamente, o hook resolverá a sessão pelo `transcript_path`/registry e preencherá `source` com o backlink correto.

O plano será preservado em `planos/<sha256-12>.md`. Capturas repetidas serão deduplicadas pelo hash; `plano-aprovado.md` funcionará como índice dos snapshots, de modo que planos distintos nunca sobrescrevam silenciosamente uma versão anterior.

### 3. Estado explícito de impacto em specs

Mudanças não simples terão no frontmatter:

```yaml
spec_impact: pending | required | none
spec_impact_reason: "..."
specs: []
```

- `pending`: scaffold ainda não classificado; não pode ser arquivado.
- `required`: exige pelo menos um delta real em `specs/<capability>/spec.md` e a capability em `specs:`.
- `none`: exige justificativa não vazia; serve para refactors, manutenção ou mudanças sem comportamento observável.

Mudanças `--simple` poderão nascer como `none`, com justificativa gerada pelo modo simples. Mudanças legadas sem `spec_impact` serão diagnosticadas como legado; não serão reinterpretadas silenciosamente como `none`.

O placeholder `specs/exemplo/spec.md` nunca contará como delta real.

### 4. Skills e arquivos de programação

`wk-workflow`, `wk-brainstorming` e `wk-planning` serão atualizadas para exigir, antes da implementação:

1. classificar o impacto em specs;
2. nomear a capability afetada;
3. escrever os blocos `ADDED`, `MODIFIED` e/ou `REMOVED` quando o impacto for `required`;
4. ligar tarefas aos requisitos com `[req:ID]`;
5. registrar uma justificativa quando o impacto for `none`.

O roteador injetado no `SessionStart` citará também `spec_impact` e o delta, não apenas proposta/design/tarefas.

### 5. Verify e archive

O gate de fechamento aplicará as seguintes invariantes:

- `pending` bloqueia;
- `required` sem delta real bloqueia;
- `required` com capability declarada sem arquivo correspondente bloqueia;
- `none` sem justificativa bloqueia;
- falha de parse ou promoção de qualquer delta bloqueia o archive;
- nenhuma exceção de promoção será engolida;
- a mudança só será movida e o ADR só será criado depois que a promoção estiver validada.

O `harness doctor` reportará impacto pendente, placeholders e divergências entre `specs:` e os deltas em disco.

### 6. Integridade de sessão e backlinks

- O archive substituirá, na sessão de origem, o link da mudança ativa pelo caminho arquivado.
- A captura de decisão atualizará o backlink da sessão no mesmo ciclo, sem depender apenas do Stop final.
- O health check distinguirá sessão ativa de sessão finalizada para evitar falso erro de posição do `Encerramento`.
- Sentinelas `.brain/.change-*` serão documentadas/adicionadas ao ignore recomendado, evitando sujeira no Git do consumidor.

### 7. Recuperação do NutriGym Vision

Depois da correção no WendKeep:

- reinstalar localmente a versão corrigida no NutriGym Vision sem publicar externamente;
- executar `init --force` para migrar os comandos de hooks sem duplicá-los;
- sincronizar as skills geradas;
- recuperar os planos aprovados disponíveis no transcript informado;
- classificar e preencher os deltas reais das mudanças originadas nessa sessão;
- promover/backfill das specs já implementadas com backlink para as mudanças arquivadas;
- preservar a mudança ativa e todos os arquivos de código locais do usuário;
- executar o backfill da iteração ausente detectada em modo idempotente.

## Tratamento de erros

- Hooks continuam fail-open para não derrubar a sessão do agente, mas toda perda de persistência terá `stderr` identificável.
- Gates de integridade são fail-closed: inconsistência de spec impede archive.
- Operações de recuperação serão idempotentes e deduplicadas por hash/ID.
- Nenhum arquivo existente do vault será sobrescrito sem comparação de conteúdo e proveniência.

## Testes e validação

### Testes automatizados mínimos

1. Payload estruturado real de `ExitPlanMode` é capturado.
2. Payload legado continua funcionando; rejeição continua no-op.
3. E2E via stdin cria/anexa mudança, persiste plano e emite `additionalContext`.
4. Sessão de origem é preenchida na criação automática.
5. Comandos de hooks funcionam a partir da raiz e de diretórios aninhados.
6. `pending`, `required` sem delta e `none` sem justificativa bloqueiam archive.
7. Delta real promove para `07-Specs`; placeholder não promove.
8. Erro de parse/promoção não cria ADR nem move a mudança.
9. Archive reescreve backlink da sessão para `_arquivo`.
10. Backfill é idempotente e reconhece `wk-turn` e marcador legado.

### Gates

- `npm test` no WendKeep;
- `npm run check`;
- smoke do tarball empacotado e instalado localmente;
- validação do JSON das configurações Claude/Codex;
- `wendkeep doctor` no NutriGym Vision;
- reprodução controlada de `ExitPlanMode` com fixture do transcript real;
- verificação final de `07-Specs`, `08-Mudanças` e da sessão informada.

## Compatibilidade e rollout

- A mudança de gate será tratada como evolução de contrato do WendKeep, com changelog explícito.
- Mudanças antigas sem `spec_impact` receberão diagnóstico e caminho de migração; não serão modificadas em massa sem necessidade.
- Não haverá publicação no npm nem push remoto sem autorização separada.
- A ativação local no NutriGym Vision será validada antes de qualquer recomendação de release.

## Fora de escopo

| Item | Motivo |
| --- | --- |
| Reescrever o vault como event store | Escopo desproporcional à falha atual |
| Alterar o significado de `07-Specs` para armazenar planos | Contraria o contrato vivo aprovado |
| Refatorar código de produto mobile/backend | Alterações do usuário serão preservadas |
| Publicar pacote ou fazer push remoto | Exige autorização específica |
| Gerar requisitos por heurística a partir de qualquer prosa | Pode criar contratos falsos; o delta deve ser explícito |

## Critérios de aceite

- Um plano aprovado no payload atual do Claude Code cria ou atualiza deterministicamente a mudança correta.
- Nenhum hook do WendKeep falha quando o `cwd` está em um subprojeto.
- Uma mudança material não pode ser arquivada sem delta real ou exceção explícita justificada.
- Falhas de promoção são visíveis e bloqueiam o archive.
- O fluxo da sessão informada resulta em backlinks válidos e specs vivas para os comportamentos já implementados.
- A suíte do WendKeep permanece verde e o checkout de produto do NutriGym Vision mantém intactas as alterações locais do usuário.
