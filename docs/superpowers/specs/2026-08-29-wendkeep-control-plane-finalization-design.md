# Design — finalização incremental do WendKeep Control Plane

- **Status:** aprovado em conversa em 2026-08-29
- **Perfil operacional:** `OFF`; governança pelo harness nativo, Keep Core ativo
- **Escopo:** issues #40, #69, #81, #83 e #84 no repositório WendKeep

## Contexto

A epic #69 possui doze das dezesseis entregas concluídas. As issues #70–#80 e #82 já foram
entregues, mas o checklist da epic ainda não reflete esse estado. As quatro lacunas materiais são:

- #40 — política universal de commit baseada em evidências;
- #81 — segurança, autorização e ciclo de vida dos dados do Observer;
- #83 — bridges oficiais para Spec Kit e Superpowers sem autoridade duplicada;
- #84 — modularização final, migrations, CI e supply-chain hardening.

A #84 depende das três primeiras e do receipt de commit da #40. A #69 só pode ser encerrada
depois do E2E global do programa.

## Decisões aprovadas

| Tema | Decisão |
|---|---|
| Perfil | Permanecer em `OFF`; não criar leases, flows ou changes do Wend Runtime. |
| Execução | Desenvolvimento paralelo das fundações, integração serial em `main`. |
| Publicação | Produzir versões intermediárias `0.x`; não declarar `1.0.0`. |
| PRs | Uma implementação revisável por PR; #84 será dividida em fases menores. |
| Testes | Testes focados durante Red/Green; suíte longa somente no candidato final pré-merge. |
| Merge | Só integrar commit final com testes focados, revisão, suíte longa e check remoto verdes. |
| Epic | Atualizar #69 progressivamente e fechá-la apenas após todos os filhos e o E2E global. |

## Topologia de branches e releases

As três fundações podem ser desenvolvidas em paralelo:

```text
wk/universal-commit   (#40) ─┐
wk/observer-security (#81) ─┼─→ #84 em fases → E2E global → fechar #69
wk/ecosystem-bridges (#83) ─┘
```

A construção pode ocorrer em worktrees independentes, mas os merges serão serializados:

1. #40;
2. #81;
3. #83;
4. fases da #84;
5. fechamento da #69.

Cada branch nasce da `main` vigente. Antes da janela de integração, a branch é reconciliada com a
`main` mais recente. Somente então são definidos o próximo minor `0.x`, o bump e a entrada do
`CHANGELOG.md`. Isso evita colisões entre branches paralelas e impede reservar números que outra
release possa ocupar.

Uma referência inicial de cadência é `0.87.0` para #40, `0.88.0` para #81 e `0.89.0` para #83.
Esses números são indicativos: `npm view wendkeep version` e o estado remoto são autoridade antes
de cada bump.

## #40 — commit universal baseado em evidências

### Objetivo

Gerar e validar mensagens de commit determinísticas sem depender do comportamento de um host ou
modelo específico e sem inventar provas.

### Componentes

- kernel de commit com entrada tipada e saída determinística;
- coletor limitado a diff staged, tarefas, ADR, Evidence Envelope, evidência e verdict válidos;
- skill canônica `wk-commit` sincronizável para Codex e Claude;
- wrappers Node multiplataforma em `.githooks/`;
- `prepare-commit-msg` idempotente para estruturar o rascunho;
- `commit-msg` para rejeitar formato, autoridade, privacidade ou evidência inválidos;
- validação equivalente no CI para detectar bypass local.

### Regras de autoridade e privacidade

- somente evidência ligada ao checkout e commit correto pode ser promovida como verificada;
- campos privados do Vault/runtime nunca entram na mensagem;
- segredos, tokens, caminhos locais e PII são rejeitados ou sanitizados;
- coautoria só é registrada quando uma identidade factual está disponível;
- amend, merge, squash, reuso de mensagem e commits sem change não duplicam nem fabricam corpo.

## #81 — segurança e ciclo de vida do Observer

### Objetivo

Transformar as proteções locais atuais em um contrato explícito de captura, autorização, retenção,
purge, auditoria e criptografia.

### Componentes

- threat model e classificação versionada de dados;
- policy engine por classe, path, entidade, projeto e operação;
- redaction configurável para conteúdo documental, prompts, respostas e transcripts;
- registry de tokens armazenados por hash, com projeto, roles, scopes, expiração e revogação;
- matriz endpoint × capability aplicada a leituras e mutações;
- retention runner e purge transacional, idempotente e acompanhado por receipt;
- audit log sem registrar o conteúdo sensível acessado;
- adapter de criptografia at rest com AES-256-GCM e material de chave externo;
- migrations seguras para bancos, outbox e conteúdo existentes;
- integração com publisher, MCP, sync e dashboard.

### Defaults de segurança

- ingest e mutações exigem autenticação;
- leituras sensíveis exigem autorização mesmo em loopback;
- agregados não sensíveis podem permanecer abertos em loopback quando a política permitir;
- política que exige criptografia falha fechada quando a chave está ausente ou inválida;
- purge remove derivados e índices, registra tombstone/receipt e não expõe o payload removido.

O novo contrato substitui explicitamente a regra histórica que permitia mutações locais sem Bearer.

## #83 — bridges oficiais do ecossistema

### Objetivo

Integrar Spec Kit e Superpowers como adapters opcionais, preservando o WendKeep como autoridade de
contratos, evidência e estado governado.

### Contrato do bridge

- schema versionado com ownership, origem, IDs, hashes e compatibility range;
- matriz explícita de precedência e conflito;
- habilitação independente de cada adapter;
- ausência ou versão incompatível produz diagnóstico tipado, sem fallback silencioso.

