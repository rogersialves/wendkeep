# Revisão da iteração de sessões Codex

Status: documentação investigativa. A investigação original foi somente leitura; a correção
do runtime foi implementada em changes próprias do WendKeep.

## Origem

- Sessão analisada: fixture de referência preservada no ambiente local.
- Fontes primárias: nota de sessão, registro causal, visão operacional e transcript locais,
  mantidos fora deste repositório.
- Esta documentação conserva fatos agregados e referências ao código, sem copiar payloads,
  paths locais, identificadores opacos ou dados do projeto consumidor.

## Documentos

1. [Evidências da sessão](./evidencias-sessao.md) — fatos confirmados, turnos ausentes,
   divergências de estado e classificação de confiança.
2. [Análise dos hooks](./analise-hooks.md) — fluxo de acionamento, parser, locks,
   publicação da observabilidade e pontos de perda.
3. [Plano de implementação](./plano-implementacao.md) — fases no WendKeep, testes de
   regressão, critérios de aceite e ordem recomendada.

## Atualização — escopo cruzado e sessões paralelas

A análise posterior identificou um segundo eixo de falha: uma sessão de um projeto consumidor
executou uma ação Git no repositório WendKeep porque a identidade da conversa não estava
vinculada de forma obrigatória ao projeto, `cwd`, remoto e branch. O fato foi autorizado no
contexto imediato de uma change do WendKeep, mas não houve confirmação mecânica de escopo
quando a conversa voltou a tratar do projeto consumidor.

- [Novo achado nas evidências](./evidencias-sessao.md#novo-achado--ação-git-fora-do-escopo-da-sessão).
- [Falha de isolamento na cadeia de hooks](./analise-hooks.md#falha-6--ação-git-sem-cerca-de-escopo).
- [Plano de cerca de projeto e autorização Git](./plano-implementacao.md#fase-p0-a--cerca-de-escopo-e-autorização-git).
- A autorização contextual, o commit e o push estão preservados apenas nos registros locais
  originais; nenhum transcript ou identificador foi copiado para este documento.

## Fontes de código referenciadas

- [Registro de hooks](../../packages/integrations/src/host-hooks.mjs#L8-L22).
- [Construção e inserção da iteração](../../hooks/session-stop.mjs#L314-L347) e
  [gravação do bloco](../../hooks/session-stop.mjs#L487-L503).
- [Lock e escrita atômica da nota](../../hooks/session-note-io.mjs#L120-L209).
- [Parser de transcript Codex](../../packages/integrations/src/transcripts.mjs#L23-L31) e
  [eventos reconhecidos](../../packages/integrations/src/transcripts.mjs#L217-L291).
- [Parser de uso e chamadas](../../hooks/token-usage.mjs#L319-L405).
- [Publicação da observabilidade](../../hooks/session-observability.mjs#L553-L675).
- [Resolução da identidade da sessão](../../packages/integrations/src/session-identity.mjs#L68-L170) e
  [binding do projeto ao Vault](../../packages/vault/src/project-vault.mjs#L198-L215).
- [Configuração Codex](../../.codex/hooks.json#L3-L83), [limitação do change-guard](../../hooks/change-guard.mjs#L114-L131)
  e [registro de `repoRoot` no Stop](../../hooks/session-stop.mjs#L108-L127).

## Ordem de leitura

`evidencias-sessao.md` → `analise-hooks.md` → `plano-implementacao.md`.

## Limites desta revisão

- Nenhum transcript foi reparado manualmente.
- Nenhum dado do Vault ou runtime de outro projeto foi copiado.
- O escopo investigativo não incluiu commit, push, PR, merge ou publicação.
- O plano serve como evidência de origem; a implementação e sua validação vivem nas changes
  e testes versionados do WendKeep.
