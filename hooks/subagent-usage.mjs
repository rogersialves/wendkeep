// hooks/subagent-usage.mjs — capture subagent + workflow telemetry (0.10.0). The Stop hook
// only reads the MAIN transcript; a session that spawns subagents/workflows (e.g. a Workflow
// run) burns tokens in sibling transcripts the note never recorded. This scans them.
// Reuses token-usage.mjs's parser. Provider-gated by structure (Claude Code layout).
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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
  return (t.input || 0) + (t.cached || 0) + (t.cacheWrite || 0) + (t.output || 0);
}

const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

// Aggregate every subagent transcript under <sessionDir>/subagents. null when the dir is
// absent (Codex / a session with no subagents) or nothing parseable.
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
  const usageAgg = { input: 0, cached: 0, cacheWrite: 0, output: 0 };
  let count = 0;
  let calls = 0;
  let cost = 0;

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
      tools: summary.tools.length,
      toolNames: summary.tools,
      calls: summary.calls,
      tokens,
      cost: round4(summary.costs.model),
    });

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

  return {
    subagents,
    workflows,
    aggregate: { count, calls, tokens: tokensTotal(usageAgg), cost: round4(cost), usage: usageAgg, tools: [...allTools] },
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
  return `## Subagents & Workflows

> Custo de subagents/workflows desta sessão — NÃO incluído no total principal acima.

- **Subagents:** ${a.count} · ${a.calls} chamadas · ${fmt(a.tokens)} tokens · ${usd(a.cost)}
- **Workflows:** ${wf}
- **Tools (subagents):** ${tools}

<details><summary>Por subagent (${a.count})</summary>

| Agent | Tipo | Workflow | Modelo | Tools | Tokens | Custo |
|---|---|---|---|---:|---:|---:|
${rows}

</details>`;
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
  for (const anchor of ['\n## Encerramento', '\n## Issues Linear', '\n## Pendências']) {
    const i = content.indexOf(anchor);
    if (i >= 0) return `${content.slice(0, i)}\n\n${body}\n${content.slice(i)}`;
  }
  return `${content.trimEnd()}\n\n${body}\n`;
}

// Stop-hook entry: scan the session's subagents/workflows, fold into the note. Fail-open.
export function upsertSubagentUsage(sessionPath, transcriptPath) {
  if (!sessionPath || !existsSync(sessionPath)) return false;
  const collected = collectSubagentUsage(sessionDirFromTranscript(transcriptPath));
  if (!collected) return false;
  const a = collected.aggregate;
  let content = readFileSync(sessionPath, 'utf8');
  content = setFrontmatterField(content, 'subagents_count', a.count);
  content = setFrontmatterField(content, 'subagents_tokens_total', a.tokens);
  content = setFrontmatterField(content, 'subagents_custo_usd', a.cost);
  content = setFrontmatterField(content, 'subagents_tools', `"${(a.tools || []).join(', ')}"`);
  content = setFrontmatterField(content, 'tokens_total_incl_subagents', frontmatterNumber(content, 'tokens_total') + a.tokens);
  content = upsertSection(content, '## Subagents & Workflows', renderSubagentSection(collected));
  writeFileSync(sessionPath, content, 'utf8');
  return true;
}
