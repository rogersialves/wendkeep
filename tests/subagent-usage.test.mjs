import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionDirFromTranscript, collectSubagentUsage, renderSubagentSection, upsertSubagentUsage } from '../hooks/subagent-usage.mjs';

function agentLine(model, input, output, cacheRead, tool, req) {
  return JSON.stringify({
    type: 'assistant',
    requestId: req,
    message: {
      id: req,
      model,
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 },
      content: [{ type: 'tool_use', id: `${req}-t`, name: tool }],
    },
  });
}

test('sessionDirFromTranscript: strips .jsonl to the sibling dir', () => {
  assert.equal(sessionDirFromTranscript('/a/b/1cd.jsonl'), '/a/b/1cd');
  assert.equal(sessionDirFromTranscript('/a/b/1cd'), '/a/b/1cd');
});

test('collectSubagentUsage: null when no subagents dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-sa0-'));
  try { assert.equal(collectSubagentUsage(dir), null); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('collectSubagentUsage: aggregates subagents, maps workflow name + cost', () => {
  const sd = mkdtempSync(join(tmpdir(), 'wk-sa-'));
  try {
    const wfDir = join(sd, 'subagents', 'workflows', 'wf_abc123');
    mkdirSync(wfDir, { recursive: true });
    // two subagents under the workflow
    writeFileSync(join(wfDir, 'agent-aaa111.jsonl'), [agentLine('claude-opus-4-8', 1000, 500, 2000, 'Read', 'r1'), agentLine('claude-opus-4-8', 800, 300, 1000, 'Grep', 'r2')].join('\n'));
    writeFileSync(join(wfDir, 'agent-aaa111.meta.json'), '{"agentType":"Explore","spawnDepth":1}');
    writeFileSync(join(wfDir, 'agent-bbb222.jsonl'), agentLine('claude-opus-4-8', 500, 200, 0, 'Bash', 'r3'));
    // the workflow script names the run + the run json carries authoritative metadata
    mkdirSync(join(sd, 'workflows', 'scripts'), { recursive: true });
    writeFileSync(join(sd, 'workflows', 'scripts', 'my-audit-wf_abc123.js'), "export const meta = { name: 'my-audit' }\n");
    writeFileSync(join(sd, 'workflows', 'wf_abc123.json'), JSON.stringify({ runId: 'wf_abc123', workflowName: 'my-audit', status: 'completed', agentCount: 2, totalTokens: 5000, durationMs: 42000, phases: [{ title: 'Classify' }, { title: 'Synthesize' }] }));

    const r = collectSubagentUsage(sd);
    assert.equal(r.aggregate.count, 2, 'two subagents');
    assert.equal(r.aggregate.calls, 3, 'three llm calls');
    assert.ok(r.aggregate.tokens > 0, 'tokens summed');
    assert.ok(r.aggregate.cost > 0, 'cost computed from pricing');
    // 0.12.0: tools rollup + workflow run metadata
    assert.deepEqual([...r.aggregate.tools].sort(), ['Bash', 'Grep', 'Read']);
    assert.equal(r.workflows[0].status, 'completed');
    assert.deepEqual(r.workflows[0].phases, ['Classify', 'Synthesize']);
    assert.equal(r.workflows[0].durationMs, 42000);
    // per-subagent: workflow name mapped, model, agentType from meta
    const a = r.subagents.find((s) => s.id === 'aaa111');
    assert.equal(a.workflow, 'my-audit');
    assert.equal(a.agentType, 'Explore');
    assert.equal(a.model, 'claude-opus-4.8'); // normalized (dash -> dot), matches the note
    assert.equal(a.tools, 2, 'distinct tools Read+Grep');
    // workflow rollup
    assert.equal(r.workflows.length, 1);
    assert.equal(r.workflows[0].name, 'my-audit');
    assert.equal(r.workflows[0].agents, 2);

    // render: aggregate line + collapsible per-subagent table
    const md = renderSubagentSection(r);
    assert.match(md, /## Subagents & Workflows/);
    assert.match(md, /\*\*Subagents:\*\* 2 · 3 chamadas/);
    assert.match(md, /completed · 2 agentes · fases: Classify, Synthesize · 42s/);
    assert.match(md, /\*\*Tools \(subagents\):\*\* .*Read/);
    assert.match(md, /<details>/);
    assert.match(md, /\| aaa111 \| Explore \| my-audit \|/);
  } finally { rmSync(sd, { recursive: true, force: true }); }
});

test('upsertSubagentUsage: frontmatter fields + section, idempotent, fail-open', () => {
  const parent = mkdtempSync(join(tmpdir(), 'wk-saup-'));
  try {
    const sd = join(parent, 'sess');
    const wfDir = join(sd, 'subagents', 'workflows', 'wf_x');
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, 'agent-z9.jsonl'), agentLine('claude-opus-4-8', 1000, 500, 2000, 'Read', 'r1'));

    const notePath = join(parent, 'note.md');
    writeFileSync(notePath, '---\ntype: session\ntokens_total: 1000\n---\n\n# x\n\n## Pendências\n\nNenhuma.\n');
    assert.equal(upsertSubagentUsage(notePath, `${sd}.jsonl`), true);
    let out = readFileSync(notePath, 'utf8');
    assert.match(out, /subagents_count: 1/);
    assert.match(out, /tokens_total_incl_subagents: 4500/); // 1000 main + 3500 sub
    assert.match(out, /## Subagents & Workflows/);
    // idempotent: single section on re-run
    upsertSubagentUsage(notePath, `${sd}.jsonl`);
    out = readFileSync(notePath, 'utf8');
    assert.equal((out.match(/## Subagents & Workflows/g) || []).length, 1, 'no duplicate section');
    assert.match(out, /## Pendências/, 'existing section preserved');
    // fail-open: no subagents -> false, note untouched
    const bare = join(parent, 'bare');
    assert.equal(upsertSubagentUsage(notePath, `${bare}.jsonl`), false);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
