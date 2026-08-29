# Plano — finalização incremental do WendKeep Control Plane

**Status:** pronto para revisão  
**Design:** [design aprovado](../../docs/superpowers/specs/2026-08-29-wendkeep-control-plane-finalization-design.md)  
**Perfil:** `OFF`; Keep Core ativo  
**Base auditada:** `main`/`origin/main` em `77fc0b8307ca8ee4c6d57f1c6158d2f0c87f9fae`

## Objetivo

Entregar #40, #81, #83 e #84 em versões intermediárias `0.x`, comprovar o DoD program-level e
fechar #69 sem antecipar `1.0.0`.

## Dependências

```text
#40 ─┐
#81 ─┼─→ #84-A → #84-B → #84-C → #84-D → E2E → #69
#83 ─┘
```

#40, #81 e #83 podem ser construídas em paralelo. Integração, bump, release e fechamento são
seriais: cada branch reconcilia a `main` e consulta o npm antes de definir a próxima versão.

## Fases

| Fase | Escopo | Estado |
|---|---|---|
| [01](phase-01-universal-commit.md) | #40 — commit universal | Pendente |
| [02](phase-02-observer-security.md) | #81 — segurança do Observer | Pendente |
| [03](phase-03-ecosystem-bridges.md) | #83 — Spec Kit/Superpowers | Pendente |
| [04](phase-04-package-extraction.md) | #84-A — packages e fachadas | Bloqueada por 01–03 |
| [05](phase-05-migration-harness.md) | #84-B — migrations e repair | Bloqueada por 04 |
| [06](phase-06-ci-supply-chain.md) | #84-C/D — CI, supply chain e suporte | Bloqueada por 04–05 |
| [07](phase-07-program-e2e-and-closure.md) | #84/#69 — E2E e fechamento | Bloqueada por 01–06 |

## Política de testes

- Red/Green: somente testes focados do comportamento alterado.
- Check intermediário: sintaxe, fronteira, privacidade, docs ou package apenas quando aplicável.
- Candidato final: testes focados + revisão independente + checks aplicáveis + uma suíte longa.
- Alteração após suíte longa invalida o candidato.
- Após merge, confiar na matriz automática; não repetir manualmente.

## Gate de integração por PR

1. Branch limpa e reconciliada com `origin/main`.
2. Testes focados verdes.
3. Diff e fronteiras revisados independentemente.
4. `npm view wendkeep version` consultado.
5. Bump minor `0.x` e `CHANGELOG.md` adicionados somente nessa janela.
6. Suíte longa executada no commit final.
7. PR e check remoto verdes.
8. Merge, tag, npm e GitHub Release lidos de volta antes de atualizar a issue.

## Restrições

- Não usar Wend Runtime além de confirmar o perfil `OFF`.
- Não publicar Vault/runtime/dados reais.
- Não fazer mega-PR.
- Não declarar `1.0.0`.
- Commit, push, merge e alterações de proteção remota exigem autorização no momento operacional.

## Pontos operacionais a resolver durante a execução

- Próxima versão exata: derivada do npm no momento de cada integração.
- Nomes finais dos required checks: derivados dos workflows após a fase 06.
- Janela de remoção das fachadas legadas: publicada na matriz de suporte da fase 06.
