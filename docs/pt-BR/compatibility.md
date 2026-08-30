# Compatibilidade da linha 0.x

O WendKeep 0.90 continua uma release intermediária: não declara estabilidade 1.0. A instalação
permanece um único pacote `wendkeep`, local-first e sem dependências de runtime.

## Matriz suportada

| Superfície | Node.js | Sistemas exercitados no CI | SQLite |
|---|---|---|---|
| Keep Core, CLI, Vault, Harness, sync e MCP Core | Node.js 18 e Node.js 20 | Linux | Não é exigido |
| Observer completo | Node.js 22.13 e Node.js 24 | Linux, Windows e macOS | `node:sqlite` exigido |

Versões mais novas do Node podem funcionar, mas só as linhas acima compõem o gate obrigatório. O
Observer falha fechado abaixo de 22.13; o Keep Core continua disponível sem carregar SQLite.

## APIs e facades

Os subpaths públicos são `wendkeep/commit`, `harness`, `vault`, `worktrees`, `observer`, `sync`,
`integrations`, `mcp` e `migrations`. Os workspaces `@wendkeep/*` continuam privados e não são
publicados separadamente. `wendkeep/cli` não é API programática: use os binários `wendkeep`/`wk`.

As facades históricas versionadas em `src/*` e `hooks/*` preservam identidade durante a linha 0.x.
Uma depreciação deve aparecer no CHANGELOG e na documentação por pelo menos duas versões minor; a
remoção não ocorrerá antes da 1.0. Deep imports em `wendkeep/packages/*` nunca foram contrato.

## Política de depreciação

Antes de remover ou alterar uma facade pública, o projeto publica substituto, exemplo de migração,
diagnóstico acionável e janela mínima. Alterações de autoridade, dados persistidos ou segurança
continuam exigindo migration/receipt; uma extração física sem mudança de contrato não exige dados.

Veja também a [arquitetura](architecture.md), as [migrations](migrations.md) e a
[política de suporte](support-policy.md).
