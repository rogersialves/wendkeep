import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const PACKAGES = join(ROOT, 'packages');
const EXPECTED = Object.freeze([
  'cli', 'commit', 'contracts', 'evidence', 'harness', 'integrations', 'mcp', 'migrations',
  'observer', 'pi', 'sync', 'vault', 'worktrees',
]);
const PUBLIC = Object.freeze({
  './commit': './packages/commit/src/index.mjs',
  './contracts': './packages/contracts/src/index.mjs',
  './evidence': './packages/evidence/src/index.mjs',
  './harness': './packages/harness/src/index.mjs',
  './mcp': './packages/mcp/src/index.mjs',
  './migrations': './packages/migrations/src/index.mjs',
  './observer': './packages/observer/src/index.mjs',
  './sync': './packages/sync/src/index.mjs',
  './vault': './packages/vault/src/index.mjs',
  './worktrees': './packages/worktrees/src/index.mjs',
});
const FACADES = Object.freeze({
  'src/sync-protocol.mjs': "export * from '../packages/sync/src/sync-protocol.mjs';",
  'src/sync-outbox.mjs': "export * from '../packages/sync/src/sync-outbox.mjs';",
  'src/sync-adapters.mjs': "export * from '../packages/sync/src/sync-adapters.mjs';",
  'src/tdd-attestation.mjs': "export * from '../packages/contracts/src/tdd-attestation.mjs';",
  'src/tdd-attestation-store.mjs': "export * from '../packages/contracts/src/tdd-attestation-store.mjs';",
  'src/evidence-envelope.mjs': "export * from '../packages/evidence/src/evidence-envelope.mjs';",
  'src/provenance-gate.mjs': "export * from '../packages/evidence/src/provenance-gate.mjs';",
  'src/provenance-sources.mjs': "export * from '../packages/evidence/src/provenance-sources.mjs';",
  'src/receipt-ledger.mjs': "export * from '../packages/evidence/src/receipt-ledger.mjs';",
});
const COMPOSITION_IMPORTS = new Map([
  ['packages/cli/src/index.mjs', new Set([
    '../../../src/taxonomy.mjs', '../../../src/project-vault.mjs', '../../../src/flow.mjs',
    '../../../src/delivery.mjs', '../../../src/profile.mjs', '../../../src/context.mjs',
    '../../../src/portable.mjs', '../../../src/mcp.mjs', '../../../src/capabilities.mjs',
    '../../../src/ecosystem-bridges.mjs', '../../../src/init.mjs', '../../../src/doctor.mjs',
    '../../../src/observer.mjs', '../../../src/worktree.mjs', '../../../src/sync.mjs',
    '../../../src/memory.mjs', '../../../src/validate-core.mjs', '../../../src/memory-curate.mjs',
    '../../../src/sync-defs.mjs', '../../../src/change.mjs', '../../../src/task.mjs',
    '../../../src/tdd.mjs', '../../../src/session.mjs', '../../../src/theme.mjs',
    '../../../src/verify.mjs', '../../../src/lessons.mjs', '../../../src/spec.mjs',
    '../../../src/sensors.mjs', '../../../src/cost.mjs', '../../../src/stats.mjs',
    '../../../src/import.mjs', '../../../src/vault-views.mjs', '../../../src/renumber.mjs',
    '../../../src/note.mjs',
  ])],
  ['packages/commit/src/git-runtime.mjs', new Set([
    '../../../src/active-context-runtime.mjs', '../../../hooks/active-context-store.mjs',
    '../../../hooks/spec-core.mjs',
  ])],
  ['packages/mcp/src/executor.mjs', new Set([
    '../../../src/project-vault.mjs', '../../../src/operating-profile.mjs',
    '../../../src/context.mjs', '../../../src/memory.mjs',
    '../../../src/active-context-runtime.mjs', '../../../hooks/change-core.mjs',
    '../../../hooks/active-context-store.mjs', '../../../hooks/obsidian-common.mjs',
    '../../../src/observer-sql-store.mjs',
  ])],
]);

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function modules(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return modules(path);
    return entry.isFile() && entry.name.endsWith('.mjs') ? [path] : [];
  });
}

function packageOf(path) {
  const rel = relative(PACKAGES, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  return rel.split(sep)[0];
}

function packageEdges() {
  const graph = new Map(EXPECTED.map((name) => [name, new Set()]));
  const imports = /(?:\bfrom\s*|\bimport\s*\()\s*['"]([^'"]+)['"]/g;
  for (const file of modules(PACKAGES)) {
    const source = packageOf(file);
    for (const match of readFileSync(file, 'utf8').matchAll(imports)) {
      const specifier = match[1];
      let target = null;
      if (specifier.startsWith('.')) target = packageOf(resolve(dirname(file), specifier));
      else if (specifier.startsWith('@wendkeep/')) target = specifier.slice('@wendkeep/'.length).split('/')[0];
      if (target && target !== source && graph.has(target)) graph.get(source).add(target);
    }
  }
  return graph;
}

function assertAcyclic(graph) {
  const visiting = new Set();
  const visited = new Set();
  const visit = (node, trail = []) => {
    if (visiting.has(node)) assert.fail(`package cycle: ${[...trail, node].join(' -> ')}`);
    if (visited.has(node)) return;
    visiting.add(node);
    for (const target of graph.get(node) || []) visit(target, [...trail, node]);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of graph.keys()) visit(node);
}

test('[req:MOD-24] dependency-free release probe preserves package inventory, graph and facades', () => {
  const actual = readdirSync(PACKAGES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(actual, EXPECTED);

  for (const name of EXPECTED) {
    const manifest = json(join(PACKAGES, name, 'package.json'));
    assert.equal(manifest.name, `@wendkeep/${name}`, name);
    assert.equal(manifest.private, true, name);
  }

  const root = json(join(ROOT, 'package.json'));
  assert.deepEqual(root.workspaces, ['packages/*']);
  for (const [subpath, target] of Object.entries(PUBLIC)) assert.equal(root.exports[subpath], target, subpath);

  const graph = packageEdges();
  assertAcyclic(graph);
  assert.equal([...graph.get('cli')].includes('cli'), false);

  const unapprovedReverseImports = [];
  const observedImports = new Map([...COMPOSITION_IMPORTS].map(([file]) => [file, new Set()]));
  const imports = /(?:\bfrom\s*|\bimport\s*\()\s*['"]([^'"]+)['"]/g;
  for (const file of modules(PACKAGES)) {
    const owner = relative(ROOT, file).replaceAll('\\', '/');
    for (const match of readFileSync(file, 'utf8').matchAll(imports)) {
      if (!match[1].startsWith('.')) continue;
      const target = resolve(dirname(file), match[1]);
      if (packageOf(target)) continue;
      const allowed = COMPOSITION_IMPORTS.get(owner);
      if (allowed?.has(match[1])) observedImports.get(owner).add(match[1]);
      else unapprovedReverseImports.push(`${owner} -> ${match[1]}`);
    }
  }
  assert.deepEqual(unapprovedReverseImports, []);
  assert.deepEqual(observedImports, COMPOSITION_IMPORTS);

  for (const [path, expected] of Object.entries(FACADES)) {
    assert.equal(readFileSync(join(ROOT, path), 'utf8').trim(), expected, path);
  }
});
