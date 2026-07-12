// Single atomic writer for session usage, models, reasoning/effort and subagents.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { collectSessionUsage } from './token-usage.mjs';
import { collectSubagentUsage, sessionDirFromTranscript } from './subagent-usage.mjs';
import { inspectTranscriptIdentity } from './session-identity.mjs';

const HEADING = '## Agentes, tokens e custos';
const LEGACY_HEADINGS = ['## Uso de tokens e custos', '## Subagents & Workflows'];
const fmt = (n) => Math.trunc(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const usd = (n) => `$${(Number(n) || 0).toFixed(4)}`;
const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const effort = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return ['none', 'low', 'medium', 'high', 'xhigh', 'thinking'].includes(normalized) ? normalized : (normalized || 'unknown');
};
const usageTotal = (u = {}) => Number(u.total || 0) || (Number(u.input || 0) + Number(u.cached || 0) + Number(u.cacheWrite || 0) + Number(u.output || 0));

function setFrontmatterField(content, key, value) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return content;
  const re = new RegExp(`^${key}:.*$`, 'm');
  const line = `${key}: ${value}`;
  const body = re.test(match[1]) ? match[1].replace(re, line) : `${match[1]}\n${line}`;
  return content.replace(match[0], `---\n${body}\n---`);
}

function removeSection(content, heading, { preserveOrphanIterations = false } = {}) {
  const start = content.indexOf(`\n${heading}`);
  if (start < 0) return content;
  const next = content.indexOf('\n## ', start + heading.length + 1);
  const body = next < 0 ? content.slice(start) : content.slice(start, next);
  const orphanAt = preserveOrphanIterations ? body.search(/\n### \d{2}:\d{2} - /) : -1;
  const preserved = orphanAt >= 0 ? body.slice(orphanAt).trim() : '';
  const rest = next < 0 ? '' : content.slice(next + 1).trimStart();
  return [content.slice(0, start).trimEnd(), preserved, rest].filter(Boolean).join('\n\n').trimEnd() + '\n';
}

export function upsertObservabilitySection(content, section) {
  let base = content;
  base = removeSection(base, HEADING);
  base = removeSection(base, LEGACY_HEADINGS[0], { preserveOrphanIterations: true });
  base = removeSection(base, LEGACY_HEADINGS[1]);
  const anchors = ['\n## Pendências', '\n## Issues Linear', '\n## Encerramento'];
  const indexes = anchors.map((a) => base.indexOf(a)).filter((i) => i >= 0).sort((a, b) => a - b);
  if (!indexes.length) return `${base.trimEnd()}\n\n${section.trimEnd()}\n`;
  const at = indexes[0];
  return `${base.slice(0, at).trimEnd()}\n\n${section.trimEnd()}\n\n${base.slice(at).trimStart()}`;
}

function mainLedger(main) {
  return (main.summary.modelRows || []).map((row) => ({
    provider: row.provider || 'unknown', model: row.model || 'unknown', source: 'main',
    effort: effort(main.summary.pensamento), calls: row.calls || 0,
    input: row.usage.input || 0, cacheWrite: row.usage.cacheWrite || 0, cached: row.usage.cached || 0,
    output: row.usage.output || 0, reasoning: row.usage.reasoning || 0, total: usageTotal(row.usage),
    cost: round4(row.costs?.model || 0),
  }));
}

function subagentLedger(collected) {
  return (collected?.aggregate.modelRows || []).map((row) => ({
    provider: row.provider || 'unknown', model: row.model || 'unknown', source: 'subagent',
    effort: effort(row.effort), calls: row.calls || 0,
    input: row.usage?.input || 0, cacheWrite: row.usage?.cacheWrite || 0, cached: row.usage?.cached || 0,
    output: row.usage?.output || 0, reasoning: row.usage?.reasoning || 0, total: usageTotal(row.usage || row),
    cost: round4(row.cost || 0),
  }));
}

function renderLedger(rows) {
  if (!rows.length) return 'Nenhum modelo registrado.';
  return ['| Modelo | Provider | Origem | Effort | Chamadas | Input | Cache W | Cache R | Output | Reasoning | Total | Custo |',
    '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map((r) => `| ${r.model} | ${r.provider} | ${r.source} | ${r.effort} | ${fmt(r.calls)} | ${fmt(r.input)} | ${fmt(r.cacheWrite)} | ${fmt(r.cached)} | ${fmt(r.output)} | ${fmt(r.reasoning)} | ${fmt(r.total)} | ${usd(r.cost)} |`),
  ].join('\n');
}

function renderHistory(entries) {
  if (!entries.length) return 'Nenhuma reabertura registrada.';
  return ['| Transcript | Modelo(s) | Effort | Input | Cache W | Cache R | Output | Reasoning | Total | Custo | Atualizado |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|',
    ...entries.map((e) => `| ${String(e.transcript_id).slice(0, 12)}… | ${(e.modelos || []).join(' + ')} | ${effort(e.pensamento)} | ${fmt(e.input)} | ${fmt(e.cache_write)} | ${fmt(e.cache_read)} | ${fmt(e.output)} | ${fmt(e.reasoning)} | ${fmt(e.total)} | ${usd(e.custo_usd)} | ${e.atualizado_em || ''} |`),
  ].join('\n');
}

function renderSubagents(collected) {
  if (!collected) return '### Subagents e workflows\n\nNenhum subagent registrado.';
  const a = collected.aggregate;
  const workflows = collected.workflows.length
    ? collected.workflows.map((w) => `${w.name} (${w.runId}${w.status ? ` · ${w.status}` : ''} · ${w.agents} agentes · ${usd(w.cost)})`).join('; ')
    : '(nenhum)';
  const rows = collected.subagents.map((s) => `| ${s.id} | ${s.agentType || '-'} | ${s.workflow || '-'} | ${s.model} | ${effort(s.effort)} | ${s.tools} | ${fmt(s.tokens)} | ${usd(s.cost)} |`).join('\n');
  return `### Subagents e workflows

- **Subagents:** ${a.count} · ${a.calls} chamadas · ${fmt(a.tokens)} tokens · ${usd(a.cost)}
- **Workflows:** ${workflows}
- **Tools:** ${(a.tools || []).join(', ') || '(nenhuma)'}${a.wasted ? `\n- **Desperdiçado:** ${usd(a.wasted)}` : ''}

#### Por subagent (${a.count})

| Agent | Tipo | Workflow | Modelo | Effort | Tools | Tokens | Custo |
|---|---|---|---|---|---:|---:|---:|
${rows}`;
}

export function renderSessionObservability(snapshot) {
  const { main, subagents, ledger } = snapshot;
  const sub = subagents?.aggregate || { count: 0, tokens: 0, cost: 0 };
  const combinedTokens = main.aggregate.total + sub.tokens;
  const combinedCost = round4(main.aggregate.custo + sub.cost);
  return `${HEADING}

> Estimativa API-equivalente baseada nos transcripts locais. Reasoning e effort são observacionais e não acrescentam tarifa separada.

| Métrica | Principal | Subagents | Total |
|---|---:|---:|---:|
| Chamadas com uso | ${fmt(main.aggregate.calls)} | ${fmt(sub.calls)} | ${fmt(main.aggregate.calls + (sub.calls || 0))} |
| Input tokens | ${fmt(main.aggregate.input)} | ${fmt(sub.usage?.input)} | ${fmt(main.aggregate.input + (sub.usage?.input || 0))} |
| Cache write | ${fmt(main.aggregate.cacheWrite)} | ${fmt(sub.usage?.cacheWrite)} | ${fmt(main.aggregate.cacheWrite + (sub.usage?.cacheWrite || 0))} |
| Cache read | ${fmt(main.aggregate.cached)} | ${fmt(sub.usage?.cached)} | ${fmt(main.aggregate.cached + (sub.usage?.cached || 0))} |
| Output tokens | ${fmt(main.aggregate.output)} | ${fmt(sub.usage?.output)} | ${fmt(main.aggregate.output + (sub.usage?.output || 0))} |
| Reasoning tokens | ${fmt(main.aggregate.reasoning)} | ${fmt(sub.usage?.reasoning)} | ${fmt(main.aggregate.reasoning + (sub.usage?.reasoning || 0))} |
| Total tokens | ${fmt(main.aggregate.total)} | ${fmt(sub.tokens)} | ${fmt(combinedTokens)} |
| Custo estimado | ${usd(main.aggregate.custo)} | ${usd(sub.cost)} | ${usd(combinedCost)} |

### Por modelo e origem

${renderLedger(ledger)}

### Por reabertura

${renderHistory(main.entries)}

${renderSubagents(subagents)}`;
}

export function buildSessionObservability({ sessionContent, transcriptPath }) {
  const main = collectSessionUsage({ sessionContent, transcriptPath });
  if (!main) return null;
  const subagents = collectSubagentUsage(sessionDirFromTranscript(transcriptPath));
  const ledger = [...mainLedger(main), ...subagentLedger(subagents)];
  const sub = subagents?.aggregate || { count: 0, tokens: 0, cost: 0, wasted: 0, tools: [] };
  let content = main.content;
  content = setFrontmatterField(content, 'subagents_count', sub.count || 0);
  content = setFrontmatterField(content, 'subagents_tokens_total', sub.tokens || 0);
  content = setFrontmatterField(content, 'subagents_custo_usd', sub.cost || 0);
  content = setFrontmatterField(content, 'subagents_tools', `"${(sub.tools || []).join(', ')}"`);
  content = setFrontmatterField(content, 'subagents_wasted_usd', sub.wasted || 0);
  content = setFrontmatterField(content, 'tokens_total_incl_subagents', main.aggregate.total + (sub.tokens || 0));
  content = setFrontmatterField(content, 'custo_total_incl_subagents_usd', round4(main.aggregate.custo + (sub.cost || 0)));
  content = setFrontmatterField(content, 'observability_schema', 1);
  content = setFrontmatterField(content, 'custo_por_modelo_json', `'${JSON.stringify(ledger).replaceAll("'", "''")}'`);
  const snapshot = { version: 1, main, subagents, ledger };
  return { snapshot, content: upsertObservabilitySection(content, renderSessionObservability(snapshot)) };
}

export function updateSessionObservability({ sessionPath, transcriptPath, caller = 'unknown', canonicalConversationId = '' }) {
  if (!sessionPath || !existsSync(sessionPath)) return null;
  const sessionContent = readFileSync(sessionPath, 'utf8');
  const noteProvider = sessionContent.match(/^provider:\s*"?([^"\n]+)"?/m)?.[1]?.trim() || 'unknown';
  const identity = inspectTranscriptIdentity(transcriptPath);
  if ((noteProvider === 'codex' && identity.transcriptProvider !== 'openai')
    || (noteProvider === 'claude' && identity.transcriptProvider !== 'anthropic')) {
    throw new Error(`observability provider mismatch: note=${noteProvider}, transcript=${identity.transcriptProvider}`);
  }
  let annotated = setFrontmatterField(sessionContent, 'observability_caller', `"${caller}"`);
  annotated = setFrontmatterField(annotated, 'observability_session_id', `"${canonicalConversationId || identity.canonicalConversationId || ''}"`);
  annotated = setFrontmatterField(annotated, 'observability_transcript_id', `"${identity.transcriptId || ''}"`);
  if (!/^observability_updated_at:/m.test(annotated)) {
    annotated = setFrontmatterField(annotated, 'observability_updated_at', `"${new Date().toISOString()}"`);
  }
  const result = buildSessionObservability({ sessionContent: annotated, transcriptPath });
  if (!result) return null;
  writeFileSync(sessionPath, result.content, 'utf8');
  return result.snapshot;
}
