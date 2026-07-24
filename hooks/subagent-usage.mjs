// hooks/subagent-usage.mjs — capture subagent + workflow telemetry (0.10.0). The Stop hook
// only reads the MAIN transcript; a session that spawns subagents/workflows (e.g. a Workflow
// run) burns tokens in sibling transcripts the note never recorded. This scans them.
// Reuses token-usage.mjs's parser. Provider-gated by structure (Claude Code layout).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { hasSessionFrontmatter, mutateSessionNote } from './session-note-io.mjs';
import { basename, join } from 'node:path';
import { parseTokenUsageFromTranscript, summarizeTokenUsage } from './token-usage.mjs';

const fmt = (n) => Math.trunc(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const usd = (n) => `$${(Number(n) || 0).toFixed(4)}`;

// <slug>/<id>.jsonl (main transcript) -> <slug>/<id>/ (sibling dir with subagents/workflows).
export function sessionDirFromTranscript(transcriptPath) {
  return String(transcriptPath || '').replace(/\.jsonl?$/i, '');
}

function walkAgentJsonl(dir) {
  const out = [];
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) out.push(...walkAgentJsonl(p));
    else if (n.startsWith('agent-') && n.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// workflows/scripts/<name>-wf_<rid>.js  ->  { wf_<rid>: <name> }
function workflowNameMap(sessionDir) {
  const map = {};
  let names;
  try { names = readdirSync(join(sessionDir, 'workflows', 'scripts')); } catch { return map; }
  for (const n of names) {
    const m = n.match(/^(.*)-(wf_[a-z0-9-]+)\.js$/i);
    if (m) map[m[2]] = m[1];
  }
  return map;
}

function runIdOfPath(file) {
  const m = file.replace(/\\/g, '/').match(/\/(wf_[a-z0-9-]+)\//i);
  return m ? m[1] : null;
}

// workflows/wf_<rid>.json carries authoritative run metadata (name/status/phases/duration).
function readWorkflowRuns(sessionDir) {
  const runs = {};
  let names;
  try { names = readdirSync(join(sessionDir, 'workflows')); } catch { return runs; }
  for (const n of names) {
    if (!/^wf_.*\.json$/i.test(n)) continue;
    try {
      const o = JSON.parse(readFileSync(join(sessionDir, 'workflows', n), 'utf8'));
      const runId = o.runId || n.replace(/\.json$/i, '');
      runs[runId] = {
        name: o.workflowName || runId,
        status: o.status || '',
        agentCount: o.agentCount || 0,
        totalTokens: o.totalTokens || 0,
        durationMs: o.durationMs || 0,
        phases: (o.phases || []).map((p) => p && p.title).filter(Boolean),
      };
    } catch { /* skip bad run json */ }
  }
  return runs;
}

function tokensTotal(t = {}) {
  return Number(t.total || 0) || ((t.input || 0) + (t.cached || 0) + (t.cacheWrite || 0) + (t.output || 0));
}

const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

// Aggregate every subagent transcript under <sessionDir>/subagents. null when the dir is
// absent (Codex / a session with no subagents) or nothing parseable.
// --- Codex discovery ----------------------------------------------------------
// A Codex subagent is not a file under `<transcript>/subagents/` — it is a SIBLING rollout
// in ~/.codex/sessions/YYYY/MM/DD/, whose session_meta declares source.subagent and points
// back via parent_thread_id. Without this, every Codex session closed with subagents_count 0,
// live (SubagentStop) and on import alike.

// First line of a rollout, bounded — Codex meta lines can be large (env, git, instructions).
function readRolloutMeta(path, maxBytes = 4 * 1024 * 1024) {
  try {
    const text = readFileSync(path, 'utf-8');
    if (text.length > maxBytes) return null;
    const line = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
    const e = JSON.parse(line);
    return e.type === 'session_meta' ? (e.payload || {}) : null;
  } catch { return null; }
}

// Sibling day dirs to scan: the parent rollout's own dir plus the NEXT day — a session that
// crosses midnight UTC spawns its subagent in the other day's folder, and the first real case
// (Vendiva, 23:54 UTC) missed that by six minutes.
function codexSiblingDirs(transcriptPath) {
  const dir = join(transcriptPath, '..');
  const m = String(dir).replace(/[\\/]+$/, '').match(/(\d{4})[\\/](\d{2})[\\/](\d{2})$/);
  if (!m) return [dir];
  const next = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  const pad = (n) => String(n).padStart(2, '0');
  const nextDir = join(dir, '..', '..', '..', String(next.getUTCFullYear()), pad(next.getUTCMonth() + 1), pad(next.getUTCDate()));
  return [dir, nextDir];
}

export function collectCodexSubagentUsage(transcriptPath) {
  const meta = readRolloutMeta(transcriptPath);
  if (!meta?.id) return null; // not a Codex rollout — the Claude path stays untouched
  const canonicalId = meta.id;

  const subagents = [];
  const allTools = new Set();
  const usageAgg = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
  const modelMap = new Map();
  let count = 0;
  let calls = 0;
  let cost = 0;

  for (const dayDir of codexSiblingDirs(transcriptPath)) {
    let names;
    try { names = readdirSync(dayDir); } catch { continue; }
    for (const n of names) {
      if (!/\.jsonl$/i.test(n)) continue;
      const f = join(dayDir, n);
      if (f === transcriptPath) continue;
      const sib = readRolloutMeta(f);
      if (!sib?.source?.subagent) continue;
      const parent = sib.parent_thread_id || sib.source.subagent.thread_spawn?.parent_thread_id || '';
      if (parent !== canonicalId) continue;

      const summary = summarizeTokenUsage(parseTokenUsageFromTranscript(f));
      if (!summary.calls) continue;
      const tokens = tokensTotal(summary.totals);
      for (const t of summary.tools) allTools.add(t);

      subagents.push({
        id: String(sib.id || basename(f, '.jsonl')).slice(0, 12),
        agentType: sib.source.subagent.thread_spawn?.agent_nickname || 'codex-subagent',
        workflow: null,
        model: summary.models[0] || '?',
        effort: summary.pensamento || '',
        tools: summary.tools.length,
        toolNames: summary.tools,
        calls: summary.calls,
        tokens,
        cost: round4(summary.costs.model),
        modelRows: summary.modelRows,
      });

      for (const row of summary.modelRows || []) {
        const rowEffort = summary.pensamento || '';
        const key = `${row.provider || '?'}\u0000${row.model || '?'}\u0000${rowEffort}`;
        const current = modelMap.get(key) || { provider: row.provider || '?', model: row.model || '?', effort: rowEffort, calls: 0, tokens: 0, cost: 0,
          usage: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 } };
        current.calls += row.calls || 0;
        current.tokens += tokensTotal(row.usage);
        current.cost += row.costs?.model || 0;
        for (const k of Object.keys(current.usage)) current.usage[k] += row.usage?.[k] || 0;
        modelMap.set(key, current);
      }

      count += 1;
      calls += summary.calls;
      cost += summary.costs.model;
      for (const k of Object.keys(usageAgg)) usageAgg[k] += summary.totals[k] || 0;
    }
  }

  if (!count) return null;
  return {
    subagents,
    workflows: [],
    aggregate: { count, calls, tokens: tokensTotal(usageAgg), cost: round4(cost), wasted: 0, usage: usageAgg, tools: [...allTools],
      modelRows: [...modelMap.values()].map((r) => ({ ...r, cost: round4(r.cost), source: 'subagent' })),
    },
  };
}

export function collectSubagentUsage(sessionDir) {
  const subDir = join(sessionDir, 'subagents');
  if (!existsSync(subDir)) return null;
  const files = walkAgentJsonl(subDir);
  if (!files.length) return null;

  const nameMap = workflowNameMap(sessionDir);
  const runs = readWorkflowRuns(sessionDir);
  const subagents = [];
  const wf = {};
  const allTools = new Set();
  const usageAgg = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
  let count = 0;
  let calls = 0;
  let cost = 0;
  const modelMap = new Map();

  for (const f of files) {
    const summary = summarizeTokenUsage(parseTokenUsageFromTranscript(f));
    if (!summary.calls) continue;
    const runId = runIdOfPath(f);
    const workflow = runId ? (runs[runId] && runs[runId].name) || nameMap[runId] || runId : null;
    let agentType = '';
    try { agentType = JSON.parse(readFileSync(f.replace(/\.jsonl$/i, '.meta.json'), 'utf8')).agentType || ''; } catch { /* no meta */ }
    const tokens = tokensTotal(summary.totals);
    for (const t of summary.tools) allTools.add(t);

    subagents.push({
      id: basename(f).replace(/^agent-/, '').replace(/\.jsonl$/i, '').slice(0, 12),
      agentType,
      workflow,
      model: summary.models[0] || '?',
      effort: summary.pensamento || '',
      tools: summary.tools.length,
      toolNames: summary.tools,
      calls: summary.calls,
      tokens,
      cost: round4(summary.costs.model),
      modelRows: summary.modelRows,
    });

    for (const row of summary.modelRows || []) {
      const rowEffort = summary.pensamento || '';
      const key = `${row.provider || '?'}\u0000${row.model || '?'}\u0000${rowEffort}`;
      const current = modelMap.get(key) || { provider: row.provider || '?', model: row.model || '?', effort: rowEffort, calls: 0, tokens: 0, cost: 0,
        usage: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 } };
      current.calls += row.calls || 0;
      current.tokens += tokensTotal(row.usage);
      current.cost += row.costs?.model || 0;
      for (const k of Object.keys(current.usage)) current.usage[k] += row.usage?.[k] || 0;
      modelMap.set(key, current);
    }

    count += 1;
    calls += summary.calls;
    cost += summary.costs.model;
    for (const k of Object.keys(usageAgg)) usageAgg[k] += summary.totals[k] || 0;
    if (runId) {
      wf[runId] = wf[runId] || { agents: 0, cost: 0 };
      wf[runId].agents += 1;
      wf[runId].cost += summary.costs.model;
    }
  }
  if (!count) return null;

  // Merge transcript-derived cost with the authoritative run metadata (status/phases/duration).
  const runIds = new Set([...Object.keys(wf), ...Object.keys(runs)]);
  const workflows = [...runIds].map((runId) => {
    const t = wf[runId] || { agents: 0, cost: 0 };
    const r = runs[runId] || {};
    return {
      runId,
      name: r.name || nameMap[runId] || runId,
      status: r.status || '',
      agents: r.agentCount || t.agents,
      cost: round4(t.cost),
      totalTokens: r.totalTokens || 0,
      durationMs: r.durationMs || 0,
      phases: r.phases || [],
    };
  });

  // Wasted spend: cost of workflow runs that did not complete (killed/failed/…). The
  // subagents that ran before the kill still cost money — this makes that visible.
  const WASTE = /^(killed|failed|error|aborted|cancel(l)?ed)$/i;
  const wasted = round4(workflows.filter((w) => WASTE.test(w.status)).reduce((s, w) => s + w.cost, 0));

  return {
    subagents,
    workflows,
    aggregate: { count, calls, tokens: tokensTotal(usageAgg), cost: round4(cost), wasted, usage: usageAgg, tools: [...allTools],
      modelRows: [...modelMap.values()].map((r) => ({ ...r, cost: round4(r.cost), source: 'subagent' })),
    },
  };
}

function workflowLine(w) {
  const parts = [w.runId];
  if (w.status) parts.push(w.status);
  parts.push(`${w.agents} agentes`);
  if (w.phases && w.phases.length) parts.push(`fases: ${w.phases.join(', ')}`);
  if (w.durationMs) parts.push(`${Math.round(w.durationMs / 1000)}s`);
  parts.push(usd(w.cost));
  return `${w.name} (${parts.join(' · ')})`;
}

export function renderSubagentSection(c) {
  const a = c.aggregate;
  const wf = c.workflows.length ? c.workflows.map(workflowLine).join('; ') : '(nenhum)';
  const tools = a.tools && a.tools.length ? a.tools.join(', ') : '(nenhuma)';
  const rows = c.subagents
    .map((s) => `| ${s.id} | ${s.agentType || '-'} | ${s.workflow || '-'} | ${s.model} | ${s.tools} | ${fmt(s.tokens)} | ${usd(s.cost)} |`)
    .join('\n');
  const wasteLine = a.wasted ? `\n- **Desperdiçado (runs killed/failed):** ${usd(a.wasted)}` : '';
  const combinedLine = c.combined ? `\n- **Sessão completa (main + subagents):** ${fmt(c.combined.tokens)} tokens · ${usd(c.combined.cost)}` : '';
  const modelRows = c.combined?.models?.map((m) => `| ${m.model} | ${m.source} | ${fmt(m.tokens)} | ${usd(m.cost)} |`).join('\n') || '';
  const models = modelRows ? `\n\n### Por modelo (sessão completa)\n\n| Modelo | Origem | Tokens | Custo |\n|---|---|---:|---:|\n${modelRows}` : '';
  return `## Subagents & Workflows

> Custo de subagents/workflows desta sessão, seguido do total combinado e da atribuição por modelo.

- **Subagents:** ${a.count} · ${a.calls} chamadas · ${fmt(a.tokens)} tokens · ${usd(a.cost)}
- **Workflows:** ${wf}
- **Tools (subagents):** ${tools}${wasteLine}${combinedLine}

### Por subagent (${a.count})

| Agent | Tipo | Workflow | Modelo | Tools | Tokens | Custo |
|---|---|---|---|---:|---:|---:|
${rows}${models}`;
}

function setFrontmatterField(content, key, value) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return content;
  const re = new RegExp(`^${key}:.*$`, 'm');
  const line = `${key}: ${value}`;
  const fm = re.test(m[1]) ? m[1].replace(re, line) : `${m[1]}\n${line}`;
  return content.replace(m[0], `---\n${fm}\n---`);
}

