# 05 — Roadmap (destravado por evidência, não por data)

**Regra central:** cada fase só começa quando o **gate** da anterior é verdade. Roadmap com prazos e sem gates = "todas as opções" adiada — o mesmo monstro fatiado no calendário. O roadmap é uma sequência de **apostas**, cada uma destravada pela validação da anterior.

> **Estado real (2026-06-29):** o núcleo das Fases 0 e 1 já está construído e em uso diário — como os hooks do NutriGym-Vision (ver `08-estado-implementacao.md`). Os marcadores **Status** abaixo refletem isso. O gate de SHIP da Fase 0 está, na prática, atendido; o que falta não é construir, é **produtizar + validar n=2**.

---

## Fase 0 — MVP (ponto de partida)

**Status (2026-06-29):** ✅ Núcleo construído e em produção (multi-agente, testado) — *exceto* busca semântica por embeddings (hoje *keyword scoring*) e sync E2E (não construído). Gate de SHIP praticamente atendido por uso próprio. Ver `08`.

**Escopo:**
- Núcleo local grátis: captura automática de sessões do Claude Code → Markdown na vault + busca semântica local + grafo do Obsidian.
- Tier pago v1: sync de sessões entre as máquinas do *mesmo usuário* (E2E).

**Gate para SHIP (lançar publicamente):**
- wend funciona para **você** (usuário-zero) atravessando suas máquinas, em **uso diário, por 2–4 semanas, sem quebrar**.

**Como é o sucesso:** você para de perder contexto entre máquinas e usa wend sem pensar. Se você mesmo não usa diariamente, ninguém vai.

**Notas técnicas:** ver riscos do JSONL e `cleanupPeriodDays` em `06`/`01`. Sync sem servidor pesado — avaliar E2E sobre armazenamento simples antes de construir backend próprio.

---

## Fase 1 — Dashboard de custo/tokens

**Status (2026-06-29):** ✅ Construído (`token-usage.mjs`) — multi-provedor, pricing com cache, histórico. Tratado aqui como futuro, mas já existe. A questão deixa de ser "construir" e passa a ser **expor como produto + cobrar**. Candidato a wedge pago de lançamento (ver `D8` revisada em `06`).

**Escopo:** custo e tokens por agente e por projeto, no dashboard cloud.

**Gate para começar:** sync com **usuários pagantes ativos reais** (não só você) **OU** demanda repetida e explícita por isso.

**Por quê aqui:** é cobrável e **aditivo** ao dashboard cloud uma vez que ele exista. Não é ponto de partida — é expansão natural do que o tier pago já entrega.

**Como é o sucesso:** usuários conseguem responder "quanto cada agente/projeto me custou" sem planilha.

---

## Fase 2 — Memória/busca compartilhada (equipe)

**Escopo:** multi-tenant, permissões, busca/memória entre máquinas de pessoas diferentes.

**Gate para começar:** solos **amam** a ferramenta (retenção real medida) **+** pedidos *inbound* de times.

**Por quê aqui:** time é solo levado adiante — "sync entre máquinas de pessoas + permissões". Construir antes de solos amarem dilui a UX (solo quer fricção zero/local; time quer admin/billing/SSO) e não encanta nenhum. Modelo Linear/Raycast/Obsidian: amor individual → time como upsell.

**Como é o sucesso:** times pagam e convidam colegas; expansão de receita vem de seats, não de aquisição fria.

---

## Fase 3 — Observabilidade de memória

**Escopo:** por que o agente esqueceu/errou; versionar memória; debugar evolução de contexto.

**Gate para começar:** tier de equipe **estável e pagante**.

**Por quê por último:** é o problema mais difícil (terreno do Threadbase) e só se paga com base pagante consolidada. Sem isso, é pesquisa cara sem retorno.

---

## Tabela-resumo

| Fase | Entrega | Gate | Lado da fronteira | Status real (2026-06-29) |
|---|---|---|---|---|
| 0 | Núcleo local grátis + sync individual | (partida) / ship após 2–4 sem de uso próprio | grátis + pago | Núcleo ✅ · embeddings ⚠️ · sync ❌ |
| 1 | Dashboard custo/tokens | pagantes ativos reais ou demanda repetida | pago | ✅ construído |
| 2 | Memória de equipe | solos amam + inbound de times | pago | ❌ não iniciado |
| 3 | Observabilidade | tier de equipe estável e pagante | pago | ❌ não iniciado |

**Regra de ouro:** nunca inicie uma fase antes do gate. *Nota (2026-06-29): as Fases 0 e 1 foram, na prática, construídas adiantadas — emergiram do dogfooding no NutriGym, não de um gate formal. Isso não invalida a regra para as Fases 2–3; muda o tabuleiro: o gate aberto agora é de **mercado** (n=2 / pagantes), não técnico.*
