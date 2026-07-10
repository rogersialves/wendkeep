# Fase 4 — integração e recuperação NutriGym

## Status

Concluída em 2026-07-09. Prioridade P1.

## Escopo permitido

- `C:\GitHub\NutriGym-Vision\.claude\settings.json`
- definições/skills geradas pelo WendKeep
- `.NutriGymBrain\02-Sessões`, `07-Specs`, `08-Mudanças` e `.brain`
- instalação local de `wendkeep` para smoke

Arquivos de produto mobile/backend existentes são somente leitura.

## Implementação

1. Reinspecionar `git status` e o estado atual das changes; preservar toda alteração do usuário.
2. Empacotar WendKeep 0.32.0 localmente e instalar no consumidor sem publicar.
3. Executar `wendkeep init --force` com o vault existente; revisar diff antes de aceitar.
4. Sincronizar skills e validar JSON dos hooks.
5. Recuperar os planos aprovados do transcript `47e1748f-c769-4dab-abba-365faa5e440e` sem duplicação.
6. Executar o backfill da iteração ausente de forma idempotente.
7. Classificar mudanças da sessão; escrever specs a partir do comportamento final implementado e da evidência, não de heurística.
8. Promover/backfill specs arquivadas com backlink de proveniência; não arquivar mudança ativa automaticamente.
9. Adicionar ignore local para `.NutriGymBrain/.brain/.change-*` se ainda necessário.
10. Rodar doctor, listar specs/changes e validar links da sessão.

## Aceite

- Hooks ativos usam a versão 0.32.0 e funcionam em subdiretórios.
- Sessão contém todos os turns recuperáveis sem duplicatas.
- `07-Specs` contém contratos vivos com proveniência.
- Mudanças ativas do usuário permanecem ativas e intactas.
- Nenhum arquivo de produto é modificado pelo trabalho de recuperação.

## Rollback

- Manter o tarball anterior disponível via lockfile/cache.
- Reverter apenas configurações/artefatos WendKeep gerados; nunca resetar a árvore do usuário.
