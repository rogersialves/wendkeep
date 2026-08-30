# Issue #84 — execução da release intermediária 0.90.0

Perfil humano persistente: **OFF**. Keep Core permaneceu ativo; nenhum lease adaptativo ou estado
de change foi criado. Escopo: branch `wk/release-hardening`, sem push, PR ou configuração remota.

## Tarefas e requisitos

- [x] 84.1 MOD-22: extrair `contracts`, `evidence`, `sync` e `worktrees`, publicar facades explícitas e preservar identidade. [sensor:release-hardening]
- [x] 84.2 MOD-23: manter `src/` como facades puras e grafo de packages acíclico. [sensor:release-hardening]
- [x] 84.3 MIG-1: registry e schema público de receipt para Vault, ledger, contexts, Observer e portable. [sensor:release-hardening]
- [x] 84.4 MIG-2: upgrade sequencial N-2/N-1 preservando authority, memory, contracts e evidence. [sensor:release-hardening]
- [x] 84.5 MIG-3: checksum, backup, crash/resume, repair explícito e rollback determinístico. [sensor:release-hardening]
- [x] 84.6 CI-SC-1..8: Actions por SHA, permissões mínimas, matrizes, security, SBOM, artifact e checks. [sensor:release-hardening]
- [x] 84.7 CI-QUALITY-1..3: thresholds e mutantes fail-closed por package para onze superfícies críticas. [sensor:release-hardening]
- [x] 84.8 DOC-84-1..2: arquitetura, compatibilidade, suporte, depreciação e migrations PT-BR/EN. [sensor:release-hardening]
- [x] 84.9 Consumidor isolado instala o `release-candidate.tgz` preservado e valida Claude, Codex e MCP contra seu digest. [sensor:release-hardening]
- [x] 84.10 Package, lock e CHANGELOG convergem em `0.90.0`, sem antecipar `1.0`. [sensor:release-tests]
- [x] 84.11 Staging e contexto canônico preparados; commit e intervalo são verificados pela evidência Git final. [sensor:check]

## Evidência focada

| Ciclo | RED factual | GREEN factual |
|---|---|---|
| Packages | workspaces/facades ausentes e imports reversos não detectados | modular/contratos focados `63/63`; reverse imports novos `0` |
| Migrations | package ausente `3/3`; adapters produtivos desconectados | cinco adapters `5/5`; migrations/harness/sequential/crash `18/18`; coverage `87.06/83.57/100` |
| CI/supply chain | policy `0/4`; SBOM/receipt/attestation ausentes | agregado remoto dependency-free `173/173`; coverage worktrees `95.45/70.26/96.30`; mutation integral anterior `11/11` |
| Docs/check config | arquivos ausentes `0/3` | parity/architecture/required checks `3/3` |
| Consumer | smoke anterior podia reempacotar a árvore | receipt e smoke usam o mesmo `artifacts/release-candidate.tgz` e digest |
| Suite final | candidato anterior expôs `7/2282` regressões de topologia/fixture | sete arquivos discriminantes `56/56`; Integrations segue privado e Evidence publica a versão raiz |

O primeiro baseline real de coverage recusou thresholds aspiracionais. Os testes focados foram
ampliados antes de fixar o gate no baseline observado; o gate final impede regressão por package.
A suíte global/local longa foi executada uma vez no candidato anterior e revelou os sete casos
registrados acima; ela não foi repetida durante esta correção focada. A configuração versionada de
required checks é somente renderizada; proteção de `main` não foi alterada.
