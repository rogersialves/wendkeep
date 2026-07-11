# wendkeep

**Português** · [English](README.md)

> **Seu agente de código esquece cada sessão. O wendkeep faz ele lembrar — no cofre Obsidian que você já usa.**

[![npm](https://img.shields.io/npm/v/wendkeep.svg)](https://www.npmjs.com/package/wendkeep)
![test](https://github.com/rogersialves/wendkeep/actions/workflows/test.yml/badge.svg)
![zero deps](https://img.shields.io/badge/deps%20de%20runtime-0-brightgreen)
![node](https://img.shields.io/badge/node-%E2%89%A518-blue)

[![wendkeep — memória persistente para agentes de código, mostrada como um grafo de sessões, decisões, bugs, aprendizados e mudanças](docs/assets/wendkeep-hero.pt.svg)](docs/index.pt.html)

**No grafo:** 🔵 sessão · 🟣 decisão · 🔴 bug · 🟢 aprendizado · 🟡 mudança — cada nota, com backlink.

**Um harness de memória persistente para agentes de código, construído sobre o seu cofre Obsidian.** Cada sessão do Claude Code / Codex é capturada turno a turno em Markdown local — com rastreio de tokens/custo, decisões, bugs e aprendizados extraídos automaticamente, e uma camada de memória curada injetada de volta no início da próxima sessão. Sobre esse núcleo de memória fica um **ciclo de mudança** nativo e sem dependências (spec → change → TDD → archive com gate por sensor) que mantém intenção, trabalho e prova wikilinkados num só grafo. 100% local, open‑core.

```bash
npm i -D wendkeep && npx wendkeep init      # captura a partir da próxima sessão
npx wendkeep import                          # importa sessões passadas do Claude + Codex
```

**▶ Demo interativo:** [`docs/index.pt.html`](docs/index.pt.html) — uma página autocontida com o herói de grafo vivo. Abra local (ou sirva `docs/` em qualquer host estático). A imagem acima é um render estático dele.

> **De um cofre de produção real** (`npx wendkeep stats`): **308** sessões · **1.696** prompts · **US$ 4.836** capturados em **46 dias ativos** (jan–jul 2026) · **15** modelos — cada uma delas uma nota no grafo.

> Extraído de um sistema em uso diário de produção: o motor de captura, o rastreio de custo e a fiação do grafo são testados em batalha; o instalador multiplataforma (`wendkeep init`) e o ciclo de mudança nativo são as partes mais novas. Veja [`docs/`](https://github.com/rogersialves/wendkeep/tree/main/docs) para a estratégia e o log de decisões do projeto.

---

## O problema: o contexto morre quando a janela fecha

Decisões, becos sem saída, o motivo de você ter escolhido X em vez de Y — some na próxima sessão. As peças pra resolver existem, mas espalhadas (qmd‑sessions, memsearch, Nexus, hooks feitos à mão). O wendkeep entrega tudo num pacote turnkey que escreve num grafo de conhecimento **dentro do cofre Obsidian que você já usa** — sem setup manual, sem snapshot pra manter sincronizado.

| | |
|---|---|
| **Captura** — cada turno, no disco | Os hooks `SessionStart` / `Stop` escrevem cada sessão numa nota Markdown datada: prompts, iterações, arquivos tocados, wikilinks. |
| **Deriva** — decisões, bugs, aprendizados | Puxados do transcript pra notas próprias, com backlink pra sessão. Seu histórico fica navegável, não arquivístico. |
| **Recall** — injetado de volta | Um `CORE` + `DIGEST` com budget capado e a change ativa são injetados no agente no próximo `SessionStart`. Ele retoma de onde parou. |
| **Custo** — quanto tudo custou | Preço por modelo, ciente de cache, por sessão — mais `cost --trend` com projeção run‑rate no cofre inteiro. |
| **Multi‑agente** — uma instalação, todos os agentes | Detecta o provedor real (Claude Code, Codex, Copilot) em runtime. |
| **Local‑first** — sem nuvem, sem conta | Tudo é Markdown puro no seu disco. Um MCP opcional (`@bitbonsai/mcpvault`) deixa o agente ler/escrever o cofre. |

## Requisitos

- Node.js ≥ 18
- Um agente de código com hooks (Claude Code hoje; Codex atendido pelos mesmos hooks)
- Obsidian (pra ver o grafo) — opcional, mas é o ponto

## Instalar & configurar

```bash
# no seu projeto
npm install --save-dev wendkeep   # ou: npm install -g wendkeep
npx wendkeep init
```

O `wendkeep init` é interativo e **idempotente**. Ele:

1. Cria a taxonomia de pastas do cofre e um `README.md` templado (cofre padrão: `<projeto>/.<nome-do-projeto>-vault`, ex.: `.MeuApp-vault`; sobrescreva com `--vault`).
2. **Mescla** os três hooks de sessão e o `OBSIDIAN_VAULT_PATH` no `.claude/settings.json` — sem atropelar suas configs (salva um `.bak`; arquivo ilegível fica intocado e um `.new` é escrito pra você mesclar).
3. Adiciona o servidor MCP **`wendkeep-vault`** ao `.mcp.json` pro agente ler/escrever o cofre. Pule com `--no-mcp` — ex.: quando o agente já tem um MCP de cofre. (`--no-mcp` pula *só o MCP do próprio wendkeep*; os MCPs de companion seguem `--companions`.)
4. Oferece fixar plugins/MCP **companion** (múltipla escolha; **nenhum** pré-marcado). Cada um é wirado do jeito mais agnóstico que suporta:
   - **`context-mode`** — otimizador de contexto + memória FTS5, como servidor MCP no `.mcp.json` (qualquer agente).
   - **`understand-anything`** — grafo de domínio do projeto, via um hook `understand-inject` no SessionStart que injeta o grafo quando gerado.
   - **`caveman`** — modo de compressão de tokens; roda seu próprio instalador cross‑agent em agentes não‑Claude.
   - **`dotcontext`** — *legado, não recomendado.* O loop a2 nativo do wendkeep (`change` / `verify` / gate) já faz o trabalho dele, então instalar **duplica o harness**. Ainda selecionável via `--companions dotcontext` pra quem já usa (ajuste com `--dotcontext-mcp` / `--dotcontext-hooks`), mas off por padrão.

   Controle com `--companions <csv>` ou `--no-companions`. A camada de plugin do Claude Code (`extraKnownMarketplaces` + `enabledPlugins`) é wirada como bônus onde o companion tiver uma.
5. Instala um **sistema de cores** no `.obsidian/` do cofre: um snippet CSS que colore notas por tipo (sessão/decisão/bug/aprendizado, via as `cssclasses` que os hooks emitem) mais grupos de cor do grafo por pasta. Merge não‑destrutivo em `appearance.json`/`graph.json`; pule com `--no-colors`.
6. Semeia a **camada de memória curada**: `.brain/CORE.md` (a camada quente curada à mão, com as 3 seções obrigatórias) e `.brain/COMPACTION_PROTOCOL.md` (o guia do protocolo). As camadas automáticas (`DIGEST.md`, `index.jsonl`) são geradas pelos hooks. Valide a camada curada com `wendkeep validate-memory` (cap 25 linhas, 3 seções, sem segredos/PII).
7. Semeia a **camada de definições + skills**: `.brain/agents/` + `.brain/skills/` (fonte da verdade versionada), incluindo as skills de processo nativas `wk-workflow` / `wk-tdd` / `wk-debugging` / `wk-brainstorming` / `wk-planning` / `wk-verify` (algumas trazem templates, ex.: o `verdict-template.json` + prompt de revisor da `wk-verify`). O `init` roda o `wendkeep sync-defs` pra você, entregando em `.codex/agents/` + `.claude/skills/` (rode `sync-defs` de novo após editar o `.brain`).
8. Semeia o **ciclo change/spec**: as pastas `07-Specs/` + `08-Mudanças/` e um `wendkeep.sensors.json` nativo (um sensor `validate-memory` mais um por script detectado no `package.json`). Move o `wendkeep change` / `wendkeep verify` — veja **Ciclo de mudança** abaixo.

```bash
npx wendkeep init --vault "~/vaults/work" --project . --yes   # não-interativo
npx wendkeep init --companions "context-mode,understand-anything" --yes
npx wendkeep init --no-companions --no-mcp --yes              # zero companions, sem MCP do wendkeep
```

### Opções do `init`

| Flag | O que faz |
|---|---|
| `--vault <path>` | Pasta do cofre. Padrão `<projeto>/.<nome-do-projeto>-vault`; o init interativo pergunta. Aponte pra um cofre existente pra instalar nele. |
| `--project <path>` | Raiz do projeto a wirar (padrão: diretório atual). |
| `--locale <pt-BR\|en>` | Idioma do cofre — nomes das pastas, scaffold, skills. O init interativo pergunta; travado no init. |
| `--companions <csv>` | Companions a fixar: `context-mode,caveman,understand-anything` (padrão: **nenhum** — opte explicitamente; `dotcontext` é legado). |
| `--no-companions` | Não fixa nenhum companion. |
| `--no-mcp` | Pula o MCP de cofre **do próprio wendkeep** (`wendkeep-vault`). Os MCPs de companion seguem `--companions`. |
| `--no-colors` | Pula o sistema de cores do Obsidian (snippet `.obsidian` + grupos do grafo). |
| `--yes`, `-y` | Não-interativo; aceita os padrões (pula os prompts de idioma / cofre / companion). |
| `--force` | Sobrescreve os blocos de config do wendkeep existentes. |

Depois abra o cofre no Obsidian, mande um prompt de teste no seu agente e confirme que uma nota aparece em `02-Sessões/…` (ou `02-Sessions/…` num cofre `en`).

## Atualizar

Como os hooks vivem dentro do pacote instalado (o settings.json chama `npx wendkeep hook <name>`), atualizar é só:

```bash
npm update wendkeep
```

Sem recopiar, sem snapshot pra re‑sincronizar — o pacote é a única fonte da verdade.

## Comandos

| Comando | O que faz |
|---|---|
| `wendkeep init` | Configura o wendkeep num projeto (taxonomia do cofre + settings + MCP + skills). |
| `wendkeep hook <name>` | Roda um hook de sessão; invocado pelo `settings.json` (lê o JSON do agente no stdin). |
| `wendkeep change <sub>` | Ciclo de mudança: `new [--simple]` / `list` (backlog global) / `show` / `status [slug]` / `done <id> [--change slug]` / `undone <id> [--change slug]` / `diff` / `archive [--force]`. |
| `wendkeep verify [--deep]` | Roda os sensores das tarefas da change; `--deep` monta o pacote de verificação independente. |
| `wendkeep spec <sub>` | Specs vivos: `list` / `show <capability>`. |
| `wendkeep sensors <sub>` | `list` / `add <id> "<comando>"` — vê/edita `wendkeep.sensors.json` (JSON Schema incluso). |
| `wendkeep cost [opts]` | Agrega o gasto de IA nas sessões do cofre — total, por modelo, por dia · `--top [N]` · `--trend [day\|week\|month]` (+ projeção) · `--write` (gera `00-Custo.md`) · `--json`. |
| `wendkeep stats [--vault P]` | Uma linha compartilhável: sessões · prompts · gasto · período · modelos (`--json`). |
| `wendkeep import [opts]` | **Memória retroativa** — importa sessões passadas de **Claude + Codex** pro cofre (dedup por `session_id`). `--source all\|claude\|codex` / `--from <dir>` / `--codex-from <dir>` / `--stamp-ids` / `--since d` / `--limit n` / `--dry-run` / `--json`. |
| `wendkeep dashboard [--force]` | (Re)gera os Bases filtrados por pasta + o MOC `00-Dashboard`. |
| `wendkeep lesson add "t" "l"` | Registra uma lição local do projeto (injetada no próximo SessionStart). |
| `wendkeep sync-defs` | Copia `.brain/agents\|skills` pro projeto (`.codex/agents`, `.claude/skills`). |
| `wendkeep validate-memory [path]` | Valida `.brain/CORE.md` (cap 25, 3 seções, sem segredos/PII). |
| `wendkeep doctor [--vault P]` | Roda um check de saúde do cofre (integridade de sessões, registry, links). |
| `wendkeep --version` / `--help` | Versão / uso. |

## Memória retroativa (`import`) — instale hoje, lembre de ontem

Instale o wendkeep num projeto existente e ele só lembra sessões **a partir de agora**. O `wendkeep import` conserta isso: um comando importa as sessões passadas de **Claude & Codex** do projeto pro cofre — dedup, datadas, com custo — então o grafo começa cheio, não vazio. Reconstrói cada transcript como uma nota de sessão completa na pasta datada **real** — frontmatter (taggeado com o provedor real), um bloco de iteração por turno, custo + telemetria de subagents, notas derivadas de decisão/bug/aprendizado, encerramento finalizado. Um replay offline do fluxo de captura vivo, então uma nota importada é indistinguível de uma capturada.

```bash
wendkeep import --vault .meuprojeto-vault --dry-run   # prévia do que seria importado (os dois agentes)
wendkeep import --vault .meuprojeto-vault             # escreve as notas
wendkeep import --vault .meuprojeto-vault --source codex   # só Codex
```

- **Os dois agentes por padrão** (`--source all`). As sessões do Claude vêm de `~/.claude/projects/<slug>/`; os rollouts do Codex de `~/.codex/sessions/**`, escopados pro projeto pelo `cwd` gravado em cada sessão (insensível a case e separador, subpastas inclusas). Estreite com `--source claude` / `--source codex`.
- Toda nota grava o **`session_id`** e o **`provider`** no frontmatter (captura live e import iguais). Carimbe notas antigas com `wendkeep import --stamp-ids` (preenche o id a partir do registry; idempotente).
- **Dedup** por `session_id` contra o `SESSION_REGISTRY` do cofre **e** o frontmatter das notas existentes — só importa sessões ausentes e nunca sobrescreve. Rodar de novo é no‑op.
- Depois de importar, o `wendkeep cost` agrega seu histórico inteiro — retroativamente, nos dois agentes.

## Ciclo de mudança — o loop a2 (spec‑driven, nativo)

Além de capturar sessões, o wendkeep é um **harness**: um loop nativo e sem dependências que mantém *intenção* (specs), *trabalho* (changes) e *prova* (sensores) juntos no cofre, wikilinkados no grafo Obsidian.

```
explore → propose → apply (TDD) → verify → archive
```

- **Propose** — `wendkeep change new <slug>` faz o scaffold de `08-Mudanças/<slug>/` (`proposta.md`, `design.md`, `tarefas.md` e um delta `specs/`). A change vira a *atual* global. Várias changes podem ficar abertas: hooks e `change list/status` mostram todas as pendências, enquanto comandos sem `--change` usam somente a atual.
- **Apply** — implemente cada tarefa de `tarefas.md`. Taggeie a tarefa que precisa de prova de máquina com `[sensor:<id>]`.
- **Verify** — `wendkeep verify` roda os sensores que suas tarefas declararam (do `wendkeep.sensors.json` na raiz do projeto) e grava `evidencia.json`. Um vermelho crítico falha o gate; um vermelho `warning` é aviso.
- **Archive** — `wendkeep change archive <slug>` faz **gate** na evidência (bloqueia a não ser que todo sensor crítico declarado esteja verde), promove o delta de cada capability (`ADDED`/`MODIFIED`/`REMOVED`) pro `07-Specs/<capability>.md` vivo, move a change pro `_arquivo/` e cunha um ADR em `04-Decisões/`.

> O gate bloqueia a não ser que o scaffold esteja preenchido, nenhuma tarefa aberta, evidência fresca e todo requisito declarado coberto. **`--force` é decisão do humano — nunca do agente.**

O `wendkeep init` também semeia **skills de processo nativas** (`wk-workflow`, `wk-tdd`, `wk-debugging`, `wk-brainstorming`, `wk-planning`, `wk-verify`) em `.brain/skills` e as entrega em `.claude/skills` — a camada do *como*, zero‑dep. Companions opcionais (`context-mode`, `dotcontext`, `understand-anything`, `caveman`) ficam como camada extra opt‑in.

## Como funciona

```
sessão do agente ──hooks──▶ wendkeep ──▶ Markdown no cofre ──▶ índice .brain + grafo Obsidian
   (Claude/Codex)           (Node)      (02-Sessões/…)         (CORE+DIGEST, backlinks)
```

O settings.json do agente aponta cada hook pra `npx wendkeep hook …`. No `Stop`, o wendkeep parseia o transcript, anexa o turno, atualiza a tabela de tokens/custo e (idempotentemente) emite qualquer nota de decisão/bug/aprendizado. Em todo `SessionStart`, o `brain-inject` injeta a memória curada (CORE + DIGEST), todas as changes abertas com suas pendências, o marcador global da change atual, as lições do projeto e o roteador `<wk_process>`. Claude, Codex ou outro agente podem assim retomar trabalho iniciado em outro lugar sem ocultar o restante do backlog.

O **gate** do archive bloqueia a não ser que: o scaffold da change esteja preenchido (G0), nenhuma tarefa esteja aberta (G1), todo sensor crítico declarado esteja verde (com evidência fresca) e — quando a change declara `[req:]` — um `verdict.json` independente cubra eles. O `--force` é a saída de emergência humana; o agente é instruído a nunca usar por conta própria.

## Notas & roadmap

- **Nomes das pastas do cofre são em Português por padrão** (`02-Sessões`, `04-Decisões`, …). Passe `wendkeep init --locale en` pra um cofre em inglês (`02-Sessions`, `04-Decisions`, scaffold/skills em inglês). O locale é uma propriedade do cofre, travada no init; os parsers são bilíngues, então conteúdo misto nunca quebra.
- **Busca é scoring por keyword/frontmatter**, não embeddings on‑device (isso está no roadmap).
- **Formatos de transcript são internos ao agente** e podem mudar entre versões; o parsing é isolado mas pode precisar de atualizações.
- O instalador wira settings do **Claude Code** + `.mcp.json`. Os hooks do Codex rodam nos mesmos scripts mas ainda não são auto‑wirados (o import já cobre sessões Codex passadas via `--source codex`).

---

## Pare de reexplicar seu código toda manhã

```bash
npm i -D wendkeep && npx wendkeep init
```

**[Instalar do npm](https://www.npmjs.com/package/wendkeep)** · **[Deixar uma star no GitHub](https://github.com/rogersialves/wendkeep)** — MIT · open‑core · seus dados nunca saem do seu disco.

## Licença

MIT
