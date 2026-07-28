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

Os adapters de host (`cli`, `mcp`, `integrations` e `pi`) compõem o runtime pelo `harness`; o
`harness`, por sua vez, usa o `vault`. A direção permitida é:

```text
adapters (cli/mcp/integrations/pi) -> Harness -> Vault
```

`vault` é a base independente e nunca depende de `harness`. O workspace `harness` é o dono
canônico da resolução/política dos Perfis de Operação e da engine de sensores em
`packages/harness/src/`; o `vault` continua dono do binding/resolução, da segurança física de paths
e do kernel de memória em `packages/vault/src/`.

O perfil `OFF` desativa somente a ativação automática da governança do Wend Runtime — router,
skill gate, FLOW e gates automáticos. Keep Core, Vault, sessões e memória continuam ativos, e os
comandos explícitos do WendKeep permanecem disponíveis como opt-in deliberado.

O kernel reúne `memory-schema`, `memory-mode`, `memory-handoff`, `memory-store`, `validate-core` e
`validate-memory`. Essa fronteira é dona do schema v2, do ledger append-only, da projeção, do
handoff e das validações; captura de sessão e orquestração do harness continuam fora dela.

Consumidores programáticos importam as superfícies suportadas pelos subpaths do pacote raiz:

```js
import {
  resolveOperatingProfile,
  runSensors,
  evaluateGate,
} from 'wendkeep/harness';

import {
  resolveProjectVault,
  validateSharedMemory,
  readMemoryLedger,
} from 'wendkeep/vault';
```

Os paths históricos `src/operating-profile.mjs` e `hooks/sensors-core.mjs` permanecem como fachadas
finas para o `harness`; os demais paths históricos em `hooks/` e `src/` preservam a compatibilidade
do `vault`. O mapa de exports também mantém bare specifiers instalados. Por isso, a extração não
altera perfis, contratos de sensores, schema v2, ledger, projeção ou dados de sessão: não há
migração de dados.

Todos os seis workspaces permanecem privados e internos ao monorepo; eles não são pacotes npm
independentes. A instalação continua sendo `wendkeep`; `wendkeep/harness` e `wendkeep/vault` são
subpaths públicos do pacote raiz, não publicações separadas. Os demais workspaces são fronteiras
reservadas e ganharão superfícies públicas somente quando suas implementações forem migradas.
