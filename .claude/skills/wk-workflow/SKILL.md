---
name: wk-workflow
description: Use quando o usuário pedir para implementar, criar, corrigir, refatorar, adicionar ou alterar código: classifique e registre a rota temporária FLOW/GUIDE/GOVERN/ASSURE ANTES de editar, então siga o perfil efetivo. Keep Core permanece ativo; OFF nunca é automático.
---
# Perfis de Operação — roteador de trabalho do wendkeep

Use ao começar implementação, correção ou refatoração. **Keep Core permanece sempre ativo**
em todos os perfis: Vault, sessão, identidade, memória, lessons e persistência. Na ausência de
configuração válida, **GOVERN é o padrão** compatível.

## Seleção temporária por solicitação

Antes de editar, classifique a implementação atual e registre a escolha auditável com
`wendkeep profile route <FLOW|GUIDE|GOVERN|ASSURE> --session <id> --reason <texto>`.
A lease vale somente para a solicitação atual; ao encerrá-la, o perfil persistente da
sessão/projeto volta a valer. **OFF nunca é uma escolha automática da LLM**: somente uma pessoa
pode persistir `profile use OFF` explicitamente.

- **FLOW:** ajuste local, reversível e de escopo fechado, sem contrato/spec, segurança,
  dependência, CI/release ou policy.
- **GUIDE:** implementação compacta com change, sem spec/design/ADR automáticos quando contract_impact é none.
- **GOVERN:** escolha conservadora em caso de dúvida ou risco e para superfícies sensíveis.
- **ASSURE:** GOVERN quando confirmação explícita e handoff fazem parte do contrato.

Classifique também o work kind: inspection, maintenance, implementation, delivery ou recovery.
Risco operacional e impacto de contrato são independentes. Merge, push, tag e publish de código
já aprovado usam delivery + ASSURE sem criar outra change; registre com delivery start e conclua
com delivery finish para gerar receipt.

O harness da LLM faz essa classificação semântica; o Wend Runtime valida e aplica a lease.
Se não houver uma sessão causal identificada ou o comando falhar, não fabrique estado: use o
perfil efetivo já injetado e trate `GOVERN` como fallback conservador quando ele for o padrão.

<HARD-GATE>
Antes de editar, leia o **perfil efetivo** injetado pelo WendKeep e siga somente sua rota:
- `OFF`: não imponha processo Wend; a governança pertence ao **harness nativo da LLM**.
- `FLOW`: inicie o microcontrato com `wendkeep flow start` antes de editar os paths permitidos.
- `delivery`: inicie `wendkeep delivery start` antes das operações autorizadas; não crie change.
- `GUIDE`, `GOVERN` ou `ASSURE`: não edite código antes de Propose / `wendkeep change new`.
Este gate nunca transforma `OFF` ou `FLOW` silenciosamente em `GOVERN`.
</HARD-GATE>

## Rotas por perfil

- **OFF — LLM nativa:** Wend Runtime desligado; esta skill devolve a execução ao harness nativo.
- **FLOW — E → V:** `flow start` → implementar com wk-tdd → `flow finish`; sem change/ADR/verdict.
- **GUIDE — P → E → V:** change new --guide, sem design/spec/ADR automáticos quando não há impacto de contrato.
- **GOVERN — P → R → E → V:** loop a2 atual, com design/revisão; é o padrão conservador.
- **ASSURE — P → R → E → V → C:** GOVERN acrescido de confirmação e handoff explícitos.

## Passos para GUIDE, GOVERN e ASSURE

1. **Explore** — entenda o problema antes de propor. Leia o código/contexto relevante.
2. **Propose** — GUIDE usa `wendkeep change new <slug> --guide`; GOVERN/ASSURE usam
   `wendkeep change new <slug>`. O GUIDE compacto exige objetivo, critérios de aceite, áreas
   afetadas, testes e resultado. GOVERN/ASSURE criam `08-Mudanças/<slug>/` com:
   - `proposta.md` — *por quê* e *o que muda* (o WHAT).
   - `design.md` — a abordagem técnica.
   - `tarefas.md` — a lista de tarefas `- [ ] N.N descrição`.
   A mudança vira a *atual* (ponteiro global `.brain/CURRENT_CHANGE.md`). Podem existir
   várias changes abertas: hooks e `change list/status` mostram todas as pendências; comandos
   sem `--change` usam somente a atual.
   Antes de implementar, resolva `spec_impact` na proposta:
   - `required`: liste a capability em `specs:` e preencha
     `specs/<capability>/spec.md` com ADDED/MODIFIED/REMOVED; ligue tarefas com `[req:ID]`.
     Heading de requisito: `### Requisito: <ID> — <nome>` (ou só `### Requisito: <ID>`);
     o ID é a identidade (ex.: `GATE-1`, `API-AUTH-2`).
   - `none`: registre uma justificativa real em `spec_impact_reason`.
   `pending` nunca é estado pronto para implementação ou archive.
3. **Apply** — implemente cada tarefa de `tarefas.md` com disciplina **wk-tdd**
   (teste vermelho antes do código). Marque `- [x]` ao concluir. Declare nas tarefas:
   - `[sensor:<id>]` — a prova automatizada (roda no verify).
   - `[req:<ID>]` — o requisito do spec que a tarefa satisfaz (ex.: `[req:GATE-1]`),
      quando a change mexe numa capability. Uma tarefa pode declarar vários
      `[req:]` — todos contam na cobertura. Toda autoria de spec ocorre somente em
      `08-Mudanças/<slug>/specs/<capability>/spec.md`; `07-Specs` é gerado/read-only.
   Ex.: `- [ ] 2.1 valida CORE [req:MEM-1] [req:MEM-2] [sensor:memory-validation]`.
4. **Verify** — `wendkeep verify` roda os sensores → `evidencia.json`. Depois
   `wendkeep verify --deep` monta o *pacote de verificação* pro passe independente.
5. **Verify deep** — a skill **wk-verify** (passe fresco, autor≠verificador) lê o pacote,
   usa somente os requisitos autocontidos de `verificacao.json` e grava `verdict.json`. Change trivial (sem
   `[req:]`) recebe verdict automático — pula este passe.
6. **Archive** — `wendkeep change archive <slug>`. O *gate* exige sensores verdes **E**
   `verdict.json` cobrindo os `[req:]`. Passando, promove os deltas pro `07-Specs`,
   move a change pro `_arquivo`; GUIDE com contract_impact none não gera ADR automático.

## Regras

- Várias changes podem ficar abertas. `CURRENT_CHANGE.md` marca uma atual, sem esconder as
  outras pendências. Claude, Codex ou outro agente assumem uma change existente com
  `wendkeep change use <slug>` ou `--change <slug>` quando disponível.
- Se uma tarefa não precisa de prova automatizada, não declare sensor — o gate só exige
  o que você declarou. Sem `[sensor:]`, o archive não trava.
- A proposta linka a sessão de origem; a sessão linka a mudança ativa. É de propósito:
  o grafo do Obsidian mostra plano↔sessão↔decisão.
- Notas derivadas (bug/aprendizado) são numeradas (`BUG-NNNN-`/`APR-NNNN-`) e vivem na
  pasta do mês — nunca em subpasta `DIA N`. Crie via `wendkeep note new --type
  bug|learning "título"` (imprime o path), não à mão.
