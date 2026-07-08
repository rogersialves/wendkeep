// 0.22.0 — fixes for audit-confirmed bugs (each survived an adversarial refuter).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { priceForModel } from '../hooks/token-usage.mjs';
import { parseClaudeTranscript } from '../hooks/session-stop.mjs';
import { discoverCodexTranscripts } from '../hooks/import-sessions.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

function fill(vault, slug) {
  writeFileSync(join(vault, '08-Mudanças', slug, 'proposta.md'), `---\ntype: change\nstatus: active\ndate: 2026-05-01\nspecs: []\n---\n\n# ${slug}\n\n## Por quê\n\nX.\n\n## O que muda\n\nY.\n`);
  writeFileSync(join(vault, '08-Mudanças', slug, 'design.md'), `# ${slug} — design\n\n## Abordagem\n\nZ.\n`);
}

// --- item 6: pricing / [1m] normalization ------------------------------------
test('priceForModel: strips a [1m] context tag and prices claude-sonnet-5', () => {
  assert.ok(priceForModel('claude-opus-4-8[1m]'), 'opus-4.8 1M variant is priced (not $0)');
  assert.ok(priceForModel('claude-fable-5[1m]'), 'fable-5 1M still priced');
  assert.ok(priceForModel('claude-sonnet-5'), 'sonnet-5 added to the table');
  assert.equal(priceForModel('totally-unknown-model-x'), null, 'genuinely unknown stays null');
});

// --- item 7: meta-prompt titles filtered ------------------------------------
test('parseClaudeTranscript ignores harness title/classifier meta-prompts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-meta-'));
  try {
    const tx = [
      { type: 'user', uuid: 't1', timestamp: '2026-05-01T10:00:00Z', sessionId: 's', message: { role: 'user', content: 'Generate a concise UI title (20-40 characters) for this task. Return only the title.' } },
      { type: 'user', uuid: 't2', timestamp: '2026-05-01T10:01:00Z', sessionId: 's', message: { role: 'user', content: 'Implementar a tela home do app' } },
      { type: 'assistant', uuid: 'a2', timestamp: '2026-05-01T10:01:05Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ];
    const p = join(dir, 's.jsonl');
    writeFileSync(p, tx.map((e) => JSON.stringify(e)).join('\n'));
    const parsed = parseClaudeTranscript(p);
    assert.ok(!parsed.userPrompts.some((u) => /Generate a concise/.test(u)), 'meta-prompt dropped');
    assert.ok(parsed.userPrompts.some((u) => /tela home/.test(u)), 'real prompt kept');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- item 5: Codex session_meta > 16KB is still discovered -------------------
test('discoverCodexTranscripts reads a session_meta line larger than 16KB', () => {
  const src = mkdtempSync(join(tmpdir(), 'wk-cdx-big-'));
  try {
    const day = join(src, '2026', '05', '01');
    mkdirSync(day, { recursive: true });
    const bigInstructions = 'x'.repeat(40000); // pushes session_meta well past the old 16KB read
    const meta = { type: 'session_meta', timestamp: '2026-05-01T10:00:00Z', payload: { id: 'cdx-big', cwd: 'C:\\proj\\demo', instructions: bigInstructions, model: 'gpt-5.4' } };
    const turn = { type: 'event_msg', timestamp: '2026-05-01T10:00:01Z', payload: { type: 'user_message', turn_id: 't1', message: 'oi' } };
    writeFileSync(join(day, 'rollout-2026-05-01T10-00-00-cdx-big.jsonl'), [meta, turn].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const { transcripts } = discoverCodexTranscripts('C:\\proj\\demo', src);
    assert.equal(transcripts.length, 1, 'big-meta session discovered, not dropped');
    assert.equal(transcripts[0].sessionId, 'cdx-big');
  } finally { rmSync(src, { recursive: true, force: true }); }
});

// --- items 2,3,4: archive gate/pointer/atomicity ----------------------------
test('archiving a non-active change preserves the active pointer (item 2)', async () => {
  const { activeChange } = await import('../hooks/change-core.mjs');
  const vault = mkdtempSync(join(tmpdir(), 'wk-ptr-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, 'change', ...a, '--vault', vault], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    assert.equal(spawn(['new', 'aaa']).status, 0);
    fill(vault, 'aaa');
    writeFileSync(join(vault, '08-Mudanças', 'aaa', 'tarefas.md'), '- [x] 1.1 feito\n');
    assert.equal(spawn(['new', 'bbb']).status, 0); // bbb is now the active pointer
    fill(vault, 'bbb');
    assert.equal(activeChange(vault), 'bbb');
    const r = spawn(['archive', 'aaa']); // archive the NON-active one
    assert.equal(r.status, 0, r.stderr);
    assert.equal(activeChange(vault), 'bbb', 'pointer to the still-active bbb is untouched');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('archive is guarded against a pre-existing destination (item 3) + flips status (item 4)', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-atomic-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, 'change', ...a, '--vault', vault], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    assert.equal(spawn(['new', 'x']).status, 0);
    fill(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 feito\n');
    const a1 = spawn(['archive', 'x']);
    assert.equal(a1.status, 0, a1.stderr);
    // archived proposta flipped to status: archived (item 4)
    const archivedDir = readdirSync(join(vault, '08-Mudanças', '_arquivo')).find((d) => d.endsWith('-x'));
    assert.ok(archivedDir, 'archived folder present');
    const arch = readFileSync(join(vault, '08-Mudanças', '_arquivo', archivedDir, 'proposta.md'), 'utf8');
    assert.match(arch, /^status:\s*archived\s*$/m);
    // re-create same slug, fill, and archive again the SAME day -> dest collision guarded
    assert.equal(spawn(['new', 'x']).status, 0);
    fill(vault, 'x');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 de novo\n');
    const a2 = spawn(['archive', 'x']);
    assert.notEqual(a2.status, 0, 'second same-day archive of x is blocked by the dest guard');
    assert.match(a2.stderr, /já existe|exists/i);
    // and 07-Specs was not half-promoted: the change x still on disk (not moved)
    assert.ok(existsSync(join(vault, '08-Mudanças', 'x', 'proposta.md')), 'change left intact after guarded failure');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

// --- item 1: evidence freshness --------------------------------------------
test('archive blocks stale evidence after tarefas.md changed post-verify (item 1)', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-stale-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-stalep-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, ...a, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    assert.equal(spawn(['change', 'new', 'x']).status, 0);
    fill(vault, 'x');
    const tar = join(vault, '08-Mudanças', 'x', 'tarefas.md');
    writeFileSync(tar, '- [x] 1.1 do it [sensor:ok]\n');
    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [{ id: 'ok', severity: 'critical', command: 'node -e "process.exit(0)"' }] }));
    assert.equal(spawn(['verify']).status, 0, 'verify seals evidence');
    // edit tarefas AFTER verify -> evidence now stale
    writeFileSync(tar, '- [x] 1.1 do it [sensor:ok]\n- [x] 1.2 more [sensor:ok]\n');
    const blocked = spawn(['change', 'archive', 'x']);
    assert.equal(blocked.status, 1, 'stale evidence blocks archive');
    assert.match(blocked.stderr, /stale/i);
    // re-verify -> fresh -> archive passes
    assert.equal(spawn(['verify']).status, 0);
    assert.equal(spawn(['change', 'archive', 'x']).status, 0);
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});
