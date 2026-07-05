# 01 — Estudo: Obsidian vs. Ferramentas de PKM "AI-Native"

**Pergunta de pesquisa:** existe um app de PKM (separado do ambiente de código, como o Obsidian) que, para o caso de uso de capturar e indexar sessões de LLM em Markdown editável pelo Claude Code, ranqueie melhor que o Obsidian?

**Critérios (na ordem de prioridade do usuário):**
1. Integração com IA/LLMs.
2. Editável pelo agente Claude Code (arquivos locais em texto plano).
3. Grafo de conhecimento.
4. **Captura/indexação automática de sessões de LLM** (requisito crítico e diferenciador).

---

## Veredito

**Nenhuma ferramenta supera o Obsidian para este caso de uso.** É o único app dedicado que combina, ao mesmo tempo: Markdown em texto plano local (que o Claude Code lê e escreve direto), integração de IA madura via plugins, grafo nativo, e um ecossistema de pipelines que captura sessões de LLM. Os concorrentes "AI-native" perdem em pelo menos um critério crítico — quase sempre o armazenamento aberto editável pelo agente.

**Verdade desconfortável sobre o critério #4:** nenhuma ferramenta de PKM captura sessões de LLM de forma nativa e turnkey — **nem o Obsidian**. A captura automática é sempre um pipeline montado por você (hooks do Claude Code + script + indexador). A vantagem do Obsidian é que esse pipeline é nativamente construído sobre Markdown, então é mais fácil de montar nele do que em qualquer app de banco fechado, onde é impossível.

**Atenção:** a ferramenta que parecia mais alinhada (Reor) está **descontinuada** — repositório arquivado em março/2026.

---

## Por que o Obsidian vence

1. **É o denominador comum de todos os pipelines de IA.** As ferramentas que a comunidade construiu em 2025–2026 para dar memória ao Claude Code (QMD, qmd-sessions, memsearch) escrevem Markdown puro em disco — o formato do Obsidian. Ele é a camada de visualização/grafo sobre um padrão que o ecossistema já adotou.
2. **Armazenamento aberto elimina a maioria dos concorrentes.** Tana e Mem são cloud-only com banco proprietário; Capacities é object-based na nuvem; NotebookLM processa tudo nos servidores do Google; Anytype guarda objetos criptografados. Nenhum permite o Claude Code editar as notas como texto.

---

## Avaliação por ferramenta

| Ferramenta | Armazenamento | IA | Grafo | Captura de sessão | Veredito |
|---|---|---|---|---|---|
| **Obsidian** | Markdown local ✅ | Plugins maduros (Smart Connections, Copilot) | Nativo ✅ | Via pipeline (melhor opção) | **Baseline vencedor** |
| **Reor** | Markdown local ✅ | RAG nativo local | Notas relacionadas | Nunca capturou sessões externas | ❌ Descontinuado (mar/2026) |
| **Khoj** | Indexa Markdown | Busca semântica + chat (local/cloud) | Não | Não nativamente | ✅ Melhor *complemento*, não substituto |
| **Logseq** | Markdown/org local ✅ | Plugins imaturos | Nativo ✅ | Não | Obsidian com IA pior |
| **SiYuan** | Markdown local ✅ | OpenAI embutida (básica) | Sim | Não | Editável, mas IA fraca |
| **Trilium** | SQLite (não MD puro) | Fraca | Sim | Não | Difícil para o Claude Code |
| **AppFlowy** | Blocos/banco | Modelos locais | — | Não | Workspace, não PKM-grafo |
| **Anytype** | Objetos criptografados | API local | Sim | Não | Falha no critério #2 |
| **Tana** | Cloud-only ❌ | AI-native real | Sim | Parcial (reuniões) | Falha no #2 e privacidade |
| **Capacities** | Cloud | Chat com modelo de dados | — | Não | Falha no #2 |
| **Mem.ai** | Cloud | AI-native | — | Não | Falha no #2 |
| **NotebookLM** | Cloud (Google) | RAG excelente | Não | Não | Ferramenta de consulta, não second brain editável |