function frontmatterNumber(content, key) {
  const m = content.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? Number(String(m[1]).trim().replace(/^["']|["']$/g, '')) || 0 : 0;
}

function upsertSection(content, heading, body) {
  const esc = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${esc}\\n[\\s\\S]*?(?=\\n## |$)`);
  if (re.test(content)) return content.replace(re, `${body}\n`);
  // Âncora ANTES de '## Pendências': o finalize do Stop reescreve o span Pendências→Encerramento
  // inteiro, então qualquer seção inserida lá dentro seria apagada (visto em produção).
  for (const anchor of ['\n## Pendências', '\n## Issues Linear', '\n## Encerramento']) {
    const i = content.indexOf(anchor);
    if (i >= 0) return `${content.slice(0, i)}\n\n${body}\n${content.slice(i)}`;
  }
  return `${content.trimEnd()}\n\n${body}\n`;
}

// Stop-hook entry: scan the session's subagents/workflows, fold into the note. Fail-open.
export function upsertSubagentUsage(sessionPath, transcriptPath, { lockTimeoutMs } = {}) {
  if (!sessionPath || !existsSync(sessionPath)) return false;
  const collected = collectSubagentUsage(sessionDirFromTranscript(transcriptPath));
  if (!collected) return false;
  const a = collected.aggregate;
  const outcome = mutateSessionNote(sessionPath, (original) => {
    // Fail-closed: sem frontmatter íntegro, `setFrontmatterField` viraria no-op silencioso
    // e a gravação só reescreveria conteúdo truncado por cima do original.
    if (!hasSessionFrontmatter(original)) return null;
    let content = original;
    content = setFrontmatterField(content, 'subagents_count', a.count);
    content = setFrontmatterField(content, 'subagents_tokens_total', a.tokens);
    content = setFrontmatterField(content, 'subagents_custo_usd', a.cost);
    content = setFrontmatterField(content, 'subagents_tools', `"${(a.tools || []).join(', ')}"`);
    content = setFrontmatterField(content, 'subagents_wasted_usd', a.wasted || 0);
    content = setFrontmatterField(content, 'tokens_total_incl_subagents', frontmatterNumber(content, 'tokens_total') + a.tokens);
    content = setFrontmatterField(content, 'custo_total_incl_subagents_usd', round4(frontmatterNumber(content, 'custo_modelo_usd') + a.cost));
    let mainRows = [];
    try {
      const main = summarizeTokenUsage(parseTokenUsageFromTranscript(transcriptPath));
      mainRows = (main.modelRows || []).map((r) => ({
        provider: r.provider || '?', model: r.model || '?', source: 'main', calls: r.calls || 0,
        tokens: tokensTotal(r.usage), cost: round4(r.costs?.model || 0),
      }));
    } catch { /* preserve legacy aggregate fallback */ }
    if (!mainRows.length) {
      const mainModel = (content.match(/^custo_modelo_label:\s*["']?([^"'\r\n]+)["']?\s*$/m) || [])[1] || '?';
      mainRows = [{ model: mainModel, source: 'main', cost: round4(frontmatterNumber(content, 'custo_modelo_usd')), tokens: frontmatterNumber(content, 'tokens_total') }];
    }
    const ledger = [...mainRows, ...(a.modelRows || [])];
    collected.combined = {
      tokens: frontmatterNumber(content, 'tokens_total') + a.tokens,
      cost: round4(frontmatterNumber(content, 'custo_modelo_usd') + a.cost),
      models: ledger,
    };
    content = setFrontmatterField(content, 'custo_por_modelo_json', `'${JSON.stringify(ledger).replaceAll("'", "''")}'`);
    return upsertSection(content, '## Subagents & Workflows', renderSubagentSection(collected));
  }, lockTimeoutMs ? { timeoutMs: lockTimeoutMs } : {});
  return outcome.written;
}
