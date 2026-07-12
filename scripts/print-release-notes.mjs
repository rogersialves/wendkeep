#!/usr/bin/env node
// Print a version's release notes (from CHANGELOG.md) to stdout, with a safe
// fallback when the version has no dedicated section. Used by the release
// workflow and by one-off backfills.
//
//   node scripts/print-release-notes.mjs 0.38.1

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractReleaseNotes } from '../src/release-changelog.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];
if (!version) {
  console.error('uso: print-release-notes.mjs <version>');
  process.exit(2);
}

const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
try {
  const r = extractReleaseNotes(changelog, version);
  process.stdout.write(`${r.notes}\n`);
} catch {
  process.stdout.write(`Release ${version.replace(/^v/i, '')}. Sem changelog dedicado para esta versão.\n`);
}
