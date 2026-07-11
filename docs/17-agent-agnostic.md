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

Hooks de sessão pros outros agentes (Codex TOML etc.): fora do 0.8.0 — camada de captura
segue Claude-wired; a documentação do contrato permite wiring manual.
