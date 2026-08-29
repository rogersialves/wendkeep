# Fase 07 — #84/#69: E2E e fechamento do programa

## Visão geral

**Branch:** `wk/control-plane-program-e2e`  
**Dependências:** fases 01–06 entregues  
**Estado:** bloqueada

Revalidar o programa completo em clone limpo, atualizar checklists por prova e fechar #84/#69.

## Cenário E2E

1. Instalar o tarball atual em consumidor isolado.
2. Inicializar projeto com perfil `OFF` e Keep Core ativo.
3. Criar duas worktrees concorrentes e provar isolamento causal.
4. Produzir task/handoff/evidence e retomar em novo agente por contrato.
5. Exercitar authored/private, sync e degradação de host.
6. Executar MCP com capability permitida e negar capability ausente.
7. Publicar no Observer sob policy; testar token, redaction, encryption, retention e purge receipt.
8. Importar Spec Kit read-only e despachar Superpowers sem ownership duplicado.
9. Gerar commit pela #40 e validar mensagem/receipt.
10. Simular upgrade N-2/N-1 e crash/repair.
11. Fazer cleanup pós-merge e provar ausência de perda de estado.
12. Validar tarball, SBOM, provenance e cadeia changelog/tag/npm/Release da última versão `0.x`.

## Arquivos

### Criar

- `C:/GitHub/WendKeep/tests/control-plane-program-e2e.test.mjs`.
- `C:/GitHub/WendKeep/tests/fixtures/control-plane-consumer/` — fixture sanitizada.
- `C:/GitHub/WendKeep/docs/pt-BR/control-plane-program.md`.
- `C:/GitHub/WendKeep/docs/en/control-plane-program.md`.

### Modificar

- `C:/GitHub/WendKeep/README.md` e `README.en.md` — estado 0.x comprovado.
- `C:/GitHub/WendKeep/CHANGELOG.md` — somente na janela de integração.
- Bodies/checklists das issues #40, #81, #83, #84 e #69 — operação GitHub após autorização.

## Passos

1. Construir fixture sem Vault/runtime/dados reais.
2. Implementar E2E por checkpoints independentes e diagnóstico curto.
3. Executar testes focados do cenário.
4. Auditar os 11 itens do DoD da #69 contra evidência fresca.
5. Revisar diff e privacidade de package/docs.
6. Executar uma suíte longa final no commit candidato.
7. Abrir PR, aguardar todos os checks e integrar após autorização.
8. Ler npm, tag, Release, SBOM, provenance e receipt de volta.
9. Marcar checklists somente onde a prova passou; fechar #84 e então #69.

## Critérios de sucesso

- Os 11 itens do DoD possuem evidência fresca e reproduzível.
- Issues filhas estão fechadas antes da epic.
- Nenhum dado privado entra no fixture, tarball, PR ou Release.
- `main`, npm, tag e GitHub Release estão alinhados na versão `0.x` final.
- O perfil persistente permanece `OFF`.
- Nenhuma comunicação chama a entrega de `1.0.0`.

## Riscos e mitigação

- **E2E monolítico/flaky:** checkpoints isolados, clocks/ports/temp dirs controlados.
- **Prova stale:** executar somente depois de todas as fases em `main`.
- **Fechamento administrativo incorreto:** child-first e readback de cada issue.
- **Custo de máquina:** suíte longa uma vez no candidato; falhas são depuradas com testes focados.
