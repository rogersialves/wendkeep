import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSessionMemoryEvents, collectLifecycleEvidence } from '../hooks/memory-handoff.mjs';

const context = {
  projectId: 'vendiva',
  identity: { canonicalConversationId: 'session-1', provider: 'codex' },
  activation: { id: 'act-7', epoch: 7 },
  turn: { id: 'turn-final', sequence: 42 },
  noteRel: '02-Sessões/2026/07-JUL/DIA 25/22-22-files-mentioned-by-the-user.md',
  observedAt: '2026-07-26T03:20:47Z',
};

test('[req:MEM-HYB-1] the final handoff is always preserved as reported with source provenance', () => {
  const events = buildSessionMemoryEvents({
    ...context,
    summary: 'Concluído; PASSWORD=hunter2. Commit local; nenhum push. C:\\Users\\Roger\\rollout.jsonl',
    evidence: {},
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].memory_key, 'handoff.latest');
  assert.equal(events[0].authority, 'reported');
  assert.equal(events[0].canonical_session_id, 'session-1');
  assert.equal(events[0].activation_id, 'act-7');
  assert.equal(events[0].turn_sequence, 42);
  assert.deepEqual(events[0].evidence, [context.noteRel]);
  assert.doesNotMatch(JSON.stringify(events[0]), /hunter2|C:\\\\Users|rollout\.jsonl/);
});

test('[req:MEM-HYB-1] lifecycle facts become separate verified events only with local evidence', () => {
  const events = buildSessionMemoryEvents({
    ...context,
    summary: 'ADR-0107 arquivada; verdict 7/7; próxima change: interface de revisão.',
    evidence: {
      change: { slug: 'campanhas-importacao', status: 'archived', adr: 'ADR-0107' },
      verdict: { ok: true, covered: 7, total: 7, path: 'verdict.json' },
      sensors: ['backend-unit', 'contracts-openapi', 'campaign-import-backend'],
      git: { commit: '9fbbbb1bdad630cd4145ea4a916ef8f240ed603f', pushed: false },
      nextAction: { id: 'campaign-review-ui', summary: 'Criar interface de revisão' },
    },
  });

  const byKey = new Map(events.map((event) => [event.memory_key, event]));
  assert.equal(byKey.get('change.campanhas-importacao.status').value.status, 'archived');
  assert.equal(byKey.get('change.campanhas-importacao.status').authority, 'verified');
  assert.deepEqual(byKey.get('quality.latest-verdict').value, { ok: true, covered: 7, total: 7 });
  assert.equal(byKey.get('git.local-head').value.pushed, false);
  assert.equal(byKey.get('next.campaign-review-ui').value, 'Criar interface de revisão');
  assert.ok(events.filter((event) => event.authority === 'verified').every((event) => event.evidence.length > 0));
});

test('[req:MEM-HYB-1] archived change evidence is resolved from the vault, not trusted from prose alone', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-handoff-evidence-'));
  const archived = join(vault, '08-Mudanças', '_arquivo', '2026-07-25-campanhas-importacao');
  const decisions = join(vault, '04-Decisões', '2026', '07-JUL');
  mkdirSync(archived, { recursive: true });
  mkdirSync(decisions, { recursive: true });
  writeFileSync(join(archived, 'verdict.json'), JSON.stringify({
    ok: true,
    coverage: Array.from({ length: 7 }, (_, index) => ({ req: `R-${index + 1}`, covered: true })),
  }));
  writeFileSync(join(archived, 'evidencia.json'), JSON.stringify([
    { id: 'backend-unit', status: 'green' },
    { id: 'contracts-openapi', status: 'green' },
    { id: 'campaign-import-backend', status: 'green' },
  ]));
  writeFileSync(join(decisions, 'ADR-0107-campanhas-importacao.md'), '# ADR-0107');

  const evidence = collectLifecycleEvidence(vault, {
    changeSlug: 'campanhas-importacao',
    summary: 'Concluído. A próxima change será a interface de revisão.',
    noteRel: context.noteRel,
  });

  assert.deepEqual(evidence.change, {
    slug: 'campanhas-importacao',
    status: 'archived',
    adr: 'ADR-0107',
    path: '04-Decisões/2026/07-JUL/ADR-0107-campanhas-importacao.md',
  });
  assert.equal(evidence.verdict.ok, true);
  assert.equal(evidence.verdict.covered, 7);
  assert.equal(evidence.verdict.total, 7);
  assert.deepEqual(evidence.sensors, ['backend-unit', 'campaign-import-backend', 'contracts-openapi']);
  assert.equal(evidence.nextAction.summary, 'interface de revisão');
});
