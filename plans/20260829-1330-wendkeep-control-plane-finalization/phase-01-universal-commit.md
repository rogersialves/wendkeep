# Fase 01 — #40: commit universal baseado em evidências

## Visão geral

- **Branch:** `wk/universal-commit`
- **Prioridade:** alta; desbloqueia receipt final da #84
- **Estado:** pendente

Criar uma mensagem de commit reproduzível em hosts diferentes, baseada somente em prova permitida.

## Requisitos

- Entrada tipada: staged diff, identidade factual, ADR, tarefas e referências de evidência.
- Saída determinística e idempotente.
- Nenhum acesso irrestrito ao conteúdo privado do Vault.
- `prepare-commit-msg` estrutura; `commit-msg` valida.
- Amend, merge, squash e commits sem contexto não recebem conteúdo falso ou duplicado.
- CI detecta mensagens inválidas mesmo quando hooks locais foram ignorados.

## Arquitetura

```text
evidence refs + staged diff + identity
                ↓
        @wendkeep/commit kernel
          ↙                 ↘
prepare-commit-msg       commit-msg/CI
```

O kernel recebe dados já limitados e sanitizados. Ele não resolve autoridade por texto livre.

## Arquivos

### Criar

- `C:/GitHub/WendKeep/packages/commit/package.json` — workspace `@wendkeep/commit`.
- `C:/GitHub/WendKeep/packages/commit/src/index.mjs` — API pública.
- `C:/GitHub/WendKeep/packages/commit/src/commit-input.mjs` — normalização e schema.
- `C:/GitHub/WendKeep/packages/commit/src/commit-message.mjs` — render determinístico.
- `C:/GitHub/WendKeep/packages/commit/src/commit-policy.mjs` — validação/privacidade.
- `C:/GitHub/WendKeep/schema/commit-message-v1.schema.json` — contrato versionado.
- `C:/GitHub/WendKeep/.githooks/prepare-commit-msg` — wrapper portátil.
- `C:/GitHub/WendKeep/.githooks/commit-msg` — wrapper portátil.
- `C:/GitHub/WendKeep/scripts/validate-commit-range.mjs` — gate remoto.
- `C:/GitHub/WendKeep/tests/commit-message.test.mjs` — kernel e mutantes.
- `C:/GitHub/WendKeep/tests/git-commit-hooks.test.mjs` — Git real Windows/POSIX.
- `C:/GitHub/WendKeep/tests/commit-range-policy.test.mjs` — bypass/API/CI.
- `C:/GitHub/WendKeep/docs/pt-BR/commands/commit.md`.
- `C:/GitHub/WendKeep/docs/en/commands/commit.md`.

### Modificar

- `C:/GitHub/WendKeep/bin/wendkeep.mjs` — comando de preparação/validação.
- `C:/GitHub/WendKeep/packages/cli/src/index.mjs` — roteamento CLI.
- `C:/GitHub/WendKeep/src/init.mjs` — instalação opt-in de `core.hooksPath`.
- `C:/GitHub/WendKeep/src/doctor.mjs` — diagnóstico e recuperação dos hooks.
- `C:/GitHub/WendKeep/src/skills-seed.mjs` — skill `wk-commit` Codex/Claude.
- `C:/GitHub/WendKeep/.github/workflows/test.yml` — validação de commits do PR.
- `C:/GitHub/WendKeep/package.json` — workspace/export/check/files.
- `C:/GitHub/WendKeep/README.md` e `README.en.md` — resumo bilíngue.

## Passos

1. Escrever testes vermelhos do schema, determinismo, privacidade e autoridade.
2. Implementar normalização e render sem I/O.
3. Implementar policy validator e mutantes de prova ausente/falsa.
4. Criar wrappers Git e testes em repositórios temporários reais.
5. Integrar CLI, init, doctor e skill.
6. Adicionar gate de range de commits ao workflow.
7. Documentar instalação, diagnóstico e recuperação em PT-BR/EN.
8. Preparar candidato final, revisão e gates de integração.

## Testes focados

- `node --test tests/commit-message.test.mjs`
- `node --test tests/git-commit-hooks.test.mjs`
- `node --test tests/commit-range-policy.test.mjs`
- Testes existentes de envelope, provenance, skills, init e doctor afetados.

## Critérios de sucesso

- Codex e Claude produzem mensagem equivalente para a mesma entrada.
- Hooks rejeitam corpo/ADR/evidência inválidos sem vazar conteúdo privado.
- Gate remoto detecta bypass local.
- Hooks passam em Windows e POSIX.
- Docs PT-BR/EN e tarball contêm a nova superfície.

## Riscos e mitigação

- **Hook quebra commits comuns:** ativação opt-in e bypass documentado apenas para commits fora do contrato.
- **Leitura privada excessiva:** API recebe referências sanitizadas, não o Vault inteiro.
- **Diferença de shell:** lógica em Node; scripts de hook só delegam.
- **Mensagem instável:** ordenação canônica e snapshot tests sem timestamps voláteis.
