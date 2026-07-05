# 06 — Log de Decisões e Justificativas

Estilo ADR (Architecture Decision Record). Cada decisão: contexto, decisão, alternativas consideradas, justificativa, risco/trade-off.

---

## D1 — Construir sobre o Obsidian (não sobre outro PKM nem do zero)

- **Contexto:** buscava-se o melhor app de PKM para capturar sessões de LLM em Markdown editável pelo Claude Code, com grafo.
- **Decisão:** Obsidian como base.
- **Alternativas:** Reor (RAG nativo), Logseq, SiYuan, Khoj, Tana, Mem, NotebookLM, Anytype, Capacities, Trilium, AppFlowy.
- **Justificativa:** único app que combina Markdown local editável pelo agente + IA madura via plugins + grafo nativo + ecossistema de captura de sessão. É o denominador comum de todos os pipelines de memória do Claude Code.
- **Risco:** dependência do ciclo de vida do Obsidian e do formato JSONL do Claude Code. Mitigação: Markdown é portável; isolar o parsing de JSONL.

## D2 — É uma suíte, não "um único plugin"

- **Contexto:** desejo inicial de "um único plugin".
- **Decisão:** produto atravessa dois runtimes — captura no lado do Claude Code (hooks, parse de JSONL, indexador via MCP) e visualização/grafo no Obsidian.
- **Justificativa:** um plugin do Obsidian roda em Electron isolado e não instala hooks do Claude Code; uma skill do Claude Code não desenha grafo. Marca única, artefatos distintos.
- **Risco:** mais superfícies para manter. Mitigação: núcleo enxuto na Fase 0.

## D3 — Diferencial = turnkey + integração nativa ao Obsidian

- **Decisão:** o valor é eliminar o setup manual (1–2 h) e entregar a memória de sessão dentro do grafo do Obsidian.
- **Justificativa:** as peças existem fragmentadas (qmd-sessions, memsearch, Nexus). O fosso é a integração turnkey no Obsidian, que nenhum concorrente faz.
- **Risco:** fosso copiável por incumbente. Mitigação: velocidade + comunidade + foco local-first.

## D4 — Nome = wend

- **Contexto:** corrida de nomes no espaço de memória de agente.
- **Decisão:** wend.
- **Alternativas e rejeições:** Engram (2 repos de ~4,7k⭐ com a mesma tese), Memex (PKM consolidado), Cortext (npm ativo "metacognition for Claude Code"), threadkeep (produto vivo ThreadKeeper), glyphvault (choque com "vault" do Obsidian). Detalhe em `02`.
- **Justificativa:** livre no npm + Obsidian, sem produto homônimo no espaço, sem choque de vocabulário; etimologia ("went" vem de "wend") dá história de marca.
- **Risco:** PyPI bare tomado e domínio `.com` indisponível. Mitigação: D5 e TLD alternativo.

## D5 — PyPI bare-name tomado não é bloqueio

- **Decisão:** publicar pacote Python como `wend-sessions`; marca e import seguem `wend`.
- **Justificativa:** PyPI ocupado só impede o nome de distribuição exato; o artefato principal (npm/plugin Obsidian) está livre. Convenção universal (ex.: "discord.py"). O pacote PyPI atual é micro-lib alheia, confusão ~zero.
- **Risco:** mínima inconsistência de nome no ecossistema Python. Aceitável.

## D6 — Modelo open-core

- **Decisão:** núcleo open-source local grátis + tier cloud pago.
- **Alternativas:** tudo pago; tudo grátis; cloud-only.
- **Justificativa:** adoção por devs exige local-first/aberto; receita exige infraestrutura sua. Open-core concilia os dois.
- **Risco:** canibalização entre tiers. Mitigação: D7.

## D7 — Fronteira: uma máquina = grátis; atravessa máquinas/pessoas = pago

