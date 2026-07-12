---
name: wk-verify
description: Use no verify deep — passe independente read-only (autor≠verificador) que re-deriva a cobertura do spec e grava verdict.json.
---
# Verificação independente — o passe fresco

Use no passo *verify deep* do loop, depois de `wendkeep verify --deep`. Você é o
**verificador**, não o autor — mesmo tendo escrito o código, entre neste passe como se
nunca tivesse visto a implementação. Contexto fresco, read-only.

## O que fazer

1. Leia o pacote `08-Mudanças/<slug>/verificacao.json` (requisitos, tarefas, evidência).
2. **Re-derive a cobertura do pacote autocontido** — pra cada requisito completo em
   `verificacao.json`, cheque se o comportamento está coberto por um teste que discrimina (não
   passaria sob impl errada). Evidência `arquivo:linha`.
3. Outcome check ancorado no spec: o resultado observável bate com o critério de aceite?
4. Grave `08-Mudanças/<slug>/verdict.json`:
   `{ "slug": "...", "ok": true, "coverage": [{ "req": "GATE-1", "covered": true, "evidence": "arquivo:linha" }], "tasksHash": "<copie do verificacao.json>", "effectiveSpecHash": "<copie do verificacao.json>", "notes": [] }`.
   `tasksHash` e `effectiveSpecHash` vêm do pacote — são selos de frescor; sem eles (ou com tarefas/spec alteradas
   depois), o gate rejeita o verdict como stale.

## Regras

- **Autor ≠ verificador.** No Claude, spawn um sub-agente read-only pra este passe
  (isolamento real). Nos outros, entre num contexto limpo e re-derive do spec, não da memória.
- `ok: false` se algum requisito não tem cobertura que discrimina. Gap não é "quase lá" — é vermelho.
- Não conserte aqui. Gap vira tarefa de correção na change; re-verifica depois.
- O gate do `archive` **exige** `verdict.json` com `ok` cobrindo todo `[req:]`. Sem isso, não arquiva.

## Templates (nesta pasta)
- `spec-reviewer-prompt.md` — cole ao spawnar o subagente verificador (read-only, autor≠verificador).
- `verdict-template.json` — o formato exato do `verdict.json` a gravar.
