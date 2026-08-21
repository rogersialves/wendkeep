import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  FLOW_PROTECTED_SCAN_POLICY,
  FLOW_PROTECTED_RULES,
  flowProtectedPhysicalScanOptions,
  flowProtectedIgnoredPathspecs,
  flowProtectedPolicyExamples,
  isProtectedFlowPath,
} from '../hooks/flow-protected-policy.mjs';
import { captureGitSnapshot, diffGitSnapshots } from '../hooks/git-snapshot.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
}

function write(root, rel, content) {
  const path = join(root, ...rel.split('/'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test('[req:OP-7] política canônica co-localiza ids, classifier, discovery e exemplares', () => {
  const ids = FLOW_PROTECTED_RULES.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of FLOW_PROTECTED_RULES) {
    assert.ok(entry.discoverGlobs.length > 0, `${entry.id}: sem discovery`);
    assert.ok(entry.exemplars.length > 0, `${entry.id}: sem exemplar`);
    for (const path of entry.exemplars) assert.equal(isProtectedFlowPath(path), true, `${entry.id}: ${path}`);
    for (const path of entry.topologyRoots) assert.equal(isProtectedFlowPath(path), true, `${entry.id} anchor: ${path}`);
  }
  assert.equal(isProtectedFlowPath('SRC/CsrfGuard.ts'), true);
  for (const control of ['src/apiary.ts', 'src/apicalChart.ts', 'src/author-card.ts', 'src/capital.ts']) {
    assert.equal(isProtectedFlowPath(control), false, control);
  }
  const specs = flowProtectedIgnoredPathspecs();
  assert.equal(new Set(specs).size, specs.length);
  assert.ok(specs.every((value) => value.startsWith(':(glob,icase)')));
  assert.deepEqual(
    flowProtectedIgnoredPathspecs(['private/**']).filter((value) => value.includes('private')),
    [':(glob,icase)private', ':(glob,icase)private/**'],
  );
});

test('[req:OP-7] cada regra descobre create, change e remove ignorados sem incluir controles', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-flow-policy-'));
  try {
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'flow@example.invalid');
    git(root, 'config', 'user.name', 'FLOW Policy Test');
    write(root, '.gitignore', '*\n');
    git(root, 'add', '-f', '.gitignore');
    git(root, 'commit', '-qm', 'ignored baseline');

    const exemplars = flowProtectedPolicyExamples();
    for (const { path } of exemplars) {
      write(root, `pre-change/${path}`, 'before\n');
      write(root, `pre-delete/${path}`, 'before\n');
    }
    const options = {
      ignoredPathspecs: flowProtectedIgnoredPathspecs(),
      ignoredPathFilter: (path) => isProtectedFlowPath(path),
    };
    const before = captureGitSnapshot(root, options);

    const expected = [];
    for (const { path } of exemplars) {
      const changed = `pre-change/${path}`;
      const removed = `pre-delete/${path}`;
      const created = `post-create/${path}`;
      write(root, changed, 'after\n');
      unlinkSync(join(root, ...removed.split('/')));
      write(root, created, 'after\n');
      expected.push(changed, removed, created);
    }
    write(root, 'controls/apiary.ts', 'ignored control\n');
    write(root, 'controls/capital.ts', 'ignored control\n');

    const drift = diffGitSnapshots(before, captureGitSnapshot(root, options));
    assert.deepEqual(drift.changedPaths, expected.sort());
    assert.equal(drift.changedPaths.some((path) => path.startsWith('controls/')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:OP-7] API pública de exemplos permanece derivada da política', () => {
  const examples = flowProtectedPolicyExamples();
  assert.equal(examples.length, FLOW_PROTECTED_RULES.reduce((sum, entry) => sum + entry.exemplars.length, 0));
  assert.ok(examples.some(({ path }) => path === 'schema.sql'));
  assert.ok(examples.some(({ path }) => /csrf/i.test(path)));
});

test('[req:OP-7] política co-localiza caps e exclusões do scan físico protegido', () => {
  assert.equal(Object.isFrozen(FLOW_PROTECTED_SCAN_POLICY), true);
  assert.ok(FLOW_PROTECTED_SCAN_POLICY.maxDepth > 0);
  assert.ok(FLOW_PROTECTED_SCAN_POLICY.maxEntries > 0);
  for (const name of ['.git', '.worktrees', 'node_modules', '.pnpm-store', '.venv']) {
    assert.ok(FLOW_PROTECTED_SCAN_POLICY.excludedDirectoryNames.includes(name), name);
  }

  const root = mkdtempSync(join(tmpdir(), 'wk-flow-policy-scan-'));
  try {
    const project = join(root, 'packages', 'app');
    const vault = join(project, '.vault');
    mkdirSync(vault, { recursive: true });
    const options = flowProtectedPhysicalScanOptions(project, root, {
      vaultBase: vault,
      protectedRoots: ['packages/app/private/**'],
    });
    assert.equal(options.pathPrefix, 'packages/app');
    assert.deepEqual(options.excludedPaths, ['.vault']);
    assert.equal(options.isProtectedPath('packages/app/src/auth'), true);
    assert.equal(options.isProtectedPath('packages/app/private/value.txt'), true);
    assert.equal(options.isProtectedPath('packages/app/src/author-card.ts'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
