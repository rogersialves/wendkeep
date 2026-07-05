# 02 — Estudo de Nome e Disponibilidade

**Objetivo:** escolher um nome para o projeto que seja registrável e defensável — livre nos registros que importam (npm, PyPI, registro de plugins do Obsidian, GitHub) e **sem colisão com produto concorrente** no mesmo espaço.

---

## Resultado: `wend`

Palavra real do inglês (arcaica/literária): percorrer ou seguir um caminho, geralmente de modo lento ou por rota indireta. Sobrevive na expressão *"to wend one's way"*. Detalhe de marca: o passado de *"to go"* em inglês — *"went"* — vem historicamente de *"wend"*. Para uma ferramenta que registra o caminho já percorrido nas suas sessões, a etimologia carrega a ideia de "o percurso trilhado". **Não é sigla** — e não deve virar uma; a palavra real é marca mais forte que qualquer backronym.

**Disponibilidade:**
- npm `wend`: **livre** ✅ (artefato principal — o plugin/CLI)
- npm escopo `@usuario/wend`: livre ✅
- Registro de plugins do Obsidian: **livre** ✅
- PyPI `wend`: tomado (micro-lib "templated paths using t-strings", 2 releases, fev/2026 — domínio alheio, risco de confusão ~zero)
- **Solução PyPI:** usar `wend-sessions` (livre) — marca e import seguem `wend`. PyPI não tem escopos, então a convenção universal é nome de distribuição distinto + marca intacta (ex.: "discord.py").

---

## A descoberta que orientou tudo

Três rodadas de verificação revelaram o insight central: **o espaço de "memória de sessão para agentes de IA" está em corrida de nomes em 2026.** Toda palavra descritiva (thread, memory, context, recall, log, keep) está tomada — repetidamente por produtos que já enviam código ou pacotes ativos.

A verificação de registro sozinha **não basta**: um nome pode estar livre no npm/PyPI/Obsidian e mesmo assim colidir com um produto concorrente vivo. Foi assim que `threadkeep` foi reprovado.

---

## Candidatos avaliados e por que caíram

| Nome | Resultado | Motivo da rejeição |
|---|---|---|
| **Engram** | ❌ | npm dormente tomado; PyPI placeholder; 3 plugins Obsidian já usam; **dois repos GitHub de ~4,7k e ~4,5k estrelas com a MESMA tese** ("persistent memory for AI coding agents"). Suicídio de marca. |
| **Memex** | ❌ | Produto de PKM consolidado (WorldBrain Memex, ~4,7k ⭐) na mesma categoria; npm e plugin Obsidian tomados. Parece derivativo. |
| **Cortext** | ⚠️ | Limpo no Obsidian, mas npm **ativo** com "Metacognition for your Claude Code prompts" (mai/2026). Colisão direta no domínio. |
| **threadkeep** | ❌ | Registros livres, MAS existe **ThreadKeeper** (produto vivo, quase o mesmo conceito, foco Windows) — nome a um caractere. Toda a família "thread-*" tomada por produtos vivos. |
| **glyphvault** | Plano B | Limpo nos três registros, mas "glyph" é morfema lotado e **"vault" colide com o termo do próprio Obsidian** (vault = pasta de notas). |
| **wend** | ✅ | Livre no npm + Obsidian; sem produto homônimo no espaço (só "Wendy/WendyOS", nome e propósito diferentes); sem choque de vocabulário. PyPI resolvido com sufixo. |

Outros testados e descartados por colisão de registro ou produto: throughline (npm = ferramenta de context compression do Claude Code), recallr (npm = "memory for every message"), hippocamp (PyPI = "memory for AI agents"), mnemo/mnemonix/quire/marl/folio/glean/cairn/trove/palimpsest/marginalia/lodestar.

---

## Concorrentes "thread-*" descobertos no processo

- **ThreadKeeper** (thethread-keeper.com): grava a sessão de trabalho inteira com um toque e restaura; armazenamento local (Windows, JSON); resumos por IA via Gemini/Ollama. Foco Windows. Quase o conceito do wend, porém genérico (snapshot de desktop).
- **Threadlog** (threadlog.dev): SaaS pago; suporta Claude Code, Codex; busca por projeto, filtro por fonte, rastreio de uso/custo/tokens. Faixa ~US$7 individual.
- **Threadbase** (threadbase.dev): observabilidade de memória de agente.

Detalhe em `03-analise-concorrentes.md`.

---

## Framework para validar qualquer nome futuro (na ordem que importa)

1. Nome livre no **npm** (artefato principal).
2. `id` livre no **registro de plugins do Obsidian**.
3. **Web-search por produto homônimo no seu espaço** — o filtro que reprovou o threadkeep e que os registros sozinhos não pegam.
4. Um **domínio utilizável** em qualquer TLD (`.com` é irrelevante para plugin de dev).
5. PyPI e nome-exato-no-GitHub: desejáveis, não decisivos.

---

## Cheques manuais ainda pendentes para `wend`

- **Domínio:** "wend" é palavra real, então `.com` está fora; verificar `.dev`/`.sh`/`.tools`/`.app` num registrador.
- **Marca:** buscar "wend" no INPI (BR) e USPTO antes de comercializar. Risco baixo ("Wendy" é nome e classe diferentes).
