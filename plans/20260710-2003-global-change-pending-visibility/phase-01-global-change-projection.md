# Fase 1 — projeção global no núcleo

## Visão geral

- Data: 2026-07-10
- Prioridade: P0
- Status: concluída em 2026-07-11
- Dependência: nenhuma

Criar em `change-core.mjs` uma projeção derivada de todas as changes abertas. Ela substitui leituras
isoladas do ponteiro nas superfícies de consulta, mas não altera comandos mutáveis.

## Requisitos

- Ler o slug atual com `activeChange(vaultBase)`.
- Varrer `listChanges(vaultBase).active` sem usar provider/session como filtro.
- Para cada change, retornar `slug`, `current`, `openTasks`, `doneCount`, `openCount` e `warning`.
- Manter change sem `tarefas.md` na projeção, com aviso.
- Ordenar atual primeiro; demais por slug.
- Calcular hash com ponteiro, slugs, tarefas e avisos de todas as changes.
- Renderizar todas as tarefas abertas sem truncamento silencioso.

## Arquitetura

Adicionar funções puras/semipuras em `hooks/change-core.mjs`:

- `allChangesState(vaultBase)` — leitura e normalização.
- `renderOpenChanges(state, options)` — texto comum para hooks/CLI, com envelope opcional.

`quickGateState`, `activeChange`, archive e comandos mutáveis permanecem inalterados.

## Arquivos

- Modificar `C:\GitHub\WendKeep\hooks\change-core.mjs`.
- Modificar `C:\GitHub\WendKeep\tests\change-core.test.mjs`.
- Modificar `C:\GitHub\WendKeep\tests\change-hooks.test.mjs` se helpers compartilhados exigirem fixture.

## Passos

1. Criar fixtures com A e B, tarefas concluídas e abertas.
2. Escrever testes de ordenação, contagens e ausência/erro de `tarefas.md`.
3. Implementar a projeção usando `listChanges`, `parseTasks` e `tasksHashOf`.
4. Escrever teste provando que tarefa de B altera o hash quando A é atual.
5. Escrever teste provando que trocar A→B altera apenas a marca/ordem, sem ocultar A.
6. Manter exportações antigas para compatibilidade interna.

## Aceite

- A e B sempre aparecem.
- Todos os IDs `[ ]` aparecem.
- Change atual é inequívoca.
- Estado inválido gera aviso, não desaparecimento.
- Gates existentes continuam lendo somente a atual.

## Riscos

- Saída extensa: requisito explícito do usuário; compactar formato, nunca omitir IDs.
- Corrida durante leitura: operar fail-open por change e produzir aviso local.
- Custo de I/O: uma leitura por `tarefas.md`; aceitável para hooks locais e número pequeno de changes.

## Segurança

- Não executar conteúdo das tarefas.
- Escapar/normalizar apenas para apresentação; slugs continuam derivados de diretórios existentes.

## Todo

- [ ] Testes vermelhos.
- [ ] Projeção global.
- [ ] Hash global.
- [ ] Testes focados verdes.
