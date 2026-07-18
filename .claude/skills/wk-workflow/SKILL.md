---
name: wk-workflow
description: Use SEMPRE que o usuário pedir para implementar, criar, corrigir, refatorar, adicionar ou alterar código — qualquer tarefa de código não-trivial. Invoque ANTES de editar qualquer arquivo: orquestra o loop a2 (wendkeep change new → tarefas → verify → archive) e registra tudo no vault.
---
# Loop a2 — o ciclo de trabalho do wendkeep

Use ao começar qualquer mudança não-trivial. O loop mantém memória (vault) e prova
(sensores) juntas, tudo linkado no grafo do Obsidian.

<HARD-GATE>
NÃO edite arquivos de código antes do passo 2 (Propose / `wendkeep change new`).
Toda tarefa não-trivial passa pelo loop — planejar no chat e sair editando deixa o
vault cego. Exceção única: mudança trivial (typo, 1 linha).
</HARD-GATE>

## Os passos

1. **Explore** — entenda o problema antes de propor. Leia o código/contexto relevante.
2. **Propose** — `wendkeep change new <slug>`. Isso cria `08-Mudanças/<slug>/` com:
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
   move a change pro `_arquivo` e gera um ADR em `04-Decisões/`.

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
