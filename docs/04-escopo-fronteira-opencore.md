# 04 — Escopo e Fronteira Open-Core

> **Para que serve:** impedir dispersão. Se uma ideia não respeita a fronteira ou não destrava um gate (ver `05-roadmap.md`), ela não entra agora.

---

## Tese do produto (o fosso)

wend captura automaticamente as sessões do Claude Code (e, depois, outros agentes) como **Markdown local**, indexadas semanticamente e renderizadas no **grafo do Obsidian**. O estudo confirmou: **nenhum concorrente faz isso nativamente integrado ao Obsidian.** O fosso não é a captura em si — é a captura entregue dentro do segundo cérebro que o dev já usa.

---

## A regra de fronteira (a linha que impede dispersão)

> **Uma máquina = grátis, local, open-source.**
> **Atravessa máquinas ou pessoas = pago, cloud.**

Por quê: local-first com Markdown aberto é **difícil de monetizar diretamente** (o usuário roda tudo na máquina dele, sem servidor seu). O dinheiro só mora onde há infraestrutura sua — **sincronizar, agregar, compartilhar** — e isso atravessa fronteiras de máquina ou pessoa.

Duas consequências inegociáveis:
1. O núcleo grátis nunca é capado para forçar upgrade — tem que ser o melhor da categoria *sozinho*.
2. O tier pago nunca canibaliza o grátis. Funciona perfeitamente numa máquina só? É grátis.

---

## Núcleo grátis (open-source, local) — a isca de adoção

Fricção zero, sem conta, sem servidor.
- Captura automática de sessões do **Claude Code** via hooks (`Stop` / `PreCompact`) → Markdown na vault.
- **Busca semântica local** sobre as sessões (embeddings on-device, estilo QMD/Smart Connections). ⚠️ *Estado real (2026-06-29): hoje o NutriGym faz scoring por palavra-chave sobre índice de frontmatter, **não** embeddings. Embeddings on-device seguem como promessa a cumprir — ver `08`.*
- Renderização nativa no **grafo do Obsidian** (plugin): backlinks, conexões, navegação.
- 100% local — argumento de privacidade e coração do fosso.

Fora do MVP grátis (entra depois, ainda grátis): import de exports do ChatGPT/Claude web (estilo Nexus).

---

## Tier pago v1 — a aposta: SYNC

Única feature paga do lançamento: **sincronização de sessões/notas entre as máquinas do mesmo usuário**, criptografada ponta-a-ponta.

Por que esta, e não as outras três: é a **sua dor real** (múltiplas máquinas), a **fronteira open-core mais limpa**, o **degrau técnico mais baixo**, e **vira "equipe" naturalmente** depois (time = sync entre pessoas + permissões).

Preço (placeholder): grátis local / individual pago com sync. Âncora de mercado: ~US$7 (Threadlog) — referência, não cópia.

> **Estado real (2026-06-29):** custo/tokens (listado como Fase 1 em `05`) já está **construído e testado** no NutriGym (`token-usage.mjs`); sync tem **zero código**. A evidência sugere que o wedge pago de lançamento seja **custo/tokens, não sync** — feature que o público improvisa sozinho (D7). Ver `D8` revisada (`06`) e `08`.

---

## Resumo de uma linha

Núcleo local grátis que captura sessões de agente no Obsidian melhor que qualquer concorrente; cobra-se por atravessar a fronteira da máquina (sync), expandindo para custo/tokens, equipe e observabilidade — cada um atrás de um gate.
