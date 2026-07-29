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

## 0.65 Kernel de configuração MCP

`packages/mcp/src/config.mjs` é a autoridade canônica para a chave `wendkeep-vault`, a entrada de
transporte do MCPVault, a seleção de servidores descritos pelo catálogo e o merge imutável de
configuração MCP. O índice privado `packages/mcp/src/index.mjs` reúne essa superfície interna sem
executar processos, acessar filesystem ou produzir efeitos durante o import.

`src/taxonomy.mjs` continua dono do catálogo de companions e hosts, mas entrega descritores como
dados ao kernel. `src/init.mjs` continua dono da orquestração do filesystem e delega a composição
da configuração ao MCP. Isso preserva a direção entre adapters e evita que o kernel dependa do
catálogo ou do instalador.

O comportamento do `init` não muda: propriedades de topo e servidores existentes são preservados,
`wendkeep-vault` continua usando `npx -y @bitbonsai/mcpvault@latest <vault>`, `--no-mcp` continua
desabilitando essa entrada e JSON inválido permanece byte a byte intacto enquanto a proposta é
gravada em `.mcp.json.new`. O teste de tarball executa esse fluxo em um consumidor isolado.

O workspace MCP permanece privado nesta fase. Não existe export raiz `wendkeep/mcp`, publicação
`@wendkeep/mcp` ou servidor MCP nativo; a instalação continua sendo o único pacote `wendkeep`.

## 0.64 Runtime canônico da CLI

`packages/cli/src/index.mjs` é a autoridade canônica para help, versão, seleção de Vault,
apresentação de erros e dispatch lazy dos comandos. O entrypoint público
`bin/wendkeep.mjs` mantém apenas o shebang, importa `runCli` e o invoca. Assim, regras de
composição não voltam a se acumular na fachada executável.

O workspace continua privado. Os aliases `wendkeep` e `wk` são a superfície pública da CLI;
o pacote raiz não declara `wendkeep/cli` como API programática. As implementações de comandos em
`src/` e `hooks/` permanecem consumidores temporários durante a migração incremental. Help antes
do Vault, mensagens, streams, exit codes, hooks e precedência de binding não mudam. O tarball
instalado valida o runtime empacotado e ambos os aliases fora do checkout.

## 0.63 Harness FLOW Store

Nesta fase, o locale e a taxonomia canônicos ficam em `packages/vault/src/locale.mjs`; o store
durável canônico do FLOW fica em `packages/harness/src/flow-store.mjs`. O Harness consome apenas o
índice público do Vault (`packages/vault/src/index.mjs`), e o Vault nunca depende do Harness.

`hooks/locale.mjs` e `hooks/vault-runtime-store.mjs` permanecem fachadas finas e reexportam os
mesmos bindings por identidade. A extração não muda paths persistidos, schemas nem a disciplina de
locks, portanto não exige migração. A publicação também não se fragmenta: há um único tarball do
pacote raiz `wendkeep`, que contém as superfícies modulares.

O lock público ou um metadado owner/lease pode desaparecer legitimamente durante a liberação. O
Vault repete apenas operações explicitamente escopadas ao lock público e apenas para `ENOENT`, com
backoff curto, um budget global e o deadline original da aquisição. A limpeza final usa um budget
curto independente para não deixar owner/lease residual. O retry nunca se aplica a `.pending`,
junction, symlink, reparse point, `EACCES`, tipo inesperado ou estado irresolvível persistente, que
continuam falhando fechado.

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
subpaths públicos do pacote raiz, não publicações separadas. CLI e MCP já possuem implementações
canônicas privadas: a primeira continua exposta pelos binários e a segunda pelos efeitos do
`init`. `integrations` e `pi` permanecem fronteiras reservadas; a sequência planejada da migração
é MCP → Integrations → Pi.
