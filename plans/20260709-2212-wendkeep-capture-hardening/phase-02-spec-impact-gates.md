# Fase 2 — contrato de spec e gates

## Status

Concluída em 2026-07-09. Prioridade P0/P1.

## Arquivos

- Modificar `C:\GitHub\WendKeep\hooks\change-core.mjs`: scaffold, classificação e promoção fail-closed.
- Modificar `C:\GitHub\WendKeep\hooks\spec-core.mjs`: parsing/validação do impacto se necessário.
- Modificar `C:\GitHub\WendKeep\src\change.mjs`: G0 de spec e mensagens CLI.
- Modificar `C:\GitHub\WendKeep\hooks\harness-doctor.mjs`.
- Modificar testes `change-core.test.mjs`, `change-cli.test.mjs`, `spec-core.test.mjs`, `harness-doctor.test.mjs`.

## Implementação

1. Adicionar testes RED para `pending`, `required` sem delta e `none` sem justificativa.
2. Incluir `spec_impact: pending` e `spec_impact_reason` no scaffold não simples.
3. Criar parser pequeno e bilíngue para o frontmatter de impacto.
4. Validar união entre `specs:` e deltas reais no disco.
5. Bloquear archive quando a classificação estiver incompleta.
6. Fazer falha de parse/promoção retornar erro; remover catch silencioso.
7. Garantir que nenhum ADR/move ocorra depois de falha de promoção.
8. Adicionar diagnósticos ao `doctor`.
9. Preservar compatibilidade de mudanças legadas e do modo `--simple`.

## Aceite

- Mudança material não arquiva sem delta ou exceção justificada.
- Placeholder nunca conta como delta.
- Promoção inválida é visível e atômica do ponto de vista do archive.
- Testes legados continuam verdes.

## Segurança e consistência

- Validar slugs/capabilities pelos sanitizadores existentes.
- Não gerar requisito automaticamente a partir de prosa livre.
