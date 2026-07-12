import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractReleaseNotes } from '../src/release-changelog.mjs';

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