---

## A questão crítica: captura automática de sessões de LLM

Duas categorias de solução, ambas mais fáceis (ou exclusivamente possíveis) sobre Markdown:

**(a) Import de exports (semi-manual):**
- **Nexus AI Chat Importer** (plugin Obsidian): importa exports de ChatGPT, Claude, Mistral, Perplexity para Markdown organizado, com modo CLI. Depende do export manual do provedor.

**(b) Captura automática de sessões do Claude Code (a mais relevante):**
O Claude Code grava cada sessão como JSONL em `~/.claude/projects/<projeto>/<session>.jsonl`. Sobre isso a comunidade montou captura automática:
- **Hooks (`Stop` / `PreCompact`)**: disparam um script ao fim de cada sessão que resume e grava Markdown na vault.
- **QMD**: motor de busca on-device que indexa Markdown com BM25 + busca vetorial + reranking por LLM, tudo local; expõe-se como servidor MCP.
- **qmd-sessions**: converte os JSONL em Markdown limpo e indexa com QMD, com hook `PreCompact` para não perder nada.
- **memsearch**: ao fim da sessão escreve resumo e injeta contexto relevante na próxima.

**Pipeline recomendado (e que é o fosso do wend):**
`Claude Code (hooks) → script → Markdown na vault → índice semântico (QMD/Smart Connections) → grafo do Obsidian`

Nenhum app AI-native dedicado (Tana, Mem, Capacities, NotebookLM) ingere os JSONL do Claude Code automaticamente, porque não vivem no filesystem aberto.

---

## Recomendação prática (stack)

1. **Base:** Obsidian + Smart Connections (embeddings locais) + opcional Copilot (chat-RAG, BYOK/Ollama).
2. **Ponte com Claude Code:** Local REST API + servidor MCP para ler/escrever a vault.
3. **Captura automática:** hook `Stop`/`PreCompact` gravando Markdown; indexar com QMD/qmd-sessions.
4. **Import web:** Nexus AI Chat Importer.
5. **Opcional:** Khoj self-hosted sobre a mesma pasta para busca/agente.

---

## Ressalvas

- "Captura automática" exige setup inicial (estimado 1–2 h); depois roda sozinho.
- O **JSONL do Claude Code é interno e muda entre versões** — parsing direto pode quebrar; preferir `/export` ou camadas que absorvam o risco.
- Embeddings locais consomem CPU/RAM.
- RAG na nuvem envia trechos das notas ao provedor — para dados sensíveis, manter caminho 100% local.
- Vários "rankings de melhores second brains" online têm viés comercial; tratados como sinal de mercado, não avaliação neutra.

---

## Fontes principais consultadas

- Documentação do Claude Code — gestão de sessões: https://code.claude.com/docs/en/sessions
- QMD (qmd-sessions, memória do Claude Code): https://www.williambelk.com/blog/qmd-sessions-claude-code-memory-with-qmd-20260303/
- Arquitetura Obsidian + hooks do Claude Code: https://www.mindstudio.ai/blog/self-evolving-claude-code-memory-obsidian-hooks
- Por que setups de Claude Code perdem contexto (arquitetura Obsidian): https://kisztof.medium.com/why-your-claude-code-setup-loses-context-every-session-and-the-obsidian-architecture-that-fixes-it-2f32b0700531
- Time travel debugging com o histórico do Claude Code: https://towardsai.com/p/machine-learning/time-travel-debugging-with-claude-codes-conversation-history
- Alternativas open-source/self-hosted ao Notion: https://www.opensourcealternatives.to/alternative-to/notion ; https://vps.us/blog/self-hosted-alternatives-to-notion/
- Review do Tana (cloud-only): https://aiproductivity.ai/tools/tana/

*Datas e versões verificadas em junho/2026. O ecossistema muda rápido; reconfirme antes de adotar.*
