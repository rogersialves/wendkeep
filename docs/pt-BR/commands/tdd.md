# Atestação TDD causal

**PT-BR** · [English](../../en/commands/tdd.md)

## Objetivo

`wendkeep tdd` registra uma prova auditável de que um teste ligado a tarefa e requisito foi
observado em RED e depois em GREEN no mesmo projeto, repositório, worktree, work session e change.
Ele complementa cobertura, mutação, sensores e revisão; não substitui nenhum deles.

## Quando usar

Use antes e depois de implementar comportamento testável ligado a uma tarefa `[tdd]`.

## Quando não usar

Não use para health checks, testes já verdes ou falhas de ambiente. Use sensores/doctor para
infraestrutura e um waiver humano apenas quando o comportamento realmente não for testável.

## Pré-requisitos

Change ativa, active context causal, tarefa com `[req:ID]`, teste relativo ao projeto e comando
determinístico que possa ser repetido em RED e GREEN.

## Sintaxe

```bash
wendkeep tdd red <task-id> --requirement <ID> --test <path> --command "<comando>" --session <id>
wendkeep tdd green <task-id> --command "<comando>" --session <id>
wendkeep tdd status <task-id> --session <id> [--json]
wendkeep tdd waive <task-id> --requirement <ID> --reason "<motivo>" --authority "<humano>" --session <id>
```

`--test` pode ser repetido. Todos os paths são relativos ao projeto. `--change <slug>`,
`--project <raiz>`, `--vault <cofre>` e `--json` seguem as convenções dos demais comandos.

## Contrato RED → GREEN

- RED válido é uma falha comportamental. Teste já verde, erro de sintaxe/import, módulo ausente,
  configuração inválida ou comando inexistente gera `invalid`.
- GREEN precisa manter a identidade causal e a branch do RED, executar com sucesso e observar
  uma mudança de produção posterior ao RED. GREEN de outra worktree, tarefa ou requisito não fecha.
- Mudança de path do teste fica em `review_flags`. Refactor ou commit depois do GREEN torna a prova
  stale até nova execução de `tdd green`; o GREEN anterior permanece em `green_history`.
- Waiver exige motivo e autoridade humana explícita. Não existe waiver silencioso.

O store `08-Mudanças/<slug>/tdd-attestations.json` guarda digests SHA-256, cauda sanitizada e
limitada a 2.000 caracteres e paths relativos — nunca a saída completa. O Evidence Envelope,
`verificacao.json`, handoff e Observer expõem a atestação e seu ID ao revisor.

## Gate por perfil

- `OFF` e `FLOW`: atestação opcional.
- `GUIDE`: recomendada para comportamento testável.
- `GOVERN`: obrigatória quando a tarefa possui `[tdd]`.
- `ASSURE`: obrigatória para tarefa executável com requisito ou sensor, salvo waiver explícito.

Marque a tarefa assim:

```markdown
- [ ] 1.1 persiste a preferência [req:UI-1] [sensor:tests] [tdd]
```

Atestação stale/invalid, mutante sobrevivente ou ausência de GREEN/waiver produz
`TASK_TDD_ATTESTATION_MISSING_OR_INVALID` no Task Contract e bloqueia Execute → Verify.

## Exemplos

```bash
wendkeep tdd red 1.1 --requirement UI-1 --test tests/ui.test.mjs --command "npm test" --session abc
wendkeep tdd green 1.1 --command "npm test" --session abc
wendkeep tdd status 1.1 --session abc --json
```

## Resultado esperado

Uma entrada causal em `tdd-attestations.json`, referenciada pelo Task Contract e pelas superfícies
de evidência, com estado atual e histórico de revalidação auditáveis.

## Opções e códigos de saída

- `0`: estado observado é válido (`red-observed`, `green-observed` ou `waived`; status verde/waived).
- `1`: observação executou, mas ficou `invalid`, RED ainda não chegou a GREEN ou status está stale.
- `2`: uso, contexto, identidade, store ou autoridade de waiver inválidos.

## Erros comuns e diagnóstico

- `TDD_RED_ALREADY_GREEN`: escreva primeiro o teste discriminante que falha.
- `TDD_RED_INFRASTRUCTURE_FAILURE`: corrija import, sintaxe, configuração ou comando e repita RED.
- `TDD_GREEN_STALE_AFTER_REFACTOR`: repita GREEN no checkout atual.
- `TDD_IMPLEMENTATION_NOT_AFTER_RED`: a prova não observou diff de produção posterior ao RED.

## Próximos passos

Rode [verify](verify.md), faça o passe independente e continue o
[ciclo de changes](changes-and-verification.md).
