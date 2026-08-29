# Fase 06 — #84-C/D: CI, supply chain e suporte

## Visão geral

**Branch:** `wk/ci-supply-chain-0x`  
**Dependências:** packages e migration harness  
**Estado:** bloqueada

Fechar os gates de plataforma, qualidade, dependências, artefatos e proteção remota sem antecipar 1.0.

## Requisitos

- Linux, Windows, macOS e Node 20 na matriz relevante.
- Coverage threshold por package e mutation em kernels críticos.
- Actions fixadas por SHA; permissões mínimas por job.
- CodeQL, dependency review, SBOM e provenance do tarball.
- Tarball testado em consumidor isolado.
- Compatibility/support/deprecation policy PT-BR/EN.
- Required checks na proteção da `main` somente após nomes estabilizados.

## Arquivos

### Criar

- `C:/GitHub/WendKeep/.github/workflows/codeql.yml`.
- `C:/GitHub/WendKeep/.github/workflows/dependency-review.yml`.
- `C:/GitHub/WendKeep/scripts/coverage-gate.mjs`.
- `C:/GitHub/WendKeep/scripts/mutation-kernels.mjs`.
- `C:/GitHub/WendKeep/scripts/generate-sbom.mjs`.
- `C:/GitHub/WendKeep/tests/ci-policy.test.mjs`.
- `C:/GitHub/WendKeep/tests/sbom.test.mjs`.
- `C:/GitHub/WendKeep/docs/pt-BR/compatibility.md`.
- `C:/GitHub/WendKeep/docs/en/compatibility.md`.
- `C:/GitHub/WendKeep/docs/pt-BR/support-policy.md`.
- `C:/GitHub/WendKeep/docs/en/support-policy.md`.

### Modificar

- `C:/GitHub/WendKeep/.github/workflows/test.yml` — matriz e permissões.
- `C:/GitHub/WendKeep/.github/workflows/auto-tag.yml` — SHAs, jobs e artifacts.
- `C:/GitHub/WendKeep/package.json` — scripts e toolchain.
- `C:/GitHub/WendKeep/tests/tarball-smoke.test.mjs` — packages/adapters/migrations.
- READMEs e arquitetura PT-BR/EN.
- Configuração remota de branch protection após autorização operacional.

## Passos

1. Inventariar Actions e fixar versões por commit SHA com comentário da versão humana.
2. Separar permissões por job; `id-token: write` apenas no publish.
3. Adicionar Node 20/macOS sem duplicar matrizes irrelevantes.
4. Definir thresholds iniciais a partir do baseline e impedir regressão.
5. Mutar somente policy/authz, contracts/authority, migrations e provenance.
6. Adicionar CodeQL e dependency review.
7. Gerar SBOM do tarball e anexar ao receipt/release.
8. Expandir consumer tarball e publicar matrizes/políticas bilíngues.
9. Ler nomes reais dos checks e configurar branch protection.

## Testes focados

- `ci-policy`, `sbom`, `tarball-smoke`, release/provenance e docs bilíngues.
- Validação YAML e dry-runs locais onde disponíveis.
- Jobs remotos do PR são a prova de macOS/CodeQL/dependency review.
- Suíte longa local apenas no candidato final.

## Critérios de sucesso

- Nenhuma Action usa tag mutável.
- Jobs têm permissões mínimas.
- SBOM e provenance correspondem ao tarball publicado.
- Required checks impedem merge sem gates definidos.
- Matriz de suporte explica claramente plataformas e janela das fachadas.

## Riscos e mitigação

- **CI excessivo:** matriz por superfície, não produto cartesiano completo.
- **Mutation lenta:** somente kernels críticos e execução final/agendada.
- **SHA incorreto:** Dependabot/renovação controlada e teste de policy.
- **Lockout da main:** configurar checks somente depois de execução verde e com bypass do owner preservado.