### Spec Kit

- detector/importador somente leitura;
- preservação de IDs e hashes da fonte;
- referência externa, nunca cópia promovida automaticamente a autoridade canônica;
- bloqueio de execução quando drift ou ownership concorrente for detectado.

### Superpowers

- dispatch derivado dos task/handoff contracts canônicos;
- ingest de artifacts, reviews e commits inicialmente como `reported`;
- promoção para `verified` somente após prova Git, CI ou Evidence Envelope compatível;
- nenhuma escrita direta sobre o plano ou tarefas canônicas.

O E2E isolado cobre Spec Kit → bridge → WendKeep → Superpowers → artifacts/review → prova Git/CI →
cleanup.

## #84 — modularização, migrations, CI e supply chain

A issue será dividida em PRs menores, mantendo um único checklist de fechamento.

### Fase A — packages e fachadas

- extrair worktrees, Observer, sync e contracts/evidence para packages com APIs públicas claras;
- manter fachadas legadas finas durante a janela de compatibilidade;
- reduzir `src/memory.mjs`, `src/init.mjs` e hooks de sessão a composição/orquestração;
- preservar grafo acíclico e impedir imports reversos.

### Fase B — migration harness

- registry unificado de migrations para Vault, ledger, active contexts, Observer e portable state;
- operações `plan`, `apply`, `rollback` e `repair` com journal e receipt;
- fixtures N-2 e N-1;
- crash injection por etapa, retomada idempotente e validação pós-reparo;
- falha fechada para versão futura ou estado incompatível.

### Fase C — CI e supply chain

- matriz relevante com Linux, Windows, macOS e Node 20;
- thresholds de coverage por package e mutation testing nos kernels críticos;
- Actions fixadas por commit SHA e permissões mínimas por job;
- CodeQL, dependency review, SBOM e proveniência do tarball;
- branch protection com os checks finais requeridos antes do merge.

### Fase D — compatibilidade e fechamento técnico

- tarball instalado em consumidor isolado com configurações Claude, Codex e MCP;
- matriz pública de compatibilidade;
- política de suporte, depreciação e remoção das fachadas legadas;
- documentação arquitetural PT-BR/EN;
- integração do receipt da #40 ao fechamento de commit/release.

As fases permanecem em versões `0.x`; o encerramento da #84 não implica release `1.0.0`.

## #69 — fechamento do programa

Após cada issue filha:

1. atualizar somente os checkboxes correspondentes na epic;
2. registrar o PR, versão, tag, Release e evidência de merge;
3. não marcar o DoD global por inferência.

O E2E final parte de clone limpo e comprova:

- duas worktrees concorrentes sem troca de contexto, handoff ou evidência;
- prova vinculada ao checkout exato;
- retomada por contratos estruturados;
- transporte de authored state sem runtime privado;
- MCP capability-gated;
- degradação explícita dos hosts;
- cleanup pós-merge;
- segurança e ciclo de vida do Observer;
- bridges sem autoridade duplicada;
- commit derivado de prova fresca;
- migrations, pacote instalado e receipts/release alinhados.

Somente depois desse E2E os itens restantes do DoD e a #69 podem ser fechados.

## Estratégia de testes

### Durante Red/Green

- executar apenas o arquivo, package ou cenário diretamente afetado;
- usar testes discriminantes para contratos, segurança, migrations e falhas esperadas;
- rodar checks rápidos de sintaxe, fronteira, privacidade ou documentação somente quando aplicáveis;
- não executar a suíte completa após ajustes pequenos.

### Candidato final pré-merge

Para o commit final de cada PR:

1. executar todos os testes focados da issue;
2. executar checks de pacote, privacidade, documentação bilíngue e tarball quando aplicáveis;
3. revisar o diff de forma independente;
4. executar a suíte longa completa uma vez;
5. exigir o check remoto do PR verde.

Qualquer alteração posterior invalida o candidato e exige nova prova proporcional; se o commit
mudar depois da suíte longa, a suíte longa é repetida. Após o merge, não há repetição manual: a
matriz automática de release é a validação remota.

## Tratamento de falhas

- falha focada bloqueia a tarefa correspondente;
- falha longa no candidato bloqueia o merge e é investigada antes de nova execução completa;
- conflito de versão/changelog é resolvido somente após reconciliar com a `main` e o npm atual;
- drift externo nos bridges bloqueia import/dispatch;
- chave ausente sob política de criptografia obrigatória bloqueia persistência sensível;
- migration interrompida retoma pelo journal ou executa repair explícito;
- check remoto ou branch protection divergente bloqueia merge/release;
- nenhum gate é contornado para cumprir calendário.

## Fora do escopo

- declarar ou publicar `1.0.0`;
- tornar Spec Kit ou Superpowers autoridades do estado WendKeep;
- armazenar chaves criptográficas dentro do repositório ou banco do Observer;
- publicar Vault, runtime privado, transcripts ou dados reais;
- remover fachadas legadas sem janela documentada de compatibilidade;
- agrupar todas as entregas em uma mega-PR;
- executar repetidamente a suíte longa durante desenvolvimento incremental.

## Critérios de conclusão do design

- #40, #81 e #83 possuem PRs e releases intermediárias independentes;
- #84 é entregue em fases revisáveis, todas em versões `0.x`;
- cada merge corresponde a um commit final testado e a um check remoto verde;
- npm, tag, GitHub Release e changelog permanecem alinhados por versão;
- #69 reflete os estados reais e só fecha após o E2E program-level;
- o perfil persistente continua `OFF` durante todo o programa.
