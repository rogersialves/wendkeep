# Evidências da falha de iteração

## Escopo

Esta nota resume uma sessão Codex de referência usando apenas rótulos sintéticos. As fontes
primárias — nota, registro causal, visão operacional e transcript — permanecem locais e não
foram copiadas para o repositório.

## Resultado principal

Há divergência entre o registro causal e a nota Markdown:

| Fonte | Estado observado | Referência sanitizada |
|---|---|---|
| Registro causal | último turno e último Stop na sequência 10 | snapshot local não versionado |
| Registro causal | mapa causal contínuo de turnos 1 a 10 | snapshot local não versionado |
| Nota Markdown | 8 marcadores `wk-turn` visíveis | snapshot local não versionado |
| Nota Markdown | `status: done`, mas observabilidade na sequência 7 | snapshot local não versionado |

Os marcadores presentes correspondem às sequências 1, 2, 3, 4, 5, 6, 8 e 10. Faltam os
turnos 7 e 9.

## Turno 7: interrupção confirmada

O transcript contém `turn_aborted` no turno 7, sem `task_complete` posterior. A fonte exata
permanece no snapshot local original.

Conclusão: a ausência do marcador pode ser consequência do ciclo de interrupção do host. O
comportamento, porém, não deixava um registro durável dizendo “turno interrompido e não
projetado”; o resultado era indistinguível de uma perda.

## Turno 9: perda de projeção não explicada

O turno 9 está presente no mapa causal e o registro informa que o último Stop foi o turno 10,
mas não há marcador `wk-turn` para o turno 9. Os artefatos originais não permitiam atribuir
uma causa única entre hook ausente, saída antecipada, lock ocupado ou corrida de escrita.

Conclusão: o turno 9 confirma a falha de projeção, mas a causa permanece não observável.

## Contaminação do conteúdo

O bloco gerado para o turno 8 usava uma notificação interna de subagente como título/pedido,
em vez do prompt humano. O título e o campo `Pedido` são derivados do último `userPrompt` que
o parser associa ao turno, por isso a falha afeta conteúdo e não apenas apresentação.

## Observabilidade atrasada

A nota continha os valores agregados `prompts: 9`, `tool_calls: 552`, `chamadas_llm: 920` e
`observability_turn_sequence: 7`. No registro causal, a observabilidade estava em uma
fronteira anterior e marcada como suja.

Conclusão: a sessão chegou ao turno 10, mas a projeção de observabilidade ficou atrás. Isso
faz a nota parecer incompleta mesmo quando o transcript existe.

## Estado ativo/done inconsistente

A nota estava finalizada no frontmatter, enquanto o registro mantinha a ativação como `active`
e a visão operacional listava mais de uma sessão ativa. Esse desacordo não prova a perda de um
turno, mas aumenta o risco de reabertura, roteamento ou leitura humana incorreta.

## Classificação

| Achado | Classificação |
|---|---|
| 10 turnos no registro e 8 marcadores na nota | Falha confirmada de projeção |
| Turno 7 sem marcador após `turn_aborted` | Resultado não distinguível de perda; exige política explícita |
| Turno 9 sem marcador apesar do ciclo normal | Falha confirmada; causa não observável |
| Notificação interna no pedido do turno 8 | Falha confirmada de parsing |
| Observabilidade suja e atrás do turno 10 | Falha confirmada de publicação/reconciliação |
| Lock ocupado como causa do turno 9 | Hipótese forte; ocorrência específica não comprovada |

## Novo achado — ação Git fora do escopo da sessão

### Fato observado

O registro causal identifica a conversa de referência como sessão Codex do projeto consumidor,
enquanto uma operação Git foi executada com `workdir` do repositório WendKeep. A autorização
registrada era contextual para uma change do WendKeep, mas o pedido posterior não repetiu o
par completo sessão → projeto → repositório → branch.

### O que este fato prova

- O registro do Vault continuou apontando para a nota original; não há evidência de que a sessão
  tenha sido roteada para a nota errada.
- A autorização estava contextualizada para a change do WendKeep; o achado não deve ser descrito
  como push sem autorização alguma.
- O defeito está na ausência de confirmação mecânica de escopo quando a conversa muda de projeto.
- A memória/contexto anterior amplificou a ambiguidade; não há evidência suficiente para
  classificá-la como corrupção do ledger de memória.

### Ausência de vínculo no WendKeep

O registro do WendKeep não possuía uma sessão correspondente à conversa de referência. Isso
indica que o comando Git atravessou o limite de projeto sem uma segunda barreira local para
confirmar o escopo.

### Classificação adicional

| Achado | Classificação |
|---|---|
| Sessão de um projeto consumidor executou Git no WendKeep | Falha confirmada de isolamento |
| Commit e push foram realizados no repositório errado | Efeito confirmado; não desfazer nesta análise |
| Confirmação genérica foi reutilizada após mudança de contexto | Falha confirmada de autorização contextual |
| Mais de uma sessão Codex ativa no ambiente | Fator de risco confirmado; causalidade direta não comprovada |
| Ledger de memória corrompido | Não comprovado; hipótese descartada por ora |
