import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const workflowDir = new URL('../.github/workflows/', import.meta.url);
const workflows = Object.fromEntries(readdirSync(workflowDir)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .map((name) => [name, readFileSync(new URL(name, workflowDir), 'utf8')]));

const externalUses = (source) => [...source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#\s*(.+))?$/gm)]
  .map(([, reference, comment]) => ({ reference, comment: comment || '' }))
  .filter(({ reference }) => !reference.startsWith('./'));

test('[req:CI-SC-1] every external Action is immutable and documents its human release', () => {
  for (const [name, source] of Object.entries(workflows)) {
    for (const { reference, comment } of externalUses(source)) {
      assert.match(reference, /^[\w.-]+\/[\w.-]+\/[\w./-]+@[a-f0-9]{40}$|^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/,
        `${name}: mutable or invalid Action reference ${reference}`);
      assert.match(comment, /^v\d+(?:\.\d+){0,2}\b/, `${name}: pinned Action lacks a human version comment`);
    }
  }
});

test('[req:CI-SC-2] Core and Observer expose stable, bounded support checks', () => {
  const workflow = workflows['test.yml'];
  assert.match(workflow, /^permissions:\r?\n  contents:\s*read$/m);
  assert.match(workflow, /^  core:\r?\n(?:[^\n]*\n)*?    name:\s*test \/ core/m);
  assert.match(workflow, /node:\s*\[18, 20\]/);
  assert.match(workflow, /run:\s*npm run test:core/);
  assert.match(workflow, /^  observer:\r?\n(?:[^\n]*\n)*?    name:\s*test \/ observer/m);
  for (const os of ['ubuntu-latest', 'windows-latest', 'macos-latest']) assert.match(workflow, new RegExp(`os: ${os}`));
  assert.match(workflow, /node:\s*22\.13\.0/);
  assert.match(workflow, /node:\s*24/);
  assert.match(workflow, /run:\s*npm run test:observer/);
  assert.match(workflow, /^  policy:\r?\n(?:[^\n]*\n)*?    name:\s*test \/ policy/m);
});

test('[req:CI-SC-3] privileged release permissions are job-scoped and security workflows are read-only', () => {
  const release = workflows['auto-tag.yml'];
  const globalPermissions = release.match(/^permissions:\r?\n((?:  .+\r?\n)+)/m)?.[1] || '';
  assert.equal(globalPermissions.trim(), 'contents: read');
  const releaseJob = release.slice(release.indexOf('\n  release:'), release.length);
  assert.match(releaseJob, /permissions:\r?\n      contents:\s*write\r?\n      id-token:\s*write/);
  assert.doesNotMatch(release.slice(0, release.indexOf('\n  release:')), /id-token:\s*write/);

  for (const name of ['codeql.yml', 'dependency-review.yml']) {
    assert.ok(workflows[name], `${name} is required`);
    assert.match(workflows[name], /^permissions:\r?\n  contents:\s*read/m);
    assert.doesNotMatch(workflows[name], /contents:\s*write|id-token:\s*write/);
  }
  assert.match(workflows['codeql.yml'], /name:\s*security \/ codeql/);
  assert.match(workflows['dependency-review.yml'], /name:\s*security \/ dependency-review/);
});

test('[req:CI-SC-4] scope runner keeps Core independent from Observer SQL', () => {
  const runner = readFileSync(new URL('../scripts/run-scope.mjs', import.meta.url), 'utf8');
  assert.match(runner, /\['all', 'core', 'observer'\]/);
  assert.match(runner, /scope !== 'core'[^\n]*!name\.startsWith\('observer-'\)/);
  assert.match(runner, /scope !== 'observer'[^\n]*name\.startsWith\('observer-'\)/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['test:observer'], 'node scripts/run-scope.mjs observer');
});

test('[req:CI-SC-5] release preserves the tested tarball, SBOM and #40 commit binding before publish', () => {
  const release = workflows['auto-tag.yml'];
  const commitGate = release.indexOf('Validate canonical commit receipt');
  const prepare = release.indexOf('Prepare immutable tarball and SBOM');
  const upload = release.indexOf('Upload release candidate');
  const consume = release.indexOf('Test exact release candidate in isolated consumers');
  const publish = release.indexOf('Publish package');
  assert.ok(commitGate > -1 && prepare > commitGate, 'artifact must follow the canonical commit gate');
  assert.ok(upload > prepare && consume > upload && publish > consume,
    'the durable candidate must pass isolated consumers before publish');
  assert.match(release, /npm run release:candidate:test/);
  assert.match(release, /npm publish artifacts\/release-candidate\.tgz --provenance/);
  assert.doesNotMatch(release.slice(prepare, publish), /npm pack/,
    'no second tarball may replace the candidate between preparation and publish');
  const provenanceAttempts = release
    .split(/\r?\n/)
    .filter((line) => line.includes('release-provenance.mjs --require-published --json'));
  assert.ok(provenanceAttempts.length >= 2, 'retry loop and terminal attempt must both verify provenance');
  assert.ok(
    provenanceAttempts.every((line) => line.includes('> published-provenance.json')),
    'every successful provenance attempt must persist the receipt input',
  );
  assert.match(release, /finalize-release-receipt\.mjs/);
});

test('[req:CI-SC-10] main release waits for macOS Observer, coverage, mutation, CodeQL and dependency gates', () => {
  const release = workflows['auto-tag.yml'];
  assert.match(release, /^  observer-macos:\r?\n(?:[^\n]*\n)*?    name:\s*test \/ observer-macos/m);
  assert.match(release, /^  quality:\r?\n(?:[^\n]*\n)*?    name:\s*test \/ quality-release/m);
  assert.match(release, /npm run quality:coverage/);
  assert.match(release, /npm run quality:mutation/);
  assert.match(release, /^  codeql:\r?\n(?:[^\n]*\n)*?    name:\s*security \/ codeql-release/m);
  assert.match(release, /^  dependency-audit:\r?\n(?:[^\n]*\n)*?    name:\s*security \/ dependency-audit/m);
  assert.match(release, /^  release:\r?\n    needs:\s*\[test, observer-macos, quality, codeql, dependency-audit\]$/m);
});
