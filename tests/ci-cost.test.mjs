import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PR_WORKFLOW = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
const RELEASE_WORKFLOW = readFileSync(new URL('../.github/workflows/auto-tag.yml', import.meta.url), 'utf8');

function occurrences(content, pattern) {
  return content.match(pattern)?.length || 0;
}

function jobBlock(content, name) {
  const normalized = content.replace(/\r\n/g, '\n');
  const marker = `\n  ${name}:\n`;
  const start = normalized.indexOf(marker);
  assert.notEqual(start, -1, `missing job ${name}`);
  const bodyStart = start + marker.length;
  const next = normalized.slice(bodyStart).search(/\n  [a-z][a-z0-9-]*:\n/);
  return normalized.slice(start + 1, next < 0 ? undefined : bodyStart + next);
}

test('[req:CI-COST-1] pull requests run only the required policy, Core, Observer, quality and full gates', () => {
  assert.match(PR_WORKFLOW, /cancel-in-progress:\s*true/);
  const core = jobBlock(PR_WORKFLOW, 'core');
  const observer = jobBlock(PR_WORKFLOW, 'observer');
  const full = jobBlock(PR_WORKFLOW, 'full');
  assert.match(core, /runs-on:\s*ubuntu-latest/);
  assert.match(core, /node:\s*\[18, 20\]/);
  assert.match(core, /npm run test:core/);
  assert.equal(occurrences(observer, /os: ubuntu-latest/g), 2);
  assert.equal(occurrences(observer, /os: windows-latest/g), 2);
  assert.equal(occurrences(observer, /os: macos-latest/g), 2);
  assert.match(observer, /npm run test:observer/);
  assert.match(full, /needs:\s*\[policy, core, observer, quality\]/);
  assert.equal(occurrences(PR_WORKFLOW, /npm test/g), 1);
  assert.doesNotMatch(PR_WORKFLOW, /^  release:|npm publish|release_required:/m);
});

test('[req:CI-COST-2] main gates release on Windows, macOS Observer, quality and security after Linux', () => {
  assert.match(RELEASE_WORKFLOW, /^  test-linux:\r?$/m);
  for (const name of ['test', 'observer-macos', 'quality', 'codeql', 'dependency-audit']) {
    const block = jobBlock(RELEASE_WORKFLOW, name);
    assert.match(block, /needs:\s*test-linux/);
    assert.match(block, /if:\s*needs\.test-linux\.outputs\.release_required == 'true'/);
  }
  assert.match(jobBlock(RELEASE_WORKFLOW, 'test'), /\{ os: windows-latest, node: 24 \}/);
  assert.match(jobBlock(RELEASE_WORKFLOW, 'observer-macos'), /node:\s*\[22\.13\.0, 24\]/);
  assert.match(jobBlock(RELEASE_WORKFLOW, 'quality'), /quality:coverage[\s\S]*quality:mutation/);
  assert.match(jobBlock(RELEASE_WORKFLOW, 'codeql'), /github\/codeql-action\/analyze@[a-f0-9]{40}/);
  assert.match(jobBlock(RELEASE_WORKFLOW, 'dependency-audit'), /npm audit --audit-level=moderate/);
  assert.match(
    jobBlock(RELEASE_WORKFLOW, 'release'),
    /needs:\s*\[test, observer-macos, quality, codeql, dependency-audit\]/,
  );
});

test('[req:CI-COST-3] CI-only changes skip Windows and publication', () => {
  assert.ok(RELEASE_WORKFLOW.includes('release_required: ${{ steps.release-scope.outputs.required }}'));
  assert.ok(RELEASE_WORKFLOW.includes("':(exclude).github/**'"));
  assert.ok(RELEASE_WORKFLOW.includes("':(exclude)tests/**'"));
  assert.ok(RELEASE_WORKFLOW.includes('echo "required=false" >> "$GITHUB_OUTPUT"'));
  assert.ok(RELEASE_WORKFLOW.includes('Somente CI/testes mudaram'));
});
