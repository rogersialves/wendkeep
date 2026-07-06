import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSessionCost, aggregateCosts } from '../src/cost.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

function note({ date, model, main, sub = 0, tokens = 0, subTokens = 0 }) {
  return `---\ntype: session\ndate: ${date}\ncusto_modelo_label: "${model}"\ncusto_modelo_usd: ${main}\nsubagents_custo_usd: ${sub}\ntokens_total: ${tokens}\nsubagents_tokens_total: ${subTokens}\n---\n\n# x\n`;
}

test('parseSessionCost: reads cost frontmatter; null for non-session', () => {
  const e = parseSessionCost(note({ date: '2026-07-06', model: 'claude-opus-4.8', main: 3.59, sub: 7.59 }));
  assert.equal(e.date, '2026-07-06');
  assert.equal(e.model, 'claude-opus-4.8');
  assert.equal(e.mainCost, 3.59);
  assert.equal(e.subCost, 7.59);
  assert.equal(parseSessionCost('---\ntype: decision\n---\n'), null);
});

test('aggregateCosts: total (main+sub), by day, by model sorted', () => {
  const a = aggregateCosts([
    { date: '2026-07-06', model: 'opus', mainCost: 3, subCost: 7, tokens: 100, subTokens: 400 },
    { date: '2026-07-06', model: 'sonnet', mainCost: 1, subCost: 0, tokens: 50, subTokens: 0 },
    { date: '2026-07-05', model: 'opus', mainCost: 2, subCost: 0, tokens: 20, subTokens: 0 },
  ]);
  assert.equal(a.count, 3);
  assert.equal(a.total, 13); // 3+7+1+2
  assert.equal(a.main, 6);
  assert.equal(a.sub, 7);
  assert.deepEqual(a.byDay.map((d) => d.date), ['2026-07-05', '2026-07-06']);
  assert.equal(a.byDay.find((d) => d.date === '2026-07-06').cost, 11);
  assert.equal(a.byModel[0].model, 'opus'); // highest cost first
  assert.equal(a.byModel[0].cost, 12);
});

test('wendkeep cost: aggregates real session notes across the vault (e2e)', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-cost-'));
  try {
    const dir = join(vault, '02-Sessões', '2026', '07-JUL', 'DIA 06');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 's1.md'), note({ date: '2026-07-06', model: 'claude-opus-4.8', main: 3.59, sub: 7.59 }));
    writeFileSync(join(dir, 's2.md'), note({ date: '2026-07-06', model: 'claude-sonnet-5', main: 0.5 }));
    const r = spawnSync(process.execPath, [BIN, 'cost', '--vault', vault], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Custo total \(vault\): \$11\.6800 — 2 sess/);
    assert.match(r.stdout, /subagents: \$7\.5900/);
    assert.match(r.stdout, /claude-opus-4\.8/);
    const j = spawnSync(process.execPath, [BIN, 'cost', '--vault', vault, '--json'], { encoding: 'utf8' });
    assert.equal(JSON.parse(j.stdout).total, 11.68);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
