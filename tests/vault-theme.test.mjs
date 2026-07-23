// Vault color system: a CSS snippet keyed off the cssclasses the hooks emit
// (topic-session/decision/bug/learning) plus Obsidian graph color groups by folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SNIPPET_NAME,
  renderColorSnippetCss,
  mergeAppearance,
  graphColorGroups,
  mergeGraphColorGroups,
} from '../src/vault-theme.mjs';
import { syncVaultTheme } from '../src/theme.mjs';

test('renderColorSnippetCss: styles every note-type class and folder accent', () => {
  const css = renderColorSnippetCss();
  for (const cls of ['topic-session', 'topic-decision', 'topic-bug', 'topic-learning']) {
    assert.ok(css.includes(cls), `snippet styles ${cls}`);
  }
  for (const folder of ['00-Inbox', '02-Sessões', '04-Decisões', '05-Bugs', '06-Aprendizados']) {
    assert.ok(css.includes(`data-path^="${folder}"`), `colors folder ${folder} in explorer`);
  }
  assert.match(css, /--us-blue/);
  assert.match(css, /--note-accent/);
});

test('colors: change/spec note classes + graph groups for new folders', () => {
  const css = renderColorSnippetCss();
  assert.ok(css.includes('topic-change'));
  assert.ok(css.includes('topic-spec'));
  const q = graphColorGroups().map((g) => g.query);
  assert.ok(q.some((s) => s.includes('08-Mudanças')));
  assert.ok(q.some((s) => s.includes('07-Specs')));
});

test('renderColorSnippetCss: covers reading, live preview and file explorer', () => {
  const css = renderColorSnippetCss();
  assert.match(css, /\.markdown-rendered/, 'reading mode');
  assert.match(css, /\.markdown-source-view/, 'live preview');
  assert.match(css, /\.cm-header-1/, 'live preview heading');
  assert.match(css, /\.nav-folder-title/, 'file explorer folders');
});

test('mergeAppearance: enables the snippet, non-destructive and dedup', () => {
  const a = mergeAppearance({}, SNIPPET_NAME);
  assert.deepEqual(a.enabledCssSnippets, [SNIPPET_NAME]);

  const b = mergeAppearance({ enabledCssSnippets: ['other'], baseFontSize: 16 }, SNIPPET_NAME);
  assert.deepEqual(b.enabledCssSnippets, ['other', SNIPPET_NAME]);
  assert.equal(b.baseFontSize, 16, 'preserves unrelated appearance keys');

  const c = mergeAppearance({ enabledCssSnippets: [SNIPPET_NAME] }, SNIPPET_NAME);
  assert.deepEqual(c.enabledCssSnippets, [SNIPPET_NAME], 'no duplicate on re-run');
});

test('graphColorGroups: one group per note folder with an integer rgb color', () => {
  const groups = graphColorGroups();
  const queries = groups.map((g) => g.query);
  assert.ok(queries.some((q) => q.includes('02-Sessões')));
  assert.ok(queries.some((q) => q.includes('05-Bugs')));
  for (const g of groups) {
    assert.equal(typeof g.color.rgb, 'number');
    assert.equal(g.color.a, 1);
  }
});

// THEME-1 — snippet gerado define uma largura de linha legível ampla, sobre o body
test('renderColorSnippetCss: sets a wide --file-line-width on body', () => {
  const css = renderColorSnippetCss();
  assert.match(css, /--file-line-width/, 'declares the variable');
  // Discrimina: precisa estar num bloco body {} e com valor amplo (>= 3 dígitos px),
  // não a variável largada em qualquer lugar nem um valor estreito.
  assert.match(css, /body\s*\{[^}]*--file-line-width:\s*\d{3,}px/, 'wide width scoped to body');
});

// THEME-2 — re-sync de tema num vault existente, idempotente (recupera colorGroups zerados)
test('syncVaultTheme: re-applies snippet + graph groups on an existing vault, idempotent', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-theme-sync-'));
  try {
    const obs = join(vault, '.obsidian');
    mkdirSync(join(obs, 'snippets'), { recursive: true });
    writeFileSync(join(obs, 'graph.json'), JSON.stringify({ colorGroups: [], scale: 1.5 }));
    writeFileSync(join(obs, 'appearance.json'), JSON.stringify({ baseFontSize: 16 }));

    syncVaultTheme(vault);
    const g = JSON.parse(readFileSync(join(obs, 'graph.json'), 'utf8'));
    assert.ok(g.colorGroups.length >= 6, 'graph groups (re)applied');
    assert.equal(g.scale, 1.5, 'preserves unrelated graph prefs');
    const css = readFileSync(join(obs, 'snippets', `${SNIPPET_NAME}.css`), 'utf8');
    assert.ok(css.includes('--file-line-width'), 'snippet rewritten with line width');
    const app = JSON.parse(readFileSync(join(obs, 'appearance.json'), 'utf8'));
    assert.ok(app.enabledCssSnippets.includes(SNIPPET_NAME), 'snippet enabled');
    assert.equal(app.baseFontSize, 16, 'preserves unrelated appearance prefs');

    syncVaultTheme(vault);
    const g2 = JSON.parse(readFileSync(join(obs, 'graph.json'), 'utf8'));
    assert.equal(g2.colorGroups.length, g.colorGroups.length, 'idempotent: no duplicate groups');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('mergeGraphColorGroups: adds groups, non-destructive and dedup by query', () => {
  const g1 = mergeGraphColorGroups({}, graphColorGroups());
  assert.equal(g1.colorGroups.length, graphColorGroups().length);

  const existing = { colorGroups: [{ query: 'path:"02-Sessões"', color: { a: 1, rgb: 111 } }], scale: 1 };
  const g2 = mergeGraphColorGroups(existing, graphColorGroups());
  const sessionGroups = g2.colorGroups.filter((g) => g.query.includes('02-Sessões'));
  assert.equal(sessionGroups.length, 1, 'no duplicate session group');
  assert.equal(g2.scale, 1, 'preserves unrelated graph keys');
});
