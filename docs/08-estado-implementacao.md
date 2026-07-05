# 08 — Estado Real da Implementação (reconciliação docs × código)

> **Reconciliação de 2026-06-29.** Este pacote descrevia como futuro o que já está rodando. O núcleo do wend **já existe e está em produção** — não como produto standalone, mas como os hooks de sessão do projeto **NutriGym-Vision** (`.agent/hooks/`). Os arquivos `01`–`07` foram escritos do ponto zero; este documento corrige o pressuposto de que o trabalho técnico-núcleo ainda está por fazer.

---

## A descoberta central

Não é protótipo. É um produto interno em uso diário:

- Hooks ligados em produção no `settings.json` do Claude Code: `SessionStart`, `Stop`, `SessionEnd`, `UserPromptSubmit` chamam os `.mjs`.
- Suíte de testes real (`tests/session-hooks.test.mjs` ~60KB; `brain-core.test.mjs`).
- Vault vivo e populado: `.brain/index.jsonl` (~39KB), `SESSION_REGISTRY.json` (~65KB), CORE/DIGEST e notas de sessão atualizadas diariamente.
- Multi-agente: captura **Claude Code + Codex + Copilot** — mais amplo que o MVP documentado, que era só Claude Code.

**Consequência:** o gate de SHIP da Fase 0 ("funciona para você, uso diário, 2–4 semanas, sem quebrar") está, na prática, atendido. O risco técnico que `05-roadmap.md` assumia como aberto está, em grande parte, fechado.

---

## Inventário: roadmap documentado × o que existe no código

| Item do roadmap | Status real | Onde (NutriGym `.agent/hooks/`) | Ressalva |
|---|---|---|---|
| Captura automática de sessão → Markdown no Obsidian | ✅ **Construído** (multi-agente) | `session-start/ensure/stop.mjs`, `obsidian-common.mjs` | Mais amplo que o MVP (Claude Code + Codex + Copilot) |
| Busca local sobre as sessões | ⚠️ **Parcial** — *keyword/frontmatter scoring*, **não** embeddings | `brain-core.mjs`, `brain-recall.mjs` | A doc vende "busca semântica (embeddings on-device)". Isso continua promessa. |
| Grafo do Obsidian (backlinks + notas derivadas) | ✅ **Construído** + extração automática de Decisões/Bugs/Aprendizados | `linked-notes.mjs` | Além do escopo do MVP |
| Dashboard de custo/tokens (**Fase 1**) | ✅ **Construído** — multi-provedor, pricing com cache, histórico | `token-usage.mjs` (~950 linhas), `pricing.json` | A peça mais sofisticada e defensável; o roadmap a tratava como futura |
| Camada de memória curada (CORE/DIGEST injetados) | ✅ **Construído** | `brain-core.mjs`, `brain-inject.mjs` | Fora do escopo documentado |
| Saúde/integridade do vault | ✅ **Construído** | `vault-health.mjs` | — |
| Sync E2E entre máquinas (**aposta do MVP pago**) | ❌ **Não construído** | — | A única aposta paga documentada sem nenhuma linha de código |

---

## As duas lacunas reais (para não se enganar)

1. **Busca semântica por embeddings.** A doc (`04`, README) promete "embeddings on-device, estilo QMD/Smart Connections". O que existe é `hay.includes(termo)` — pontuação por palavra-chave sobre um índice de frontmatter. Funciona, mas **não é** busca semântica. É a única peça do MVP grátis documentado que ainda é promessa.
2. **Sync.** Zero código. É justamente a feature elevada a "aposta do MVP pago" (D8) — a mais difícil e a menos construída.

Tudo o mais que o roadmap colocava como trabalho técnico a fazer, já está feito.

---

## Acoplamento ao NutriGym (a boa e a má notícia são a mesma)

O acoplamento é **raso**: apenas `obsidian-common.mjs` carrega o caminho hardcoded (`DEFAULT_VAULT_BASE = …\.NutriGymBrain`); todo o resto lê de `getVaultBase(input)`. O resto do acoplamento é **convenção** (taxonomia de pastas em PT-BR: `02-Sessões`, `04-Decisões`, `05-Bugs`, `06-Aprendizados`) e **idioma**. Decopular o núcleo ≈ 1 constante + camada de config.

- **Boa notícia:** extrair um produto instalável está a poucos dias de trabalho, não meses.
- **Má notícia:** se você decopla num dia, um concorrente também. Confirma `D3` — **o fosso não é a tecnologia de captura** (é copiável num fim de semana). O defensável real é gravidade de dados + custo/tokens, não a engine.

---

## Inversões estratégicas que isto força

1. **O "próximo passo" mudou.** Não é "escrever o PRD da Fase 0 e construir o hook" (feito). É **decidir produtizar ou não** e validar **n=2**: extrair os hooks num repo standalone decopulado, README em inglês, e pôr na frente de 5–10 outros devs. O passo aberto é **distribuição**, não captura.
2. **O wedge pago deveria inverter.** Custo/tokens (Fase 1) está **construído e testado**; sync (aposta do MVP) tem **zero linha**. O esforço real foi para a feature defensável — e o público-alvo improvisa o próprio sync (Git/Syncthing, ver `D7`). Candidato a wedge de lançamento: **custo/tokens**, não sync. Ver `D8` revisada em `06`.
3. **n=1 ≠ mercado.** O que está provado é "valioso para mim" — dogfooding real, melhor que o da maioria. **Não** é demanda de mercado validada. A confiança no uso próprio não substitui o teste com estranhos.

---

## O que este documento NÃO afirma

Não diz que "o wend-produto existe". Diz que a **tecnologia-núcleo** existe, acoplada ao NutriGym. O trabalho de **produto** continua aberto e é o que falta — decopular, config/onboarding, i18n (hoje PT-BR hardcoded), lidar com vaults de terceiros (bagunçados), instalador, docs em inglês, robustez. Esse é o trabalho não-feito; a captura não é.

---

## Ponteiro de ação

Antes de qualquer linha de produtização: o teste n=2 (distribuição) é mais barato que qualquer feature e responde a pergunta que `01`–`07` não conseguem responder — *alguém além de você instala isto?* Construir mais antes desse teste é a versão 2026 do "documentar em vez de enviar" que o README adverte.
