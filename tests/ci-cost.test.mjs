import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PR_WORKFLOW = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
const RELEASE_WORKFLOW = readFileSync(new URL('../.github/workflows/auto-tag.yml', import.meta.url), 'utf8');

function occurrences(content, pattern) {
  return content.match(pattern)?.length || 0;
}

test('[req:CI-COST-1] pull requests use one Linux runner and no redundant matrix', () => {
  assert.match(PR_WORKFLOW, /cancel-in-progress:\s*true/);
  assert.doesNotMatch(PR_WORKFLOW, /windows-latest/);
  assert.doesNotMatch(PR_WORKFLOW, /\bmatrix:/);
  assert.equal(occurrences(PR_WORKFLOW, /actions\/checkout@v5/g), 1);
  assert.equal(occurrences(PR_WORKFLOW, /actions\/setup-node@v5/g), 2);
  assert.match(PR_WORKFLOW, /node-version:\s*18/);
  assert.match(PR_WORKFLOW, /node --test tests\/runtime-compat\.mjs/);
  assert.equal(occurrences(PR_WORKFLOW, /npm run check/g), 1);
  assert.match(PR_WORKFLOW, /node-version:\s*22\.13\.0/);
  assert.equal(occurrences(PR_WORKFLOW, /npm ci --ignore-scripts/g), 1);
  assert.equal(occurrences(PR_WORKFLOW, /npm test/g), 1);
});

test('[req:CI-COST-2] main runs one gated Windows 24 suite after Linux', () => {
  assert.match(RELEASE_WORKFLOW, /^  test-linux:\r?$/m);
  assert.match(RELEASE_WORKFLOW, /^  test:\r?\n    strategy:/m);
  assert.match(RELEASE_WORKFLOW, /^    needs:\s*test-linux\s*$/m);
  assert.match(RELEASE_WORKFLOW, /^    if:\s*needs\.test-linux\.outputs\.release_required == 'true'\s*$/m);
  assert.equal(occurrences(RELEASE_WORKFLOW, /windows-latest/g), 1);
  assert.match(RELEASE_WORKFLOW, /\{ os: windows-latest, node: 24 \}/);
  assert.equal(occurrences(RELEASE_WORKFLOW, /node --test tests\/runtime-compat\.mjs/g), 1);
  assert.equal(occurrences(RELEASE_WORKFLOW, /npm run check/g), 1);
  assert.equal(occurrences(RELEASE_WORKFLOW, /npm test/g), 2);
  assert.match(RELEASE_WORKFLOW, /^  release:\r?\n    needs:\s*test\s*$/m);
});

test('[req:CI-COST-3] CI-only changes skip Windows and publication', () => {
  assert.ok(RELEASE_WORKFLOW.includes('release_required: ${{ steps.release-scope.outputs.required }}'));
  assert.ok(RELEASE_WORKFLOW.includes("':(exclude).github/**'"));
  assert.ok(RELEASE_WORKFLOW.includes("':(exclude)tests/**'"));
  assert.ok(RELEASE_WORKFLOW.includes('echo "required=false" >> "$GITHUB_OUTPUT"'));
  assert.ok(RELEASE_WORKFLOW.includes('Somente CI/testes mudaram'));
});
