# Arquitetura modular

O pacote instalável continua sendo `wendkeep`. Internamente, o repositório separa responsabilidades
em workspaces privados para permitir migração incremental e testes explícitos de dependência.

| Superfície | Responsabilidade |
|---|---|
| `cli` | Parsing, apresentação e composição dos comandos. |
| `harness` | Perfis, políticas, changes, sensores e verificação. |
| `vault` | Keep Core, binding do projeto e I/O local seguro. |
| `mcp` | Transporte e configuração MCP. |
| `integrations` | Adaptadores de eventos dos hosts de agentes. |
| `pi` | Extensão e hooks específicos do Pi. |

## Direção de dependências

`vault` é a base independente e nunca depende de `harness`. Perfis como `OFF` desligam apenas a
governança do Wend Runtime; Vault, sessões e memória continuam ativos. Nesta primeira etapa,
binding/resolução e segurança física de paths já vivem em `packages/vault`, enquanto os paths
históricos continuam como fachadas compatíveis.

Consumidores programáticos podem importar a superfície extraída:

```js
import { resolveProjectVault, assertVaultPathSafe } from 'wendkeep/vault';
```

Os demais workspaces são fronteiras reservadas e ganharão APIs públicas somente quando suas
implementações forem migradas.
