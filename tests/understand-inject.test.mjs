// understand-inject SessionStart hook: injects a cheap slice of the
// Understand-Anything domain graph when generated, stays silent otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUnderstandInjection } from '../hooks/understand-inject.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

function projectWithGraph(graph) {
  const root = mkdtempSync(join(tmpdir(), 'wk-ua-'));
  mkdirSync(join(root, '.understand-anything'), { recursive: true });
  writeFileSync(
    join(root, '.understand-anything', 'knowledge-graph.json'),
    JSON.stringify(graph),
    'utf8',
  );
  return root;
}

const SAMPLE = {
  nodes: [
    { type: 'domain', name: 'Auth', summary: 'User authentication and sessions' },
    { type: 'flow', name: 'Login', summary: 'Email + password login flow' },
    { type: 'file', name: 'src/util.ts' },
  ],
};

test('buildUnderstandInjection: returns "" when no graph exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-ua-none-'));
  try {
    assert.equal(buildUnderstandInjection(root), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildUnderstandInjection: injects domain/flow nodes when graph exists', () => {
  const root = projectWithGraph(SAMPLE);
  try {
    const out = buildUnderstandInjection(root);
    assert.match(out, /<understand_domain_graph>/);
    assert.match(out, /Auth/);
    assert.match(out, /Login/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hook (via wendkeep hook): injects additionalContext when graph present', () => {
  const root = projectWithGraph(SAMPLE);
  try {
    const r = spawnSync(process.execPath, [BIN, 'hook', 'understand-inject'], {
      input: '{}',
      encoding: 'utf8',
      cwd: root,
    });
    assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /understand_domain_graph/);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hook (via wendkeep hook): stays silent (empty output) when no graph', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-ua-silent-'));
  try {
    const r = spawnSync(process.execPath, [BIN, 'hook', 'understand-inject'], {
      input: '{}',
      encoding: 'utf8',
      cwd: root,
    });
    assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
