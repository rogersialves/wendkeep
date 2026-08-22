import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readSessionRegistry, writeSessionRegistry } from '../hooks/obsidian-common.mjs';
import {
  clearActiveContextDelivery,
  projectLegacyActiveDelivery,
  resolveActiveContext,
  setActiveContextDelivery,
} from '../hooks/active-context-store.mjs';

function fixture() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-active-context-delivery-'));
  mkdirSync(join(vault, '.brain', 'runtime'), { recursive: true });
  writeSessionRegistry(vault, { version: 2, sessions: {} });
  return {
    vault,
    registry: join(vault, '.brain', 'SESSION_REGISTRY.json'),
    pointer: join(vault, '.brain', 'runtime', 'CURRENT_DELIVERY'),
  };
}

function identity(worktreeId, workSessionId) {
  return {
    projectId: 'project-1',
    repositoryId: 'repository-1',
    worktreeId,
    workSessionId,
    branch: `wk/${worktreeId}`,
    headSha: 'a'.repeat(40),
  };
}

test('[req:ACTX-14] delivery bindings are isolated and clear preserves the sibling', () => {
  const f = fixture();
  try {
    const a = identity('worktree-a', 'work-a');
    const b = identity('worktree-b', 'work-b');
    setActiveContextDelivery(f.vault, a, 'release-a');
    setActiveContextDelivery(f.vault, b, 'release-b');

    assert.equal(resolveActiveContext(f.vault, a).delivery_id, 'release-a');
    assert.equal(resolveActiveContext(f.vault, b).delivery_id, 'release-b');
    assert.equal(readFileSync(f.pointer, 'utf8'), '');

    clearActiveContextDelivery(f.vault, a);
    assert.equal(resolveActiveContext(f.vault, a).delivery_id, '');
    assert.equal(resolveActiveContext(f.vault, b).delivery_id, 'release-b');
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:ACTX-15] legacy delivery projection is empty for zero or multiple active contexts', () => {
  const f = fixture();
  try {
    writeFileSync(f.pointer, 'stale-delivery\n', 'utf8');
    assert.equal(projectLegacyActiveDelivery(f.vault), '');
    assert.equal(readFileSync(f.pointer, 'utf8'), '');

    setActiveContextDelivery(f.vault, identity('worktree-a', 'work-a'), 'release-a');
    assert.equal(readFileSync(f.pointer, 'utf8'), 'release-a\n');

    setActiveContextDelivery(f.vault, identity('worktree-b', 'work-b'), 'release-b');
    assert.equal(readFileSync(f.pointer, 'utf8'), '');
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:ACTX-15] failed context persistence publishes no delivery projection', () => {
  const f = fixture();
  try {
    writeFileSync(f.pointer, 'previous-delivery\n', 'utf8');
    const beforeRegistry = readFileSync(f.registry);
    const beforePointer = readFileSync(f.pointer);
    let staged = false;

    assert.throws(
      () => setActiveContextDelivery(f.vault, identity('worktree-a', 'work-a'), 'release-a', {
        mutateRegistry: (vaultBase, mutator) => {
          const candidate = readSessionRegistry(vaultBase);
          mutator(candidate);
          staged = true;
          throw new Error('simulated registry persistence failure');
        },
      }),
      /simulated registry persistence failure/,
    );
    assert.equal(staged, true);
    assert.deepEqual(readFileSync(f.registry), beforeRegistry);
    assert.deepEqual(readFileSync(f.pointer), beforePointer);
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});
