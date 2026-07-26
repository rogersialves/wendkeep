import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInjection } from '../hooks/brain-inject.mjs';

const CORE = `# CORE

## Preferências do Usuário
- responder em pt-BR

## Padrões Ativos
- CORE_CANONICAL_DIRECT

## Pendências Abertas
- não perder [[SHARED_MEMORY]]
`;

const SECTIONS = [
  'Objetivo Atual',
  'Estado Entregue',
  'Restrições Ativas',
  'Decisões em Vigor',
  'Próximas Ações',
  'Bloqueios',
  'Riscos Conhecidos',
  'Último Handoff',
];

function sharedMemory({ revision = 7, hash = 'sha256-state-7', extra = [] } = {}) {
  const body = SECTIONS.flatMap((section) => [
    `## ${section}`,
    section === 'Bloqueios'
      ? '- blocker.latest [verified] Não publicar antes da revisão humana.'
      : section === 'Próximas Ações'
        ? '- next.review [verified] Criar interface de revisão.'
        : section === 'Último Handoff'
          ? '- handoff.latest [reported] ADR-0107, verdict 7/7, E2E verde e commit sem push.'
          : '- (vazio)',
    '',
  ]);
  body.splice(body.indexOf('## Último Handoff'), 0, ...extra);
  return `---
schema_version: 2
revision: ${revision}
event_cursor: mem-007
state_hash: ${hash}
updated_at: 2026-07-26T03:20:47Z
review_after: 2026-08-02T03:20:47Z
---
${body.join('\n')}`;
}

