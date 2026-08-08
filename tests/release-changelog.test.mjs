import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractReleaseNotes } from '../src/release-changelog.mjs';
import { resolveReleasePlan } from '../scripts/release-plan.mjs';

const AUTO_TAG_WORKFLOW = readFileSync(new URL('../.github/workflows/auto-tag.yml', import.meta.url), 'utf8');
const AGENT_RULES = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
const CHANGELOG = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const FIXTURE = `# Changelog

All notable changes to **wendkeep** are documented here.

## [0.38.1] — 2026-07-12

### Fixed

- Sessão Claude nova não perde o 1º turno.
- Paridade de provider nos hooks.

## [0.38.0] — 2026-07-12

### Added

- Coisa nova A.

### Fixed

- Bug B.

## [0.35.0] — 2026-07-11

### Fixed

- Algo antigo.
`;

test('extractReleaseNotes: returns body + date for a version', () => {
  const r = extractReleaseNotes(FIXTURE, '0.38.1');
  assert.equal(r.version, '0.38.1');
  assert.equal(r.date, '2026-07-12');
  assert.match(r.notes, /### Fixed/);
  assert.match(r.notes, /não perde o 1º turno/);
});

test('extractReleaseNotes: stops before the next version header', () => {
  const r = extractReleaseNotes(FIXTURE, '0.38.0');
  assert.match(r.notes, /Coisa nova A/);
  assert.match(r.notes, /Bug B/);
  assert.doesNotMatch(r.notes, /Algo antigo/);
  assert.doesNotMatch(r.notes, /não perde o 1º turno/);
});

test('extractReleaseNotes: accepts a v-prefixed version', () => {
  const r = extractReleaseNotes(FIXTURE, 'v0.35.0');
  assert.equal(r.version, '0.35.0');
  assert.match(r.notes, /Algo antigo/);
});

test('extractReleaseNotes: body is trimmed (no leading/trailing blank lines)', () => {
  const r = extractReleaseNotes(FIXTURE, '0.35.0');
  assert.equal(r.notes, r.notes.trim());
  assert.ok(r.notes.length > 0);
});

test('extractReleaseNotes: throws when the version is absent', () => {
  assert.throws(() => extractReleaseNotes(FIXTURE, '9.9.9'), /9\.9\.9/);
});

test('[sensor:release-tests] 0.68.2 notes are extractable and match the package', () => {
  const release = extractReleaseNotes(CHANGELOG, '0.68.2');
  assert.equal(PACKAGE.version, '0.68.2');
  assert.equal(release.date, '2026-08-08');
  assert.match(release.notes, /auto-tag\.yml/);
  assert.match(release.notes, /unicidade da versão no registry/i);
  assert.match(release.notes, /commit corrente/i);
  assert.doesNotMatch(release.notes, /019f[0-9a-f-]+/i);
});

test('[sensor:release-tests] as notas de 0.68.1 seguem extraíveis depois do bump', () => {
  // A entrada anterior precisa continuar íntegra: a v0.68.1 já tem tag e GitHub Release, e o
  // auto-tag relê o CHANGELOG para refrescar release existente.
  const release = extractReleaseNotes(CHANGELOG, '0.68.1');
  assert.equal(release.date, '2026-08-08');
  assert.match(release.notes, /VAULT_PATH_UNSAFE/);
  assert.match(release.notes, /walk fresco/i);
});

const releaseFacts = (overrides = {}) => ({
  name: 'wendkeep',
  version: '1.2.3',
  tag: 'v1.2.3',
  tagCommit: null,
  headCommit: 'a'.repeat(40),
  publishedOnNpm: false,
  ...overrides,
});

test('[sensor:release-tests] [req:CLI-PKG-2] sem tag, o release publica e cria a tag', () => {
  const plan = resolveReleasePlan(releaseFacts());
  assert.equal(plan.action, 'publish-and-tag');
});

test('[sensor:release-tests] [req:CLI-PKG-2] tag do auto-tag no commit corrente publica e preserva a tag', () => {
  // auto-tag.yml cria a tag no merge em main, antes de qualquer publish. A tag existir não
  // significa que a versão foi lançada — só o registry responde isso.
  const plan = resolveReleasePlan(releaseFacts({
    tagCommit: 'a'.repeat(40),
    publishedOnNpm: false,
  }));
  assert.equal(plan.action, 'publish-only');
});

test('[sensor:release-tests] [req:CLI-PKG-2] versão já publicada aborta mesmo com a tag no commit corrente', () => {
  const plan = resolveReleasePlan(releaseFacts({
    tagCommit: 'a'.repeat(40),
    publishedOnNpm: true,
  }));
  assert.equal(plan.action, 'abort');
  assert.match(plan.reason, /já está publicad/i);
});

test('[sensor:release-tests] [req:CLI-PKG-2] tag apontando para outro commit aborta', () => {
  // Publicar aqui entregaria conteúdo diferente do que foi tagueado. Precede a consulta ao
  // registry: é uma checagem local e o estado é ambíguo demais para prosseguir.
  const plan = resolveReleasePlan(releaseFacts({
    tagCommit: 'b'.repeat(40),
    publishedOnNpm: false,
  }));
  assert.equal(plan.action, 'abort');
  assert.match(plan.reason, /outro commit|diverge/i);
});

test('auto-tag: existing tag still refreshes the GitHub Release from CHANGELOG', () => {
  const tagBranch = AUTO_TAG_WORKFLOW.match(/if git rev-parse[\s\S]*?^\s*fi$/m)?.[0] || '';
  assert.ok(tagBranch, 'workflow has an explicit existing/new tag branch');
  assert.doesNotMatch(tagBranch, /\bexit\s+0\b/, 'an existing tag must not skip release refresh');
  assert.ok(
    AUTO_TAG_WORKFLOW.indexOf('scripts/print-release-notes.mjs') < AUTO_TAG_WORKFLOW.indexOf('if git rev-parse'),
    'release notes are generated before the tag branch',
  );
  assert.ok(
    AUTO_TAG_WORKFLOW.indexOf('gh release edit') > AUTO_TAG_WORKFLOW.indexOf(tagBranch),
    'the existing-tag path reaches release edit',
  );
});

test('auto-tag: release readback normalizes the extra newline emitted by gh', () => {
  assert.match(AUTO_TAG_WORKFLOW, /PUBLISHED_RELEASE_NOTES\.md/);
  assert.doesNotMatch(
    AUTO_TAG_WORKFLOW,
    /diff -u RELEASE_NOTES\.md PUBLISHED_RELEASE_NOTES\.md/,
    'raw diff rejects an otherwise identical gh body because --jq appends one newline',
  );
  assert.match(AUTO_TAG_WORKFLOW, /trimEnd\(\)/, 'comparison canonicalizes trailing newlines');
});

test('AGENTS: release closure requires updating and reading back notes from CHANGELOG', () => {
  assert.match(AGENT_RULES, /Fechamento obrigatório[\s\S]*CHANGELOG[\s\S]*GitHub Release/i);
  assert.match(AGENT_RULES, /gh release edit\s+vX\.Y\.Z/);
  assert.match(AGENT_RULES, /gh release view\s+vX\.Y\.Z/);
  assert.match(AGENT_RULES, /não (?:declare|considere)[\s\S]*release[\s\S]*concluída/i);
});
