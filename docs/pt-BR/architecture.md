# Arquitetura modular

O pacote instalável continua sendo `wendkeep`. Internamente, o repositório separa responsabilidades
em workspaces privados para permitir migração incremental e testes explícitos de dependência.

| Superfície | Responsabilidade |
|---|---|
| `cli` | Parsing, apresentação e composição dos comandos. |
| `harness` | Perfis, políticas, changes, sensores e verificação. |
| `vault` | Keep Core, binding do projeto, kernel de memória e I/O local seguro. |
| `mcp` | Transporte e configuração MCP. |
| `integrations` | Adaptadores de eventos dos hosts de agentes. |
| `pi` | Extensão e hooks específicos do Pi. |

## Direção de dependências

`vault` é a base independente e nunca depende de `harness`. Perfis como `OFF` desligam apenas a
governança do Wend Runtime; Vault, sessões e memória continuam ativos. Binding/resolução,
segurança física de paths e o kernel de memória agora vivem canonicamente em
`packages/vault/src/`.

O kernel reúne `memory-schema`, `memory-mode`, `memory-handoff`, `memory-store`, `validate-core` e
`validate-memory`. Essa fronteira é dona do schema v2, do ledger append-only, da projeção, do
handoff e das validações; captura de sessão e orquestração do harness continuam fora dela.

Consumidores programáticos importam a superfície suportada pelo subpath do pacote raiz:

```js
import {
  resolveProjectVault,
  validateSharedMemory,
  readMemoryLedger,
} from 'wendkeep/vault';
```

Os paths históricos em `hooks/` e `src/` permanecem como fachadas finas de reexportação para
compatibilidade; o mapa de exports também preserva bare specifiers instalados como
`wendkeep/hooks/memory-store.mjs`. Por isso, a extração não altera o schema v2 nem reescreve ledger, projeção ou
dados de sessão: não há migração de dados.

Todos os seis workspaces permanecem privados e internos ao monorepo; eles não são pacotes npm
independentes. A instalação continua sendo `wendkeep`, e `wendkeep/vault` é a única entrada pública
nova desta fase. Os demais workspaces são fronteiras reservadas e ganharão superfícies públicas
somente quando suas implementações forem migradas.