- **Decisão:** linha divisória geográfica.
- **Justificativa:** local-first é difícil de monetizar direto; o dinheiro mora em sync/agregação/compartilhamento, que atravessam fronteiras. Linha nítida impede o grátis de matar o pago e vice-versa.
- **Risco:** usuário pode improvisar sync próprio (Git, Syncthing). Aceitável — o valor pago é o turnkey + extras.

## D8 — Aposta do MVP pago = sync (não as outras três features)

- **Contexto:** candidatos: sync, dashboard custo/tokens, memória de equipe, observabilidade.
- **Decisão:** sync entre máquinas do mesmo usuário.
- **Justificativa:** dor real do usuário (múltiplas máquinas) = teste honesto; fronteira open-core mais limpa; degrau técnico mais baixo; vira "equipe" naturalmente.
- **Risco:** sync E2E tem complexidade (conflito, criptografia). Mitigação: começar simples, sem backend pesado.
- **Revisão (2026-06-29):** a evidência do código **inverte esta aposta**. No NutriGym, custo/tokens (Fase 1) está construído e testado (`token-usage.mjs`); sync tem **zero linha**. O esforço real foi para a feature defensável, e o público-alvo (devs) improvisa o próprio sync (Git/Syncthing — ver D7). Candidato a wedge pago: **custo/tokens, não sync**. Ver `08`.

## D9 — Público inicial = dev solo (usuário-zero), não solo + time juntos

- **Contexto:** tentação de mirar ambos desde o início.
- **Decisão:** solo primeiro, começando por você.
- **Justificativa:** solo e time são produtos diferentes (solo quer fricção zero/local; time quer admin/billing/SSO). Mirar os dois dilui a UX. Time é upsell após solos amarem.
- **Risco:** receita de time chega mais tarde. Aceitável — sequência de validação.

## D10 — Roadmap destravado por evidência, não por data

- **Decisão:** cada fase atrás de um gate concreto.
- **Justificativa:** roadmap com datas e sem gates é "todas as opções" adiada. Gate força a pergunta "o que precisa ser verdade antes de eu escrever a primeira linha".
- **Risco:** parece "lento". Aceitável — é a diferença entre enviar e não enviar (contexto: noites/fins de semana, emprego full-time, MBA).

## D11 — Não copiar concorrentes; reimplementar conceitos

- **Decisão:** tratar concorrentes como mapa de requisitos; reimplementar do zero; diferenciar marca/UI.
- **Justificativa:** conceitos/ideias são livres; código, texto de UI e identidade visual não. Protege um SaaS que se quer rentável.
- **Risco:** retrabalho vs. "inspiração" no código alheio. Aceitável e necessário (legal + estratégico).

## D12 — O núcleo já existe (hooks do NutriGym); o passo é produtizar, não construir

- **Contexto:** ao revisar `.agent/hooks/` do NutriGym-Vision (2026-06-29), constatou-se que a tecnologia-núcleo do wend já está construída e em uso diário — hooks ligados em produção, suíte de testes, vault populado. Fases 0 e 1 cobertas. Inventário em `08`.
- **Decisão:** tratar o wend não como "construir do zero", mas como **extração/produtização** de um núcleo já validado por uso próprio. O próximo passo é decidir produtizar + validar n=2, não reconstruir a captura.
- **Alternativas:** (a) seguir o roadmap como se fosse do zero — rejeitada: ignora o que já roda; (b) declarar o produto pronto — rejeitada: confunde tecnologia-núcleo com produto instalável por terceiros.
- **Justificativa:** acoplamento ao NutriGym é raso (~1 constante em `obsidian-common.mjs`); decopular é dias, não meses. O trabalho aberto é produto (config, i18n, vault de terceiros, instalador) + distribuição, não captura.
- **Risco / trade-off:** (1) acoplamento raso = fosso técnico fino (cruza com D3): copiável num fim de semana. (2) n=1 não é demanda — "valioso para mim" ≠ negócio. (3) Lacunas reais: busca por embeddings e sync. Mitigação: validar n≥2 barato antes de investir; liderar pelo asset defensável (custo/tokens, D8 revisada).
