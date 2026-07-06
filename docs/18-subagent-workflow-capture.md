# Captura de subagents & workflows (design, 0.10.0)

Fecha o maior buraco de observabilidade do wendkeep: a nota de sessão registra só o
transcript principal. Numa sessão real de auditoria, os **subagents** (10 transcripts,
10M tokens, 182 chamadas) ficaram **invisíveis** — 5× o main, zero capturado.

## Decisões (aprovadas)
- **Total separado.** `tokens_total` continua = MAIN (comparável ao display do Claude Code).
  Novos campos: `subagents_count`, `subagents_tokens_total`, `subagents_custo_usd`,
  `tokens_total_incl_subagents`. Não infla o número principal.
- **Detalhe: agregado + tabela colapsável.** Seção `## Subagents & Workflows` com resumo +
  `<details>` com a tabela por subagent.
- **Provider-gated por estrutura.** Só roda se `<sessionDir>/subagents/` existe.

## Fonte de dados (Claude Code)
Ao lado de `<slug>/<id>.jsonl` (o transcript principal) fica `<slug>/<id>/`:
- `subagents/**/agent-<aid>.jsonl` — transcript do subagent (mesmo formato Claude: `message.usage` + `message.model` + `tool_use`). Subdir `subagents/workflows/wf_<rid>/` associa ao workflow; direto em `subagents/agent-*.jsonl` = subagent de Task avulso.
- `subagents/**/agent-<aid>.meta.json` — `{agentType, spawnDepth}` (enriquece a coluna Tipo).
- `workflows/wf_<rid>.json` (run) + `workflows/scripts/<nome>-wf_<rid>.js` (`export const meta = { name }`).

## Módulo `hooks/subagent-usage.mjs`
Reusa de `token-usage.mjs`: `parseTokenUsageFromTranscript`, `summarizeTokenUsage`,
`priceForModel`, `costBreakdown`, `addUsage`.

- `sessionDirFromTranscript(transcriptPath) -> string` — `transcriptPath` sem `.jsonl`.
- `collectSubagentUsage(sessionDir) -> { subagents:[{id, agentType, workflow, model, tools, usage, cost}], workflows:[{runId, name, agents, cost}], aggregate:{count, calls, usage, cost} } | null`
  - `null` se `subagents/` não existe (Codex / sessão sem subagent).
  - varre `subagents/**/*.jsonl`; por arquivo: parse → summary → cost. `workflow` = nome do
    wf_ pai (via mapa runId→name dos scripts) ou `null`.
- `renderSubagentSection(collected) -> string` — a seção markdown (resumo + `<details>` tabela).
- `upsertSubagentUsage(sessionPath, transcriptPath) -> boolean` — coleta; se houver, upsert
  dos campos de frontmatter + da seção; escreve. **Fail-open** (nunca derruba o Stop).

## Wiring
`session-stop.mjs`, após `updateSessionUsage(...)`, num `try/catch`:
```js
try { upsertSubagentUsage(sessionPath, transcriptPath); } catch (e) { stderr('subagent usage falhou: '+e.message); }
```
`HOOK_FILES += 'subagent-usage.mjs'`.

## Formato da nota
```markdown
## Subagents & Workflows

> Custo de subagents/workflows desta sessão — NÃO incluído no total principal acima.

- **Subagents:** 10 · 182 chamadas · 10.053.359 tokens · $X.XX
- **Workflows:** agent-dir-deprecation-audit (wf_c34eab4c · 10 agentes · $X.XX)

<details><summary>Por subagent (10)</summary>

| Agent | Tipo | Workflow | Modelo | Tools | Tokens | Custo |
|---|---|---|---|---:|---:|---:|
| a138c6e8 | general-purpose | audit | claude-opus-4-8 | 4 | 1.2M | $... |
</details>
```

## Tasks (TDD)
1. `sessionDirFromTranscript` + `collectSubagentUsage` (varre transcripts sintéticos) + workflow name map. Unit.
2. `renderSubagentSection` + `upsertSubagentUsage` (frontmatter fields + seção, fail-open) + HOOK_FILES. Unit + e2e com nota sintética.
3. Wire `session-stop` (guarded) + release 0.10.0.

## Não-objetivos
- Sem custo por-fase do workflow (parse do script) no v1 — só nome + nº agentes.
- Codex: layout de subagent não confirmado; a gate por estrutura simplesmente pula.
