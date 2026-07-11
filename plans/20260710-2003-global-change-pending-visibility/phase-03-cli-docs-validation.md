# Fase 3 — CLI, documentação e validação

## Visão geral

- Data: 2026-07-10
- Prioridade: P1
- Status: concluída em 2026-07-11
- Dependências: Fases 1 e 2

Expor a projeção global no CLI, atualizar orientação das skills/docs e validar o pacote sem publicar.

## Requisitos

- `change list`: todas as changes, atual primeiro, contagens e tarefas abertas; arquivadas separadas.
- `change status` sem slug: visão global.
- `change status <slug>`: detalhe individual existente.
- Comandos mutáveis sem slug continuam usando `CURRENT_CHANGE.md`.
- Skills explicam que uma change não pertence ao agente que a criou.
- Documentação descreve como assumir change existente e como usar `--change`.

## Arquivos

- Modificar `C:\GitHub\WendKeep\src\change.mjs`.
- Modificar `C:\GitHub\WendKeep\src\skills-seed.mjs`.
- Modificar `C:\GitHub\WendKeep\tests\change-cli.test.mjs`.
- Modificar `C:\GitHub\WendKeep\tests\skills-seed.test.mjs`.
- Modificar `C:\GitHub\WendKeep\README.md`.
- Modificar `C:\GitHub\WendKeep\README.pt-BR.md`.
- Modificar `C:\GitHub\WendKeep\CHANGELOG.md`.
- Modificar `C:\GitHub\WendKeep\package.json` se a release exigir incremento de versão.

## Passos

1. Testar `list`, `status` global e `status <slug>`.
2. Reusar o renderer/projeção do núcleo no CLI.
3. Preservar mensagens de erro para ausência de change explícita.
4. Atualizar `wk-workflow` PT/EN com ponteiro global, backlog global e takeover entre agentes.
5. Atualizar README PT/EN e changelog da próxima versão.
6. Rodar testes focados.
7. Rodar `npm.cmd test`, `npm.cmd run check` e `git diff --check`.
8. Smoke manual com A/B, alternância do ponteiro e dois `session_id`.
9. Executar `npm.cmd pack --dry-run`; não publicar.

## Aceite

- CLI e hooks apresentam os mesmos slugs, contagens e tarefas abertas.
- `status <slug>` não muda semanticamente.
- `done/verify/archive` continuam restritos à atual quando implícitos.
- Testes completos verdes e pacote válido.

## Riscos

- Scripts que parseiam texto de `change list`: não existe contrato JSON; documentar mudança humana.
- Versão: usar SemVer minor se a saída/feature for publicada; decidir durante execução conforme estado npm.

## Segurança

- Sem novas dependências, rede, autenticação ou execução dinâmica.
- `npm publish` permanece responsabilidade do usuário.

## Todo

- [ ] Testes CLI.
- [ ] CLI global.
- [ ] Skills e documentação.
- [ ] Versão/changelog.
- [ ] Suíte e pack dry-run.

## Questões não resolvidas

- Número exato da próxima versão deve ser confirmado contra a versão publicada no início da execução.
