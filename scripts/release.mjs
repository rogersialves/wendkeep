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
import {
  executeRelease, npmExecutorSpec, npmHasVersion, releaseCommands, resolveReleasePlan,
} from './release-plan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');

function sh(cmd, args, { capture = false, shell = false } = {}) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
}
function out(cmd, args, options = {}) {
  return sh(cmd, args, { ...options, capture: true }).trim();
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

// Todo acesso ao npm passa pelo executor resolvido: no Windows, `npm` não é executável por
// execFileSync e a consulta falharia silenciosamente, desligando o guard.
function runNpm(args) {
  const spec = npmExecutorSpec(args);
  return out(spec.command, spec.args, { shell: spec.shell });
}

const plan = resolveReleasePlan({
  name: pkg.name,
  version,
  tag,
  tagCommit: tagCommit(tag),
  headCommit: out('git', ['rev-parse', 'HEAD']),
  publishedOnNpm: npmHasVersion(pkg.name, version, runNpm),
});
if (plan.action === 'abort') die(plan.reason);

const branch = out('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
const commands = releaseCommands(plan, { tag, branch });

console.log(`\nRelease ${pkg.name}@${version} (${tag}) na branch ${branch}\n`);
if (plan.action === 'publish-only') {
  console.log(`  ${plan.reason}\n`);
  console.log(`· tag ${tag} preservada — já existe no commit corrente\n`);
}

const LABELS = {
  publish: 'npm publish',
  tag: `git tag -a ${tag}`,
  push: `git push origin ${branch} --follow-tags`,
};

executeRelease(commands, {
  dry: DRY,
  run: ({ command, args, shell }) => sh(command, args, { shell }),
  log: (line) => {
    const name = line.replace(/^[·→]\s*(\[dry\]\s*)?/, '');
    step(LABELS[name] || name);
  },
});

console.log(
  `\n✔ ${tag} publicado e pushado.` +
    `\n  A GitHub Release é criada pelo workflow release.yml no push da tag.` +
    (DRY ? '\n  (dry-run: nada foi executado)\n' : '\n')
);
