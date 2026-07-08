// 0.25.0 — cost trend/projection + shareable stats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trendBuckets, projectSpend, renderTrendNote, aggregateCosts } from '../src/cost.mjs';
import { statsFrom, statsLine } from '../src/stats.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

const BYDAY = [
  { date: '2026-05-10', cost: 10, count: 1 },
  { date: '2026-05-12', cost: 20, count: 2 },
  { date: '2026-06-02', cost: 30, count: 1 },
];

test('trendBuckets groups by month/week/day', () => {
  const m = trendBuckets(BYDAY, 'month');
  assert.deepEqual(m.map((b) => [b.period, b.cost, b.count]), [['2026-05', 30, 3], ['2026-06', 30, 1]]);
  assert.equal(trendBuckets(BYDAY, 'day').length, 3);
  const w = trendBuckets(BYDAY, 'week');
  assert.ok(w.every((b) => /^\d{4}-W\d\d$/.test(b.period)), 'ISO week keys');
});

test('projectSpend is a run-rate over the recent window', () => {
  const p = projectSpend(BYDAY, { nowStr: '2026-06-02', windowDays: 30, horizonDays: 30 });
  // cutoff = 2026-06-02 − 30d = 2026-05-03; all three days are after it -> 10+20+30 = 60
  assert.equal(p.basisTotal, 60);
  assert.equal(p.dailyRate, 2); // 60/30
  assert.equal(p.projected, 60); // 2 * 30
  // a tighter window excludes the older days
  const tight = projectSpend(BYDAY, { nowStr: '2026-06-02', windowDays: 10, horizonDays: 10 });
  assert.equal(tight.basisTotal, 30, 'only 06-02 within 10 days');
  assert.equal(projectSpend([], {}).projected, 0, 'empty is 0, no throw');
});

test('renderTrendNote has the month table + projection + model sections', () => {
  const agg = aggregateCosts([
    { date: '2026-05-10', model: 'claude-opus-4.8', mainCost: 8, subCost: 2, tokens: 0, subTokens: 0, prompts: 5 },
  ]);
  const note = renderTrendNote(agg, projectSpend(agg.byDay, { nowStr: '2026-05-10' }), '2026-06-01');
  assert.match(note, /type: cost-trend/);
  assert.match(note, /## Por mês/);
  assert.match(note, /2026-05/);
  assert.match(note, /## Projeção/);
  assert.match(note, /claude-opus-4\.8/);
});

test('statsFrom + statsLine derive a shareable summary', () => {
  const agg = aggregateCosts([
    { date: '2026-05-10', model: 'a', mainCost: 5, subCost: 0, tokens: 0, subTokens: 0, prompts: 12 },
    { date: '2026-06-02', model: 'b', mainCost: 7, subCost: 1, tokens: 0, subTokens: 0, prompts: 8 },
  ]);
  const s = statsFrom(agg);
  assert.equal(s.sessions, 2);
  assert.equal(s.prompts, 20);
  assert.equal(s.cost, 13);
  assert.equal(s.models, 2);
  assert.equal(s.firstDay, '2026-05-10');
  assert.equal(s.lastDay, '2026-06-02');
  assert.match(statsLine(s), /2 sessão\(ões\) · 20 prompts · \$13\.00 capturado/);
});

// --- CLI e2e ----------------------------------------------------------------
function seedSession(vault, dateStr, folder, cost, prompts, model = 'claude-opus-4.8') {
  const dir = join(vault, '02-Sessões', folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${dateStr}-s.md`), `---\ntype: session\ndate: ${dateStr}\nmodelo: "${model}"\ncusto_modelo_usd: ${cost}\nprompts: ${prompts}\n---\n# s\n`);
}

test('cost --trend, --write, and stats over a real vault', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-trend-'));
  try {
    seedSession(vault, '2026-05-10', '2026/05-MAI/DIA 10', 10, 5);
    seedSession(vault, '2026-05-20', '2026/05-MAI/DIA 20', 20, 7);
    seedSession(vault, '2026-06-02', '2026/06-JUN/DIA 02', 30, 9);
    const run = (a) => spawnSync(process.execPath, [BIN, ...a, '--vault', vault], { encoding: 'utf8' });

    const trend = run(['cost', '--trend', 'month']);
    assert.equal(trend.status, 0, trend.stderr);
    assert.match(trend.stdout, /2026-05/);
    assert.match(trend.stdout, /Run-rate/);

    const write = run(['cost', '--write']);
    assert.equal(write.status, 0, write.stderr);
    assert.ok(existsSync(join(vault, '00-Custo.md')), 'trend note generated');
    assert.match(readFileSync(join(vault, '00-Custo.md'), 'utf8'), /Custo — tendência/);

    const stats = run(['stats']);
    assert.equal(stats.status, 0, stats.stderr);
    assert.match(stats.stdout, /3 sessão\(ões\) · 21 prompts · \$60\.00 capturado/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
