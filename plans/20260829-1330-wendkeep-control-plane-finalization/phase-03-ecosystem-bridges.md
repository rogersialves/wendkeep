# Fase 03 — #83: bridges Spec Kit e Superpowers

## Visão geral

- **Branch:** `wk/ecosystem-bridges`
- **Prioridade:** alta
- **Estado:** pendente

Adicionar adapters opcionais sem criar uma segunda autoridade de plano, tarefa ou evidência.

## Requisitos

- Bridge schema e matriz de ownership/precedência versionados.
- Importador Spec Kit read-only com IDs/hashes preservados.
- Drift e ownership concorrente bloqueiam execução.
- Dispatch Superpowers deriva somente dos contratos canônicos.
- Artifacts externos entram como `reported` até prova Git/CI.
- Adapters habilitáveis separadamente e protegidos por compatibility ranges.
- Ausência/incompatibilidade gera diagnóstico tipado.

## Arquitetura

```text
Spec Kit --read-only--> bridge projection
                              ↓
WendKeep task/handoff/artifact authority
                              ↓
                   Superpowers dispatch
                              ↓
external artifacts --verify Git/CI--> Evidence Envelope
```

## Arquivos

### Criar

- `C:/GitHub/WendKeep/schema/ecosystem-bridge-v1.schema.json`.
- `C:/GitHub/WendKeep/packages/integrations/src/bridge-contract.mjs`.
- `C:/GitHub/WendKeep/packages/integrations/src/bridge-diagnostics.mjs`.
- `C:/GitHub/WendKeep/packages/integrations/src/spec-kit-adapter.mjs`.
- `C:/GitHub/WendKeep/packages/integrations/src/superpowers-adapter.mjs`.
- `C:/GitHub/WendKeep/packages/integrations/src/bridge-config.mjs`.
- `C:/GitHub/WendKeep/tests/ecosystem-bridge-contract.test.mjs`.
- `C:/GitHub/WendKeep/tests/spec-kit-adapter.test.mjs`.
- `C:/GitHub/WendKeep/tests/superpowers-adapter.test.mjs`.
- `C:/GitHub/WendKeep/tests/ecosystem-bridge-e2e.test.mjs`.
- `C:/GitHub/WendKeep/docs/pt-BR/commands/ecosystem-bridges.md`.
- `C:/GitHub/WendKeep/docs/en/commands/ecosystem-bridges.md`.

### Modificar

- `C:/GitHub/WendKeep/packages/integrations/src/index.mjs` — exports.
- `C:/GitHub/WendKeep/packages/integrations/src/capabilities.mjs` — adapters/ranges.
- `C:/GitHub/WendKeep/src/task-contracts.mjs` — entrada externa nunca verificada por default.
- `C:/GitHub/WendKeep/src/task.mjs` — diagnostics/dispatch sem ownership externo.
- `C:/GitHub/WendKeep/src/doctor.mjs` — detecção e compatibilidade.
- `C:/GitHub/WendKeep/bin/wendkeep.mjs` e `packages/cli/src/index.mjs` — comandos bridge.
- `C:/GitHub/WendKeep/package.json` — schema/docs/check/tarball.
- READMEs e guias PT-BR/EN correspondentes.

## Passos

1. Escrever schema, matriz de autoridade e testes de conflito.
2. Tornar autoridade externa `reported` por construção.
3. Implementar detecção e import Spec Kit sem writes.
4. Implementar drift/hash/ID diagnostics.
5. Implementar dispatch Superpowers a partir de contracts derivados.
6. Verificar artifacts/reviews/commits por Git/CI antes de promover autoridade.
7. Cobrir adapter ausente, incompatível e desabilitado.
8. Executar E2E em consumidor isolado e documentar small/medium/large.

## Testes focados

- Quatro novos arquivos de bridge.
- `task-contracts`, `host-capabilities`, `doctor`, `mcp` e tarball afetados.
- Mutantes: adapter escreve plano, external vira verified, hash ignorado, range ignorado.

## Critérios de sucesso

- Spec Kit nunca modifica o estado canônico.
- Superpowers nunca assume ownership de plano/tarefa.
- Drift é diagnosticado antes de execute/verify.
- Artifacts só viram `verified` com prova independente.
- Cada adapter funciona ausente/desabilitado sem degradar o Core.

## Riscos e mitigação

- **Formato externo volátil:** compatibility range e parser isolado por versão.
- **Autoridade duplicada:** ownership obrigatório no schema e conflito fail-closed.
- **Texto não confiável:** normalização estrutural; nunca executar comandos importados.
- **Dependência opcional quebrando install:** zero import/autoload quando adapter desabilitado.
