# Distribuição agent-agnostic (contrato 0.34.0)

## Discovery
Onde cada agente lê instruções por projeto:
- **AGENTS.md** (raiz) — padrão de-facto emergente: Codex, Amp, Cursor (suporte anunciado),
  Zed, Jules, vários outros. Um arquivo, muitos agentes.
- `.claude/skills/` — Claude Code (já coberto pelo sync-defs).
- `.agents/skills/` — Agent Skills de projeto, consumidas pelo Codex.
- `.cursor/rules/*.mdc`, `.windsurfrules`, etc. — convenções por-agente, instáveis entre
  versões (mdc vs md, frontmatter próprio). Alto custo de manutenção, baixo ganho marginal
  sobre AGENTS.md.

## Decisão
**Fonte única: `.brain/skills`; três adaptadores gerados:** `AGENTS.md`, `.claude/skills`
e `.agents/skills`.
```
<!-- wendkeep:skills:start -->
… (gerado — loop a2 resumido + inventário das skills wk-*)
<!-- wendkeep:skills:end -->
```
- `wendkeep sync-defs` (e o `init`) escrevem/atualizam SÓ o miolo entre marcadores;
  conteúdo do usuário fora deles é intocado. Arquivo ausente = criado com a seção.
- Conteúdo: o loop (change new → tdd → verify → verify --deep → archive) + a lista das
  skills de `.brain/skills/*/SKILL.md` (frontmatter name/description) + comandos.
- Cópias recebem `.wendkeep-meta.json` com versão/hash; `sync-defs --check` detecta drift.
- Por-agente extra (.cursor/rules etc.): fora do contrato — AGENTS.md os cobre; reavaliar se
  usuários pedirem.

## Hooks de sessão — canal Codex (0.46.0)
Codex tem canal próprio, **JSON**, em `<project>/.codex/hooks.json`; o `init` escreve junto
com o `.claude/settings.json`, merge não-destrutivo, mesma disciplina. Não é TOML: declarar
hooks no `config.toml` do projeto não dispara em sessão interativa (openai/codex#17532).
- **Projetados (7)**, de `src/taxonomy.mjs` (`codex: true`): `brain-inject`, `session-start`
  (SessionStart), `session-ensure`, `change-context` (UserPromptSubmit), `session-stop`,
  `change-nag` (Stop), `subagent-stop` (SubagentStop). Chaves de evento PascalCase; comando
  sempre `npx wendkeep hook <name>` (a forma node-direct emite `${CLAUDE_PROJECT_DIR}`, que
  não existe no Codex); timeout na chave `timeoutSec` — `timeout` é ignorado em silêncio e cai
  no default de 600s.
- **Fora (5)**, cada um com um `// codex:` no spec dizendo o porquê: `change-guard` — gate
  PreToolUse que lê `tool_input.command`; no `exec` do Codex o `tool_input` **existe, mas é
  string crua**, não objeto, então o gate não erra: degrada para liberar tudo (falha OPEN);
  `change-warn` — *nudge* PostToolUse que lê `tool_input.file_path`, campo que o envelope do
  `apply_patch` não carrega; apenas não dispara (não há o que barrar, logo não falha OPEN);
  `decision-capture` — AskUserQuestion é ferramenta Claude-only; `plan-capture` — falta a
  transição de modo (não há equivalente a ExitPlanMode); `task-log` — falta o evento
  (TaskCompleted não está no enum de eventos do Codex).
- **Trust gate**: todo hook nasce Untrusted — o Codex enumera e **não executa** até o usuário
  aprovar "Hooks need review" no startup; o `init` não pré-aprova
  (`--dangerously-bypass-hook-trust` é por-invocação, não persiste `trusted_hash`) e imprime
  o aviso. Migrar `timeout` → `timeoutSec` muda o hash: quem tinha wiring manual leva uma
  re-review única. Esperado.
- Demais agentes (Amp/Cursor/Zed): sem canal de hooks — captura segue por AGENTS.md + wiring
  manual.
