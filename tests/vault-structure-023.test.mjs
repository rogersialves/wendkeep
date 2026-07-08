// 0.23.0 — vault structure: generated Bases/Dashboard, registry prune, word-boundary slugs,
// datestamped ADRs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderBase, renderDashboard, seedVaultViews } from '../src/vault-views.mjs';
import { pruneRegistry, slugify } from '../hooks/obsidian-common.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

// --- item 14: generated Bases + Dashboard -----------------------------------
test('renderBase filters by FOLDER, never by tag (the bug that hid 1/3 of bugs)', () => {
  const base = renderBase({ key: 'bugs', folder: '05-Bugs', title: 'Bugs', cols: ['date', 'status'], labels: { date: 'Data', status: 'Status' } });
  assert.match(base, /file\.inFolder\("05-Bugs"\)/);
  assert.doesNotMatch(base, /hasTag/);
  assert.match(base, /displayName: Status/);
});

test('renderDashboard embeds every area base', () => {
  const specs = [{ key: 'bugs', title: 'Bugs' }, { key: 'sessoes', title: 'Sessões' }];
  const md = renderDashboard(specs, false);
  assert.match(md, /!\[\[bugs\.base\]\]/);
  assert.match(md, /!\[\[sessoes\.base\]\]/);
});

test('seedVaultViews: writes bases + dashboard, non-destructive, locale-aware', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-views-'));
  try {
    const first = seedVaultViews(vault);
    assert.ok(first.includes('bugs.base'));
    assert.ok(first.includes('00-Dashboard.md'));
    assert.ok(existsSync(join(vault, 'sessoes.base')));
    // pt-BR default -> the sessions base points at 02-Sessões
    assert.match(readFileSync(join(vault, 'sessoes.base'), 'utf8'), /file\.inFolder\("02-Sessões"\)/);
    // non-destructive: a second run writes nothing
    assert.deepEqual(seedVaultViews(vault), []);
    // en locale -> English folder in the filter
    const en = mkdtempSync(join(tmpdir(), 'wk-views-en-'));
    mkdirSync(join(en, '.brain'), { recursive: true });
    writeFileSync(join(en, '.brain', 'config.json'), JSON.stringify({ locale: 'en' }));
    seedVaultViews(en);
    assert.match(readFileSync(join(en, 'sessoes.base'), 'utf8'), /file\.inFolder\("02-Sessions"\)/);
    rmSync(en, { recursive: true, force: true });
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

// --- item 18: registry prune ------------------------------------------------
test('pruneRegistry drops old/excess done entries, keeps active + recent', () => {
  const now = Date.parse('2026-07-08T00:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const reg = { version: 1, sessions: {
    active1: { status: 'active', started_at: '2026-01-01T00:00:00Z' }, // never pruned (active)
    old1: { status: 'done', ended_at: '2026-01-01T00:00:00Z' },        // > 90d -> pruned
    recent1: { status: 'done', ended_at: '2026-07-07T00:00:00Z' },
    recent2: { status: 'done', ended_at: '2026-07-06T00:00:00Z' },
  } };
  const pruned = pruneRegistry(reg, now, { keepDone: 10, maxAgeMs: 90 * day });
  assert.equal(pruned, 1, 'the >90d done entry pruned');
  assert.ok(reg.sessions.active1, 'active kept');
  assert.ok(reg.sessions.recent1 && reg.sessions.recent2, 'recent done kept');
  assert.ok(!reg.sessions.old1, 'old done gone');

  // cap: keep only the newest N done
  const reg2 = { version: 1, sessions: {} };
  for (let i = 0; i < 5; i++) reg2.sessions[`s${i}`] = { status: 'done', ended_at: `2026-07-0${i + 1}T00:00:00Z` };
  pruneRegistry(reg2, now, { keepDone: 2, maxAgeMs: 90 * day });
  assert.equal(Object.values(reg2.sessions).length, 2, 'capped at 2 newest');
  assert.ok(reg2.sessions.s4 && reg2.sessions.s3, 'newest kept');
});

// --- item 19: word-boundary slugs -------------------------------------------
test('slugify truncates on a word boundary, not mid-word', () => {
  const s = slugify('alteracoes de local do vault do obsidian precisam ser revisadas com cuidado', 'x', 40);
  assert.ok(s.length <= 40);
  assert.ok(!s.endsWith('-'), 'no trailing dash');
  // the cut lands on a whole word (the raw text has no word crossing the boundary intact)
  assert.ok(/^[a-z0-9-]+$/.test(s));
  assert.ok(!/precis$|revisad$|cuidad$/.test(s), 'not cut mid-word');
});

// --- item 16: datestamped ADR ------------------------------------------------
test('archive writes the ADR under the dated month folder, not the year root', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-adr-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, 'change', ...a, '--vault', vault], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    assert.equal(spawn(['new', 'x']).status, 0);
    writeFileSync(join(vault, '08-Mudanças', 'x', 'proposta.md'), '---\ntype: change\nstatus: active\nspecs: []\n---\n\n# x\n\n## Por quê\n\nA.\n\n## O que muda\n\nB.\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'design.md'), '# x — design\n\n## Abordagem\n\nC.\n');
    writeFileSync(join(vault, '08-Mudanças', 'x', 'tarefas.md'), '- [x] 1.1 feito\n');
    const r = spawn(['archive', 'x']);
    assert.equal(r.status, 0, r.stderr);
    // ADR path: 04-Decisões/<year>/<MM-MMM>/ADR-...  (month folder present, not year root)
    assert.match(r.stdout, /04-Decis(õ|o)es[\\/]\d{4}[\\/]\d\d-[A-Z]{3}[\\/]ADR-\d+-x\.md/, r.stdout);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
