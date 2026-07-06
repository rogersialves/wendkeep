# i18n — locale do vault (design, 0.8.0)

## Inventário (discovery 2026-07-05)

Literais PT espalhados:
- **Pastas** (`02-Sessões` … `08-Mudanças`): ~25 call sites em 15 arquivos (hooks + src).
- **Meses** (`01-JAN` … `12-DEZ`): 1 array única em `obsidian-common.mjs:12` (fácil).
- **Marcadores parseados por máquina** (quebram contrato se traduzir sem cuidado):
  - `### Requisito:` (spec-core parse/render; skills; templates)
  - fix-task `mata mutante <file>:<line>` (appendFixTasks **deduplica por essa string**)
  - Seções do CORE (`## Preferências do Usuário` etc. — validate-core REQUIRED_SECTIONS)
- **Prosa**: skills wk-* (6 corpos), templates de scaffold, README do vault, mensagens CLI.

## Decisões

1. **Locale é propriedade do VAULT** — gravado em `<vault>/.brain/config.json`
   (`{ "locale": "en" }`). Hooks e CLI sempre têm `vaultBase` → resolução uniforme.
   Ausente = `pt-BR` (retrocompat total; zero mudança pra vaults existentes).
2. **Locale trava no init** (`wendkeep init --locale en`). Vault existente NUNCA é
   renomeado — mudar locale de vault populado = migração manual (documentada como não
   suportada no v1).
3. **Parse é bilíngue SEMPRE; render segue o locale.** `### Requisito:|Requirement:`,
   `mata mutante|kill mutant` — os parsers aceitam ambos (vault misto não quebra);
   quem escreve usa o locale do vault.
4. **Locales v1: `pt-BR` (default) + `en`.** Mapa em `hooks/locale.mjs` (zero dep):
   `folders` (9 chaves), `months` (12), `reqHeading`, `fixTaskVerb`, `coreSections`,
   templates de scaffold. Cache por processo keyed por vaultBase.
5. **Escopo v1 = superfície estrutural.** Pastas, meses, marcadores de máquina,
   scaffold da change, seções/validador do CORE, tema (FOLDER_PALETTE/graph). **Fora do
   v1** (backlog rotulado): prosa das skills wk-* em en, README do vault en, mensagens
   CLI en. Contrato de máquina 100% en-capaz; prosa progressiva.
6. **Estágios com commit por checkpoint** (refactor mecânico grande):
   - **A** — `locale.mjs` + config + `init --locale` + camada harness (spec-core,
     change-core, change/verify/spec/harness-doctor) + meses + taxonomy/init.
   - **B** — hooks de captura (obsidian-common/session-*/linked-notes/brain-core),
     validate-core/CORE seed, vault-theme.
   - **C** (0.8.0 restante) — agent-agnostic (docs/17) + formatos de mutação (opcional).

## Contrato (`docs/14` v1.2, no release)
- `.brain/config.json`: `{ "locale": "pt-BR" | "en" }` (ausente = pt-BR).
- Pastas en: `00-Inbox 01-Project 02-Sessions 03-Linear 04-Decisions 05-Bugs
  06-Learnings 07-Specs 08-Changes Templates .brain`.
- Meses en: `01-JAN 02-FEB 03-MAR 04-APR 05-MAY 06-JUN 07-JUL 08-AUG 09-SEP 10-OCT 11-NOV 12-DEC`.
- Headings: `### Requisito:` / `### Requirement:` (parse aceita ambos em qualquer vault).
- Fix-task: `mata mutante` / `kill mutant` (idem).
- CORE en: `## User Preferences`, `## Project State`, `## Active Lessons` (validate-core
  aceita o conjunto do locale do vault).
