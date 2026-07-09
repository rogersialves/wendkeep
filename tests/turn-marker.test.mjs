// 0.29.2 — turn marker is provider-neutral (wk-turn); the legacy codex-turn is still recognized
// for dedup and self-migrated on the next write, so a Claude session no longer shows "codex-turn".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { turnMarker, hasTurnMarker, normalizeTurnMarkers, TURN_MARKER } from '../hooks/obsidian-common.mjs';
import { buildIterationBlock, insertIteration } from '../hooks/session-stop.mjs';

test('turnMarker is neutral; hasTurnMarker recognizes both new and legacy', () => {
  assert.equal(TURN_MARKER, 'wk-turn');
  assert.equal(turnMarker('abc'), '<!-- wk-turn: abc -->');
  assert.ok(hasTurnMarker('x <!-- wk-turn: abc --> y', 'abc'));
  assert.ok(hasTurnMarker('x <!-- codex-turn: abc --> y', 'abc'), 'legacy still deduped');
  assert.ok(!hasTurnMarker('x <!-- wk-turn: other -->', 'abc'));
});

test('normalizeTurnMarkers migrates legacy markers', () => {
  assert.equal(normalizeTurnMarkers('a\n<!-- codex-turn: t1 -->\nb'), 'a\n<!-- wk-turn: t1 -->\nb');
  assert.equal(normalizeTurnMarkers('<!-- wk-turn: t1 -->'), '<!-- wk-turn: t1 -->'); // idempotent
});

test('buildIterationBlock emits wk-turn, never codex-turn', () => {
  const tx = { turns: [{ turnId: 't1', timestamp: '', userPrompts: ['oi'], assistantMessages: ['ok'], tools: [], consultedFiles: [], changedFiles: [], conversation: [{ role: 'Usuário', text: 'oi' }], usage: {} }], latestTurnId: 't1' };
  const block = buildIterationBlock(tx, { turn_id: 't1' });
  assert.match(block, /<!-- wk-turn: t1 -->/);
  assert.doesNotMatch(block, /codex-turn/);
});

test('insertIteration dedups a legacy-marked note AND migrates it to wk-turn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-marker-'));
  try {
    const p = join(dir, 's.md');
    // a note written by an old version: legacy marker, still-open session
    writeFileSync(p, '# s\n\n## Iterações\n\n### 10:00 - x\n<!-- codex-turn: t1 -->\n\n## Encerramento\n\nfim\n');
    const tx = { turns: [], latestTurnId: 't1', consultedFiles: [], changedFiles: [], rawTextForDetection: '' };
    // same turn again -> must be recognized as present (no duplicate), and the note migrated
    const added = insertIteration(p, '### 10:00 - x\n<!-- wk-turn: t1 -->\n', 't1', tx);
    assert.equal(added, false, 'legacy turn recognized -> not re-added');
    const c = readFileSync(p, 'utf8');
    assert.ok(c.includes('<!-- wk-turn: t1 -->'), 'migrated to wk-turn');
    assert.ok(!c.includes('<!-- codex-turn:'), 'no legacy marker left');
    assert.equal((c.match(/<!-- wk-turn: t1 -->/g) || []).length, 1, 'still exactly one turn');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
