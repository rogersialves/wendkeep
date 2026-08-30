# Fase 04 — #84-A: packages e fachadas

## Visão geral

- **Branch:** `wk/architecture-packages-0x`
- **Dependências:** fases 01–03 integradas
- **Estado:** implementada na issue #84; fechamento registrado em `issue-84-execution.md`

Extrair domínios sem quebrar exports legados nem criar ciclos.

## Grafo-alvo

```text
cli → harness/worktrees/observer/sync/mcp
harness → contracts/evidence/integrations/vault
worktrees → contracts/vault
observer → integrations/vault
sync → integrations/vault
mcp → contracts/evidence/integrations/vault
```

Packages de domínio não importam CLI. Fachadas `src/*` só delegam durante a janela de suporte.

## Arquivos

### Criar

- `C:/GitHub/WendKeep/packages/worktrees/` — create/list/status/open/cleanup.
- `C:/GitHub/WendKeep/packages/sync/` — protocol/outbox/adapters.
- `C:/GitHub/WendKeep/packages/contracts/` — task/handoff/artifact/TDD contracts.
- `C:/GitHub/WendKeep/packages/evidence/` — envelope, provenance e receipt interfaces.
- Tests públicos por package e contract tests das fachadas.

### Modificar

- `C:/GitHub/WendKeep/src/worktree.mjs` e `worktree-cleanup.mjs` — fachadas.
- `C:/GitHub/WendKeep/src/sync-*.mjs` — fachadas.
- `C:/GitHub/WendKeep/src/task-contracts.mjs`, `tdd-attestation*.mjs`, `evidence-envelope.mjs`,
  `provenance-*.mjs` e `receipt-ledger.mjs` — fachadas/composição.
- `C:/GitHub/WendKeep/src/memory.mjs` — remover responsabilidades já encapsuladas.
- `C:/GitHub/WendKeep/src/init.mjs` e hooks de sessão — apenas composição.
- `C:/GitHub/WendKeep/package.json` — exports públicos e deprecation controlada.
- `C:/GitHub/WendKeep/tests/modular-package-boundaries.test.mjs` — grafo completo.

## Passos

1. Gerar dependency graph atual e definir ownership arquivo a arquivo.
2. Extrair um domínio por commit lógico, começando por contracts/evidence.
3. Extrair worktrees e sync.
4. Completar o package Observer iniciado na fase 02.
5. Converter `src/*` em fachadas sem comportamento.
6. Adicionar contract tests comparando API nova e fachada.
7. Publicar exports e avisos de depreciação sem remoção imediata.

## Testes focados

- Boundary tests estáticos após cada extração.
- Testes públicos do domínio movido.
- Testes das fachadas e tarball somente quando exports mudarem.
- Sem suíte longa entre extrações; uma vez no candidato final.

## Critérios de sucesso

- Grafo acíclico e sem import reverso.
- Packages utilizáveis sem carregar CLI ou Observer indevidamente.
- Fachadas legadas mantêm comportamento e códigos de erro.
- `src/memory.mjs` e `src/init.mjs` ficam estritamente orquestradores.

## Riscos e mitigação

- **Mega-diff:** extrações ordenadas e commits lógicos dentro do mesmo PR revisável.
- **Ciclo oculto:** gate estático a cada passo.
- **Quebra de consumidor:** contract tests e janela de depreciação.
