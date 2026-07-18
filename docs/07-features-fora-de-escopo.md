# 07 — Features Fora de Escopo (e o motivo)

Tudo que foi conscientemente **descartado** ou **adiado**. Diferença importante: *descartado* = não faz parte da visão; *adiado* = faz parte, mas atrás de um gate (ver `05-roadmap.md`).

---

## Features adiadas (na visão, atrás de gate)

| Feature | Status | Motivo / Gate |
|---|---|---|
| Import de exports do ChatGPT/Claude web (estilo Nexus) | Adiada — ainda grátis | Mantém o MVP enxuto; entra depois no núcleo local grátis. |
| Dashboard de custo/tokens | Adiada — Fase 1 | Cobrável e aditivo ao dashboard cloud; só após sync ter pagantes reais. |
| Memória/busca compartilhada em equipe | Adiada — Fase 2 | Produto diferente do solo; só após solos amarem + inbound de times. |
| Observabilidade (por que o agente esqueceu/errou) | Adiada — Fase 3 | Problema mais difícil dos três concorrentes; só com base de equipe pagante. |
| Suporte a outros agentes (Codex, Gemini, etc.) | Codex: **entregue** (import 0.17.0; hooks de sessão via `.codex/hooks.json` no `init`, 0.46.0 — ver `17-agent-agnostic.md`). Demais: adiada | Foco do MVP era Claude Code; Codex validou primeiro. Gemini/outros só quando houver demanda. |

---

## Features descartadas (fora da visão)

| Feature | Motivo da rejeição |
|---|---|
| Captura de snapshot de desktop (apps/abas/clipboard, estilo ThreadKeeper) | Genérico, não semântico de agente. Dilui o foco e não toca o fosso (Obsidian + sessão de agente). |
| Backend cloud pesado já na Fase 0 | Contradiz local-first e atrasa o MVP. Sync deve começar o mais leve possível. |
| RAG/IA na nuvem no núcleo grátis | Núcleo grátis deve ser 100% local (privacidade + fosso). Cloud/IA paga fica no tier pago. |

---

## Abordagens de escopo rejeitadas

| Abordagem | Motivo da rejeição |
|---|---|
| "Construir todas as 4 features de monetização" | Não é estratégia, é ausência de escolha. Cada feature é um produto; solo, em noites/fins de semana, entrega zero fazendo as quatro. Faz **uma** (sync), bem. |
| "Mirar solo e time desde o início" | Solo e time são produtos diferentes disfarçados de um. Dilui a UX e não encanta nenhum. Solo primeiro; time como upsell. |
| "Um único plugin" | O produto atravessa dois runtimes (Claude Code + Obsidian). É suíte de marca única, não um plugin. |
| "Roadmap com datas" | Datas sem gates = "todas as opções" adiada. Gates por evidência. |
| "Copiar features/código dos concorrentes" | Conceitos são livres; código/UI/identidade não. Reimplementar do zero; diferenciar marca. |

---

## Nomes rejeitados (resumo)

Engram, Memex, Cortext, threadkeep, glyphvault — e ~12 outros coinages testados. Cada um caiu por colisão de registro **ou** colisão com produto concorrente no espaço. Detalhe completo em `02-pesquisa-nome-disponibilidade.md`.

---

## Por que registrar o que ficou de fora

Features descartadas tendem a voltar — disfarçadas de "ideia nova" — e custar fins de semana. Este arquivo existe para que, quando a tentação voltar, a resposta já esteja escrita: ou está adiada atrás de um gate, ou foi descartada por um motivo que não mudou.
