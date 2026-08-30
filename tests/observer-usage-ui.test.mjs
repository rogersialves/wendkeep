import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUsageViewModel,
  loadProjectUsage,
} from '../web/observer/app.mjs';

function jsonResponse(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

test('[req:OBS-SEC-UI] cliente carrega consumo por projeto com filtros e bearer explícito', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/usage/summary')) return jsonResponse({ project_id: 'project-a', cost_usd: 1.25, tokens: { total: 100 }, coverage: { complete: 1, summary_only: 2 } });
    if (url.includes('/usage/breakdown')) return jsonResponse({ project_id: 'project-a', agents: [] });
    return jsonResponse({ project_id: 'project-a', calls: [], total: 0 });
  };
  const usage = await loadProjectUsage(fetchImpl, 'project-a', { from: '2026-08-01', role: 'subagent', model: 'gpt-5.6-luna' }, 'usage-secret');
  assert.equal(usage.summary.cost_usd, 1.25);
  assert.equal(calls.length, 3);
  assert.equal(calls.every(({ options }) => options.headers.Authorization === 'Bearer usage-secret'), true);
  assert.equal(calls.every(({ url }) => url.includes('from=2026-08-01') && url.includes('role=subagent') && url.includes('model=gpt-5.6-luna')), true);
});

test('[req:SQL-OBS-7] view model preserva cobertura, alerta de tarifa e hierarquia', () => {
  const view = buildUsageViewModel({
    summary: {
      cost_usd: 1.25,
      main_cost_usd: 1,
      subagent_cost_usd: 0.25,
      wasted_usd: 0.1,
      calls: 3,
      sessions: 2,
      agents: 2,
      subagents: 1,
      models: 2,
      unknown_priced_rollups: 1,
      tokens: { input: 10, cache_write: 2, cache_read: 3, output: 20, reasoning: 5, total: 40 },
      coverage: { transcripts: 3, complete: 1, summary_only: 2 },
      by_day: [{ date: '2026-08-17', cost_usd: 1.25, tokens_total: 40, calls: 3 }],
    },
    breakdown: { agents: [{ agent_id: 'a', role: 'main', agent_name: 'codex', models: [{ model: 'gpt-5.6-luna', cost_usd: 1, tokens_total: 30 }] }] },
    calls: { calls: [{ call_id: 'call-1', transcript_id: 'tx-1', prompt: 'pergunta', response: 'resposta' }] },
  });
  assert.equal(view.totalCost, 1.25);
  assert.equal(view.coverage.label, '1 completo · 2 agregados');
  assert.equal(view.hasUnknownPricing, true);
  assert.equal(view.agents[0].models[0].model, 'gpt-5.6-luna');
  assert.equal(view.calls[0].prompt, 'pergunta');
});
