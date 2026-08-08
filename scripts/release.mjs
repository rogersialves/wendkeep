#!/usr/bin/env node
// Atomic release: publish to npm, tag, and push — so the tag always exists on
// origin. Creating the GitHub Release itself is left to .github/workflows/release.yml
// (fires on the tag push), which keeps a single source of truth and means even a
// bare `git push --tags` produces a release.
//
//   npm run release            # real run
//   npm run release -- --dry-run
//
// Guards: clean working tree, CHANGELOG entry present, and the version not already released.
// A tag that already exists is NOT a blocker on its own — auto-tag.yml creates it on the merge
// to main, before any publish. See scripts/release-plan.mjs.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractReleaseNotes } from '../src/release-changelog.mjs';
import { resolveReleasePlan } from './release-plan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');

function sh(cmd, args, { capture = false } = {}) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
}
function out(cmd, args) {
  return sh(cmd, args, { capture: true }).trim();
}
function die(msg) {
  console.error(`\n✖ release abortado: ${msg}\n`);
  process.exit(1);
}
function step(msg) {
  console.log(`${DRY ? '· [dry]' : '→'} ${msg}`);
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;

// Guard: CHANGELOG must document this version (fail fast; CI needs it too).
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
try {
  extractReleaseNotes(changelog, version);
} catch {
  die(`CHANGELOG.md sem entrada "## [${version}]". Documente antes de publicar.`);
}

// Guard: clean working tree.
if (out('git', ['status', '--porcelain'])) {
  die('working tree sujo. Commite ou stash antes de publicar.');
}

function tagCommit(ref) {
  try {
    return out('git', ['rev-list', '-n', '1', `refs/tags/${ref}`]);
  } catch {
    return null;
  }
}

// `--prefer-online` é deliberado: sem ele o npm serve metadata de cache e pode negar uma versão
// recém-publicada. Falha de consulta cai como "não publicado" — o registry é a autoridade final
// e recusa republicação com EPUBLISHCONFLICT, então este guard é só uma falha antecipada.
function npmHasVersion(name, wanted) {
  try {
    return out('npm', ['view', `${name}@${wanted}`, 'version', '--prefer-online']) === wanted;
  } catch {
    return false;
  }
}

const plan = resolveReleasePlan({
  name: pkg.name,
  version,
  tag,
  tagCommit: tagCommit(tag),
  headCommit: out('git', ['rev-parse', 'HEAD']),
  publishedOnNpm: npmHasVersion(pkg.name, version),
});
if (plan.action === 'abort') die(plan.reason);

const branch = out('git', ['rev-parse', '--abbrev-ref', 'HEAD']);

console.log(`\nRelease ${pkg.name}@${version} (${tag}) na branch ${branch}\n`);
if (plan.action === 'publish-only') console.log(`  ${plan.reason}\n`);

step(`npm publish`);
if (!DRY) sh('npm', ['publish']);

if (plan.action === 'publish-only') {
  step(`git tag -a ${tag} — pulado, a tag já existe no commit corrente`);
} else {
  step(`git tag -a ${tag}`);
  if (!DRY) sh('git', ['tag', '-a', tag, '-m', tag]);
}

step(`git push origin ${branch} --follow-tags`);
if (!DRY) sh('git', ['push', 'origin', branch, '--follow-tags']);

console.log(
  `\n✔ ${tag} publicado e pushado.` +
    `\n  A GitHub Release é criada pelo workflow release.yml no push da tag.` +
    (DRY ? '\n  (dry-run: nada foi executado)\n' : '\n')
);
