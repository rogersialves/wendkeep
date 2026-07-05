# 03 — Análise de Concorrentes

**Princípio:** os concorrentes são **mapa de requisitos do mercado**, não gabarito de cópia. Funcionalidade e ideia não são protegidas — você pode reimplementar qualquer conceito (captura de sessão, resumo por IA, busca por projeto). O que não pode: copiar código, copiar texto de UI, ou imitar nome/identidade a ponto de confundir. Regra prática: **reimplemente do zero, nunca olhe o código deles, diferencie a marca.**

---

## Os três diretos

### ThreadKeeper — o gancho de adoção
- **O que faz:** grava a sessão de trabalho inteira com um toque de tecla e restaura a qualquer momento. Armazenamento local apenas (Windows: `%APPDATA%\ThreadKeeper`, em JSON). Resumos por IA via Gemini ou Ollama.
- **Limite:** é genérico — captura snapshot de desktop (apps, abas, clipboard), não é semântico de agente de código.
- **O que ensina ao wend:** o *gancho de instalação* é captura + restauração de contexto com baixo atrito ("o porquê instalo hoje").
- **Ângulo do wend:** captura **semântica de sessão de agente** (Claude Code/Codex), não snapshot de desktop. Mais profundo onde o dev se importa.

### Threadlog — o modelo de receita
- **O que faz:** SaaS pago. Suporta a maioria dos agentes de código (Claude Code, Codex). Busca por projeto, filtro por fonte, rastreio de uso/custo/tokens. Time com permissões.
- **Preço:** faixa Free → ~US$7 individual → ~US$25 time (por usuário/armazenamento).
- **O que ensina ao wend:** o *modelo de monetização* (open/free → individual → time) e a feature **cobrável** de custo/tokens — devs querem saber quanto cada agente queimou. Cobra porque é **hospedado**.
- **Ângulo do wend:** essa é a camada paga (cloud). Custo/tokens é Fase 1 do roadmap. *(Atualização 2026-06-29: custo/tokens já está construído no NutriGym (`token-usage.mjs`) e é candidato a wedge pago de **lançamento**, não de Fase 1 — exatamente a feature que o Threadlog cobra. Ver `08` e `D8` revisada em `06`.)*

### Threadbase — a fronteira premium
- **O que faz:** observabilidade de memória de agente — visibilidade do que o agente lembra, como a memória evolui, por que falha; versionar e debugar.
- **O que ensina ao wend:** a *fronteira avançada*. Problema difícil e ainda pouco resolvido.
- **Ângulo do wend:** futuro (Fase 3), não MVP.

---

## Cenário mais amplo (referência)

- Família "thread-*" ocupando o espaço de sessão de agente: ThreadKeeper, Threadlog, Threadbase, thread.dev (notebook Jupyter com IA).
- Agentes de código de grande porte (não concorrentes diretos de *memória*, mas o ecossistema): Claude Code, Codex, Cursor, Devin, Kiro, Coder, Goose, Aider, OpenHands.
- Ferramentas de orquestração multi-sessão (Shep, Bernstein, GreatCTO) que também tocam "preservar contexto" entre agentes.

---

## Onde está o fosso do wend

Nenhum dos três entrega memória de sessão de agente **nativamente integrada ao grafo do Obsidian, local-first**:
- ThreadKeeper: local, mas snapshot genérico de desktop, não Obsidian.
- Threadlog: específico de agente, mas **hospedado** (não local, não Obsidian).
- Threadbase: observabilidade, outro problema.

O wend ocupa a interseção vazia: **captura semântica de sessão de agente + entrega no Obsidian + local-first**. É por isso que não compete por paridade de features — compete por essa posição.

---

## Nota jurídica (para um SaaS rentável)

- **Livre para reimplementar:** conceitos e funcionalidades (captura, resumo por IA, busca, dashboard de custo).
- **Proibido:** copiar código-fonte, copiar literalmente texto de interface, imitar identidade visual ou nome a ponto de gerar confusão.
- A marca "wend" já afasta do "ThreadKeeper". Mantenha UI e copy próprias.
- Não é aconselhamento jurídico; para comercialização, valide marca (INPI/USPTO) e licenças das libs usadas.