function makeVault({ core = CORE, shared = sharedMemory(), digest = 'DIGEST_RECALL_ONLY' } = {}) {
  const vault = mkdtempSync(join(tmpdir(), 'wk-memory-inject-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  writeFileSync(join(vault, '.brain', 'CORE.md'), core, 'utf8');
  if (shared !== null) writeFileSync(join(vault, '.brain', 'SHARED_MEMORY.md'), shared, 'utf8');
  writeFileSync(join(vault, '.brain', 'DIGEST.md'), digest, 'utf8');
  return vault;
}

test('[req:MEM-HYB-2] [req:HOOK-MEM-1] startup, clear and compact receive the same direct CORE+SHARED revision before session change', () => {
  const vault = makeVault();
  try {
    const sessionId = '019f9d92-f15f-77b1-bd81-668b4875522f';
    mkdirSync(join(vault, '08-Mudanças', 'memory-v2'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'memory-v2', 'proposta.md'), '# memory-v2\n');
    writeFileSync(join(vault, '08-Mudanças', 'memory-v2', 'tarefas.md'), '- [ ] 1.1 manter blocker\n');
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: memory-v2\n');
    writeFileSync(join(vault, '.brain', 'SESSION_REGISTRY.json'), JSON.stringify({
      version: 2,
      sessions: {
        [sessionId]: {
          provider: 'codex',
          transcript_path: join(vault, 'rollout.jsonl'),
          transcript_id: sessionId,
          change_slug: 'memory-v2',
        },
      },
    }));

    const outputs = ['startup', 'clear', 'compact'].map((source) => buildInjection(vault, {
      source,
      session_id: sessionId,
      codex_thread_id: sessionId,
    }));
    assert.equal(new Set(outputs).size, 1, 'the lifecycle event does not alter the memory snapshot');
    for (const out of outputs) {
      assert.match(out, /<brain_memory version="2" revision="7" state_hash="sha256-state-7">/);
      assert.match(out, /<wk_core authority="canonical">[\s\S]*CORE_CANONICAL_DIRECT[\s\S]*<\/wk_core>/);
      assert.match(out, /<wk_shared_state authority="operational">[\s\S]*blocker\.latest[\s\S]*handoff\.latest[\s\S]*<\/wk_shared_state>/);
      assert.doesNotMatch(out, /DIGEST_RECALL_ONLY/, 'DIGEST content is not operational state in v2');
      assert.ok(out.indexOf('<wk_core') < out.indexOf('<session_change>'));
      assert.ok(out.indexOf('<wk_shared_state') < out.indexOf('<session_change>'));
    }
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-HYB-6] invalid CORE or SHARED is replaced atomically by wk_memory_error, never a silent prefix slice', () => {
  const oversizedCore = `${CORE.trimEnd()}\n${Array.from({ length: 20 }, (_, i) => `- core-overflow-${i}`).join('\n')}\n`;
  const oversizedShared = sharedMemory({
    extra: Array.from({ length: 30 }, (_, i) => `- shared-overflow-${i}`),
  });
  const vault = makeVault({ core: oversizedCore, shared: oversizedShared });
  try {
    const out = buildInjection(vault, { source: 'startup' });
    assert.match(out, /<wk_memory_error layer="core"[^>]*>/);
    assert.match(out, /<wk_memory_error layer="shared"[^>]*>/);
    assert.doesNotMatch(out, /core-overflow-0/, 'no CORE prefix leaked');
    assert.doesNotMatch(out, /shared-overflow-0/, 'no SHARED prefix leaked');
    assert.match(out, /<\/brain_memory>/, 'outer wrapper remains closed');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-HYB-6] [req:MEM-HYB-7] global pressure drops lessons then non-current changes while preserving the current blocker and 24 KiB envelope', () => {
  const coreLines = [
    '# CORE', '', '## Preferências do Usuário', '- pt-BR', '', '## Padrões Ativos', '- canonical', '',
    '## Pendências Abertas', ...Array.from({ length: 16 }, (_, i) => `- durable-${i}`),
  ];
  assert.equal(coreLines.length, 25);
  const coreAtLimit = `${coreLines.join('\n')}\n`;
  const baseShared = sharedMemory();
  const fillCount = 48 - baseShared.trimEnd().split('\n').length;
  const fullShared = sharedMemory({
    extra: Array.from({ length: fillCount }, (_, i) => (
      `- shared-fill-${i} ${'s'.repeat(240)}${i === fillCount - 1 ? ' SHARED_TAIL_MUST_SURVIVE' : ''}`
    )),
  });
  assert.equal(fullShared.trimEnd().split('\n').length, 48, 'SHARED exactly reaches its line budget');
  assert.ok(Buffer.byteLength(fullShared, 'utf8') <= 6 * 1024, 'SHARED remains inside its byte budget');
  const vault = makeVault({ core: coreAtLimit, shared: fullShared });
  try {
    mkdirSync(join(vault, '.brain', 'lessons'), { recursive: true });
    for (let i = 0; i < 12; i += 1) {
      writeFileSync(join(vault, '.brain', 'lessons', `2026-07-${String(i + 1).padStart(2, '0')}-x.md`), `---\ntype: lesson\n---\n${'lesson-pressure '.repeat(80)}\n`);
    }
    for (const slug of ['current', 'other-a', 'other-b']) {
      mkdirSync(join(vault, '08-Mudanças', slug), { recursive: true });
      writeFileSync(join(vault, '08-Mudanças', slug, 'proposta.md'), `# ${slug}\n`);
      const tasks = slug === 'current'
        ? `- [ ] 1.1 BLOCKER_MUST_SURVIVE\n${Array.from({ length: 90 }, (_, i) => `- [ ] 2.${i} current pressure ${'x'.repeat(220)}`).join('\n')}\n`
        : `${Array.from({ length: 90 }, (_, i) => `- [ ] 3.${i} NON_CURRENT_${slug}_${i} ${'x'.repeat(220)}`).join('\n')}\n`;
      writeFileSync(join(vault, '08-Mudanças', slug, 'tarefas.md'), tasks);
    }
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: current\n');

    const out = buildInjection(vault, { source: 'compact' });
    assert.ok(out.includes(coreAtLimit.trim()), 'CORE at the exact limit remains byte-for-byte integral');
    assert.ok(out.includes(fullShared.trim()), 'full SHARED remains byte-for-byte integral');
    assert.match(out, /BLOCKER_MUST_SURVIVE/);
    assert.match(out, /<\/open_changes>/);
    assert.doesNotMatch(out, /lesson-pressure/, 'lessons are evicted');
    assert.doesNotMatch(out, /NON_CURRENT_other-[ab]_/, 'non-current changes are evicted after lessons');
    assert.match(out, /conteúdo restante omitido pelo budget de injeção/i, 'current change is summarized explicitly');

    const lessonsNotice = out.indexOf('<wk_budget_notice priority="1" layer="lessons">');
    const nonCurrentNotice = out.indexOf('<wk_budget_notice priority="2" layer="non-current-changes">');
    const currentNotice = out.indexOf('<wk_budget_notice priority="3" layer="current-change">');
    assert.ok(lessonsNotice >= 0, 'eviction stage 1 is observable');
    assert.ok(nonCurrentNotice > lessonsNotice, 'non-current eviction is observably second');
    assert.ok(currentNotice > nonCurrentNotice, 'current summarization is observably last');
    assert.ok(Buffer.byteLength(out, 'utf8') <= 24 * 1024, `actual=${Buffer.byteLength(out, 'utf8')}`);
    assert.ok(out.split('\n').every((line) => line.length <= 320), 'every injected line respects the line budget');
    assert.match(out, /<\/wk_core>[\s\S]*<\/wk_shared_state>[\s\S]*<\/brain_memory>/, 'critical wrappers remain closed');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-HYB-8] reinjection sanitizes secrets, transcript paths and harness blocks before output', () => {
  const shared = sharedMemory().replace(
    '- handoff.latest [reported] ADR-0107, verdict 7/7, E2E verde e commit sem push.',
    String.raw`- handoff.latest [reported] TOKEN=hunter2 C:\Users\me\.codex\sessions\rollout.jsonl <recommended_plugins>private payload</recommended_plugins>`,
  );
  const vault = makeVault({ shared });
  try {
    const out = buildInjection(vault, { source: 'clear' });
    assert.doesNotMatch(out, /hunter2|C:\\Users|rollout\.jsonl|recommended_plugins|private payload/i);
    assert.match(out, /wk_memory_error|REDACTED/, 'unsafe material is made visibly safe');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-HYB-9] a legacy vault keeps CORE+DIGEST for one release with an explicit deprecation warning', () => {
  const vault = makeVault({ shared: null, digest: '- legacy decision [[ADR-0001]]' });
  try {
    const out = buildInjection(vault, { source: 'startup' });
    assert.match(out, /<brain_memory>/);
    assert.match(out, /CORE_CANONICAL_DIRECT/);
    assert.match(out, /legacy decision/);
    assert.match(out, /legacy|deprecat|migra/i);
    assert.doesNotMatch(out, /version="2"/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
