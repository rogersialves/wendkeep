# Observabilidade unificada de agentes, tokens e custos

## Objetivo

Substituir as seções concorrentes `## Uso de tokens e custos` e `## Subagents & Workflows` por uma única seção `## Agentes, tokens e custos`, atualizada durante a sessão e no encerramento sem perda de dados. A seção deve consolidar agente principal, subagents, workflows, custos, tokens, reasoning e nível de esforço por modelo.

## Problema confirmado

`updateSessionUsage()` escreve a telemetria do transcript principal. `upsertSubagentUsage()` escreve separadamente a telemetria dos subagents. O hook `SubagentStop` chama apenas o segundo writer, enquanto o primeiro normalmente roda no `Stop` principal. Durante uma sessão ativa, o bloco de subagents fica atualizado e o bloco principal permanece obsoleto.

Além da duplicação visual, dois renderizadores independentes mantêm totais, tabelas e anchors próprios. Fazer ambos escreverem livremente na mesma seção criaria risco de last-write-wins, perda de conteúdo e totais combinados inconsistentes.

## Decisão

Criar um compositor único e atômico de observabilidade. Os parsers atuais continuam responsáveis por extrair dados do transcript principal e dos subagents, mas não serão writers independentes da seção final.

Todos os pontos de entrada usarão a mesma operação:

```text
Stop principal ──────┐
SubagentStop ────────┤
Importação ──────────┼─> coletar snapshot completo
Cost rebuild ────────┘          │
                                v
                   renderizar e substituir atomicamente
                                │
                                v
                   ## Agentes, tokens e custos
```

## Componentes

### Coletores puros

- Coletor principal: transcript atual, histórico de reaberturas, prompts, ferramentas, chamadas, modelos, providers, effort e dimensões de tokens.
- Coletor de subagents: transcripts filhos, workflow, tipo, ferramentas, chamadas, modelos, providers, effort e dimensões de tokens.
- Os coletores não modificam Markdown.

### Snapshot unificado

O compositor produzirá um objeto versionado com:

- `main`: telemetria do agente principal;
- `subagents`: agentes e workflows detectados;
- `combined`: totais e ledger por modelo/origem;
- `history`: uso acumulado por transcript/reabertura;
- `generatedAt` e versão do schema.

Cada linha do ledger conterá, quando disponível:

- modelo e provider;
- origem `main` ou `subagent`;
- effort normalizado: `none`, `low`, `medium`, `high`, `xhigh` ou `unknown`;
- chamadas;
- input, cache write, cache read, output e reasoning tokens;
- total de tokens;
- custo API-equivalente.

Reasoning e effort são dimensões observacionais. Não adicionam uma tarifa separada nem serão somados duas vezes ao total cobrado pelo modelo.

### Writer atômico

Somente o compositor poderá escrever `## Agentes, tokens e custos`. Ele substituirá a seção inteira a partir de um snapshot completo, preservando as demais seções da nota.

Os writers públicos antigos serão convertidos em adapters compatíveis ou funções de coleta. Nenhum deles editará isoladamente uma parte livre da seção consolidada.

## Estrutura da seção

A seção consolidada terá:

1. aviso de estimativa API-equivalente;
2. resumo da sessão completa;
3. tabela por modelo e origem, incluindo reasoning/effort;
4. histórico por reabertura;
5. resumo de workflows;
6. tabela por subagent.

Sessões sem subagents exibirão normalmente o resumo principal, o ledger por modelo e o histórico; os blocos de workflows/subagents serão omitidos ou indicarão ausência sem impedir a criação da seção.

## Atualização durante o ciclo de vida

- `SubagentStop`: recompõe imediatamente o snapshot completo, incluindo o estado mais recente do transcript principal.
- `Stop`: usa a mesma operação antes da finalização.
- Importação: gera diretamente a estrutura consolidada.
- `cost rebuild`: migra sessões antigas e reconstrói a seção consolidada.

O compositor será idempotente: executar duas vezes sem mudança nas fontes produzirá o mesmo Markdown e frontmatter.

## Compatibilidade e migração

- Remover `## Uso de tokens e custos` e `## Subagents & Workflows` quando a seção consolidada for gravada.
- Preservar `usage_por_transcript` e o histórico de reaberturas.
- Manter os campos legados de custo/tokens usados por dashboards existentes.
- Acrescentar snapshot/ledger versionado com effort e reasoning por modelo.
- Atualizar `vault-health` e todos os anchors para reconhecer o novo heading.
- Aceitar temporariamente headings antigos em notas ainda não reconstruídas, evitando falsos negativos durante a migração.

## Consistência e falhas

- A renderização ocorre em memória e resulta em uma única gravação da nota.
- Falha ao ler subagents não apaga a telemetria principal.
- Falha ao ler o transcript principal não deve substituir um snapshot principal válido por zeros; o último valor persistido será preservado quando recuperável.
- Transcripts malformados serão ignorados individualmente e registrados em diagnóstico fail-open.
- Totais combinados serão derivados do ledger, nunca calculados independentemente em mais de um writer.

## Validação

Testes exigidos:

- `SubagentStop` atualiza simultaneamente main, subagents e total combinado;
- um writer não apaga dados produzidos pela outra fonte;
- reasoning e effort são preservados por modelo/origem;
- múltiplos modelos e efforts na mesma sessão;
- sessão sem subagents;
- histórico de reabertura preservado;
- migração remove ambos os headings antigos sem duplicar conteúdo;
- idempotência do compositor;
- importação e rebuild produzem o mesmo formato do fluxo ao vivo;
- `vault-health` aceita notas antigas durante a migração e exige o heading novo após reconstrução;
- campos legados continuam alimentando `wendkeep cost`, `stats` e dashboards.

Gates: `npm test`, `npm run check`, `git diff --check`, teste end-to-end em vault temporário e dry-run do rebuild na sessão usada como evidência.

## Fora de escopo

- Alterar o preço por nível de reasoning/effort.
- Inferir qualidade do modelo a partir do effort nesta versão.
- Criar vínculos heurísticos de subagents Codex sem metadado estável de parentesco.
