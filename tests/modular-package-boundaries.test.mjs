import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { importSpecifiers } from './helpers/import-specifiers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SURFACES = [
  'cli', 'commit', 'contracts', 'evidence', 'harness', 'integrations', 'mcp', 'migrations',
  'observer', 'pi', 'sync', 'vault', 'worktrees',
];
const ADAPTERS = new Set(['cli', 'mcp', 'integrations', 'pi']);
const INITIAL_MEMORY_KERNEL = [
  { module: 'memory-schema.mjs', legacy: '../hooks/memory-schema.mjs' },
  { module: 'memory-mode.mjs', legacy: '../hooks/memory-mode.mjs' },
  { module: 'memory-handoff.mjs', legacy: '../hooks/memory-handoff.mjs' },
  { module: 'validate-core.mjs', legacy: '../src/validate-core.mjs' },
  { module: 'validate-memory.mjs', legacy: '../src/validate-memory.mjs' },
];
const HARNESS_POLICY_KERNEL = [
  { module: 'operating-profile.mjs', legacy: '../src/operating-profile.mjs' },
  { module: 'sensors-core.mjs', legacy: '../hooks/sensors-core.mjs' },
];
const INTEGRATIONS_KERNEL = [
  'index.mjs',
  'host-hooks.mjs',
  'hook-envelope.mjs',
  'prompt-content.mjs',
  'transcript-usage.mjs',
  'transcripts.mjs',
  'session-identity.mjs',
];
const EFFECTFUL_BUILTINS = /^(?:node:)?(?:child_process|cluster|dgram|dns|fs|fs\/promises|http|https|net|readline|tls|worker_threads)$/;
const DOMAIN_FACADES = [
  ['src/sync-protocol.mjs', '../packages/sync/src/sync-protocol.mjs'],
  ['src/sync-outbox.mjs', '../packages/sync/src/sync-outbox.mjs'],
  ['src/sync-adapters.mjs', '../packages/sync/src/sync-adapters.mjs'],
  ['src/tdd-attestation.mjs', '../packages/contracts/src/tdd-attestation.mjs'],
  ['src/tdd-attestation-store.mjs', '../packages/contracts/src/tdd-attestation-store.mjs'],
  ['src/evidence-envelope.mjs', '../packages/evidence/src/evidence-envelope.mjs'],
  ['src/provenance-gate.mjs', '../packages/evidence/src/provenance-gate.mjs'],
  ['src/provenance-sources.mjs', '../packages/evidence/src/provenance-sources.mjs'],
  ['src/receipt-ledger.mjs', '../packages/evidence/src/receipt-ledger.mjs'],
];
const PACKAGE_COMPOSITION_IMPORTS = new Map([
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

function assertPureFacade(path, expectedSpecifier) {
  const source = readFileSync(path, 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  assert.ok(ast.body.length > 0, `${relative(ROOT, path)} must re-export its canonical module`);
  assert.ok(ast.body.every((node) => (
    (node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration')
      && node.source?.value === expectedSpecifier
  )), `${relative(ROOT, path)} must contain only re-exports from ${expectedSpecifier}`);
}

function assertSameBindings(canonical, publicSurface, legacy, label) {
  assert.ok(Object.keys(canonical).length > 0, `${label} must export at least one binding`);
  for (const [name, value] of Object.entries(canonical)) {
    assert.equal(publicSurface[name], value, `${label}: public identity differs for ${name}`);
    assert.equal(legacy[name], value, `${label}: legacy identity differs for ${name}`);
  }
  assert.deepEqual(Object.keys(legacy).sort(), Object.keys(canonical).sort());
}

function moduleFilesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return moduleFilesUnder(path);
    return /\.(?:cjs|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

function normalizedRelative(from, to) {
  return relative(from, to).replaceAll('\\', '/');
}

function packageDependency(owner, file, specifier) {
  if (specifier.startsWith('<dynamic:') || specifier.startsWith('node:')) return null;
  const internal = specifier.match(/^@wendkeep\/([^/]+)(?:\/|$)/)
    || specifier.match(/^wendkeep\/(?:packages\/)?([^/]+)(?:\/|$)/);
  if (internal) return internal[1];
  if (!specifier.startsWith('.')) return null;

  let target;
  try {
    target = resolve(dirname(file), decodeURIComponent(specifier));
  } catch {
    return '<invalid>';
  }
  const match = normalizedRelative(join(ROOT, 'packages'), target).match(/^([^/]+)(?:\/|$)/);
  return match && !match[1].startsWith('.') && match[1] !== owner ? match[1] : null;
}

function assertAcyclic(graph) {
  const visiting = new Set();
  const visited = new Set();
  function visit(node, trail = []) {
    if (visiting.has(node)) assert.fail(`package dependency cycle: ${[...trail, node].join(' -> ')}`);
    if (visited.has(node)) return;
    visiting.add(node);
    for (const dependency of graph.get(node) || []) visit(dependency, [...trail, node]);
    visiting.delete(node);
    visited.add(node);
  }
  for (const node of graph.keys()) visit(node);
}

function assertAdapterSiblings(graph) {
  for (const owner of ADAPTERS) {
    for (const dependency of graph.get(owner) || []) {
      if (ADAPTERS.has(dependency)) {
        assert.fail(`adapter dependency forbidden: ${owner} -> ${dependency}`);
      }
    }
  }
}

test('[req:MOD-22] root declares every control-plane workspace and public domain export exactly once', () => {
  const root = json(join(ROOT, 'package.json'));
  const packageDirs = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()
      && existsSync(join(ROOT, 'packages', entry.name, 'package.json')))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(packageDirs, [...SURFACES].sort());
  assert.deepEqual(root.workspaces, ['packages/*']);
  assert.ok(root.files.includes('packages'));
  const names = SURFACES.map((surface) => json(
    join(ROOT, 'packages', surface, 'package.json'),
  ).name);
  assert.deepEqual(names, SURFACES.map((surface) => `@wendkeep/${surface}`));
  assert.equal(new Set(names).size, SURFACES.length);
  assert.ok(SURFACES.every((surface) => json(
    join(ROOT, 'packages', surface, 'package.json'),
  ).private === true));
  for (const surface of [
    'contracts', 'evidence', 'mcp', 'migrations', 'observer', 'sync', 'worktrees',
  ]) {
    assert.equal(root.exports[`./${surface}`], `./packages/${surface}/src/index.mjs`, `missing public ${surface} export`);
  }
});

test('[req:MOD-23] legacy domain modules are pure facades over package-owned implementations', async () => {
  for (const [legacyPath, canonicalSpecifier] of DOMAIN_FACADES) {
    const legacy = join(ROOT, legacyPath);
    assertPureFacade(legacy, canonicalSpecifier);
    const [canonical, facade] = await Promise.all([
      import(canonicalSpecifier),
      import(`../${legacyPath}`),
    ]);
    assertSameBindings(canonical, canonical, facade, legacyPath);
  }
});

test('[req:MOD-2] wendkeep/vault and legacy paths expose identical bindings', async () => {
  const root = json(join(ROOT, 'package.json'));
  assert.equal(root.exports['./vault'], './packages/vault/src/index.mjs');

  const [surface, legacyBinding, legacySafety] = await Promise.all([
    import('wendkeep/vault'),
    import('../src/project-vault.mjs'),
    import('../hooks/vault-path-safety.mjs'),
  ]);
  for (const [name, value] of Object.entries(legacyBinding)) assert.equal(surface[name], value);
  for (const [name, value] of Object.entries(legacySafety)) assert.equal(surface[name], value);
});

test('[req:MOD-5] [req:MOD-6] Vault owns the initial memory kernel and preserves legacy identities', async () => {
  const surface = await import('wendkeep/vault');

  for (const entry of INITIAL_MEMORY_KERNEL) {
    const implementation = join(ROOT, 'packages', 'vault', 'src', entry.module);
    assert.ok(existsSync(implementation), `missing Vault implementation: ${entry.module}`);

    const [kernel, legacy] = await Promise.all([
      import(`../packages/vault/src/${entry.module}`),
      import(entry.legacy),
    ]);
    for (const [name, value] of Object.entries(legacy)) {
      assert.equal(kernel[name], value, `${entry.module} must preserve legacy identity for ${name}`);
      assert.equal(surface[name], value, `wendkeep/vault must expose ${name}`);
    }
  }
});

test('[req:MOD-5] [req:MOD-6] Vault owns the memory store without changing its public identity', async () => {
  const implementation = join(ROOT, 'packages', 'vault', 'src', 'memory-store.mjs');
  assert.ok(existsSync(implementation), 'missing Vault implementation: memory-store.mjs');

  const [surface, kernel, legacy] = await Promise.all([
    import('wendkeep/vault'),
    import('../packages/vault/src/memory-store.mjs'),
    import('../hooks/memory-store.mjs'),
  ]);
  for (const [name, value] of Object.entries(legacy)) {
    assert.equal(kernel[name], value, `memory-store.mjs must preserve legacy identity for ${name}`);
    assert.equal(surface[name], value, `wendkeep/vault must expose ${name}`);
  }
  assert.equal(kernel.canonicalMemoryJson({ z: 1, a: 2 }), '{"a":2,"z":1}');
  assert.equal(surface.MEMORY_LOCK_BUSY, surface.VAULT_LOCK_BUSY);
});

test('[req:MOD-8] Harness owns the policy kernel and preserves legacy identities', async () => {
  for (const entry of HARNESS_POLICY_KERNEL) {
    const implementation = join(ROOT, 'packages', 'harness', 'src', entry.module);
    assert.ok(existsSync(implementation), `missing Harness implementation: ${entry.module}`);

    const [kernel, legacy] = await Promise.all([
      import(`../packages/harness/src/${entry.module}`),
      import(entry.legacy),
    ]);
    for (const [name, value] of Object.entries(legacy)) {
      assert.equal(kernel[name], value, `${entry.module} must preserve legacy identity for ${name}`);
    }
  }
});

test('[req:MOD-11] Vault owns locale through one public and legacy-compatible implementation', async () => {
  const implementation = join(ROOT, 'packages', 'vault', 'src', 'locale.mjs');
  const facade = join(ROOT, 'hooks', 'locale.mjs');
  assert.ok(existsSync(implementation), 'missing Vault implementation: locale.mjs');
  assertPureFacade(facade, '../packages/vault/src/locale.mjs');

  const [canonical, publicSurface, legacy] = await Promise.all([
    import('../packages/vault/src/locale.mjs'),
    import('wendkeep/vault'),
    import('../hooks/locale.mjs'),
  ]);
  assertSameBindings(canonical, publicSurface, legacy, 'locale.mjs');
});

test('[req:MOD-12] Harness owns the FLOW store through one public and legacy-compatible implementation', async () => {
  const implementation = join(ROOT, 'packages', 'harness', 'src', 'flow-store.mjs');
  const facade = join(ROOT, 'hooks', 'vault-runtime-store.mjs');
  assert.ok(existsSync(implementation), 'missing Harness implementation: flow-store.mjs');
  assertPureFacade(facade, '../packages/harness/src/flow-store.mjs');

  const [canonical, publicSurface, legacy] = await Promise.all([
    import('../packages/harness/src/flow-store.mjs'),
    import('wendkeep/harness'),
    import('../hooks/vault-runtime-store.mjs'),
  ]);
  assertSameBindings(canonical, publicSurface, legacy, 'flow-store.mjs');
});

test('[req:MOD-3] Vault imports only Node built-ins or modules inside its workspace', () => {
  const vaultRoot = join(ROOT, 'packages', 'vault');
  const files = (function modulesUnder(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return modulesUnder(path);
      return /\.(?:cjs|js|mjs)$/.test(entry.name) ? [path] : [];
    });
  }(vaultRoot));
  assert.ok(files.some((path) => path.endsWith('project-vault.mjs')));
  assert.ok(files.some((path) => path.endsWith('vault-path-safety.mjs')));

  const violations = [];
  for (const file of files) {
    for (const specifier of importSpecifiers(file)) {
      if (specifier.startsWith('node:')) continue;
      if (!specifier.startsWith('.')) {
        violations.push(`${relative(vaultRoot, file)} -> ${specifier}`);
        continue;
      }
      const target = resolve(dirname(file), specifier);
      const escaped = relative(vaultRoot, target).replaceAll('\\', '/');
      if (escaped === '..' || escaped.startsWith('../')) {
        violations.push(`${relative(vaultRoot, file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('[req:MOD-20] [req:MOD-21] Integrations is a private, inert adapter sibling of MCP', () => {
  const workspace = json(join(ROOT, 'packages', 'integrations', 'package.json'));
  const root = json(join(ROOT, 'package.json'));
  assert.equal(workspace.private, true);
  assert.equal(workspace.exports, './src/index.mjs');
  assert.equal(Object.hasOwn(root.exports, './integrations'), false);
  assert.equal(Object.hasOwn(root.exports, './*'), false);
  const publicPackageTargets = new Set([
    './packages/commit/src/index.mjs',
    './packages/contracts/src/index.mjs',
    './packages/evidence/src/index.mjs',
    './packages/harness/src/index.mjs',
    './packages/mcp/src/index.mjs',
    './packages/migrations/src/index.mjs',
    './packages/observer/src/index.mjs',
    './packages/sync/src/index.mjs',
    './packages/vault/src/index.mjs',
    './packages/worktrees/src/index.mjs',
  ]);
  assert.equal(
    Object.entries(root.exports).some(([key, target]) => (
      key.startsWith('./packages')
      || (String(target).startsWith('./packages') && !publicPackageTargets.has(target))
    )),
    false,
  );

  const integrationsRoot = join(ROOT, 'packages', 'integrations');
  const srcRoot = join(integrationsRoot, 'src');
  for (const module of INTEGRATIONS_KERNEL) {
    assert.ok(existsSync(join(srcRoot, module)), `missing Integrations kernel module: ${module}`);
  }

  const violations = [];
  for (const file of moduleFilesUnder(srcRoot)) {
    for (const specifier of importSpecifiers(file)) {
      if (specifier.startsWith('<dynamic:') || EFFECTFUL_BUILTINS.test(specifier)) {
        violations.push(`${normalizedRelative(integrationsRoot, file)} -> ${specifier}`);
        continue;
      }
      if (specifier.startsWith('node:')) continue;
      if (!specifier.startsWith('.')) {
        violations.push(`${normalizedRelative(integrationsRoot, file)} -> ${specifier}`);
        continue;
      }
      let target;
      try {
        target = resolve(dirname(file), decodeURIComponent(specifier));
      } catch {
        violations.push(`${normalizedRelative(integrationsRoot, file)} -> ${specifier}`);
        continue;
      }
      const escaped = normalizedRelative(integrationsRoot, target);
      if (escaped === '..' || escaped.startsWith('../')) {
        violations.push(`${normalizedRelative(integrationsRoot, file)} -> ${specifier}`);
      }
    }
  }

  for (const file of moduleFilesUnder(join(ROOT, 'packages', 'mcp', 'src'))) {
    for (const specifier of importSpecifiers(file)) {
      if (packageDependency('mcp', file, specifier) === 'integrations') {
        violations.push(`${normalizedRelative(ROOT, file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('[req:MOD-21] package dependency direction is acyclic', () => {
  const graph = new Map(SURFACES.map((surface) => [surface, new Set()]));
  for (const surface of SURFACES) {
    const src = join(ROOT, 'packages', surface, 'src');
    for (const file of moduleFilesUnder(src)) {
      for (const specifier of importSpecifiers(file)) {
        const dependency = packageDependency(surface, file, specifier);
        if (graph.has(dependency)) graph.get(surface).add(dependency);
      }
    }
  }
  assertAcyclic(graph);
  assertAdapterSiblings(graph);

  assert.throws(
    () => assertAcyclic(new Map([
      ['mcp', new Set(['integrations'])],
      ['integrations', new Set(['mcp'])],
    ])),
    /dependency cycle/,
  );
  assert.equal(
    packageDependency(
      'integrations',
      join(ROOT, 'packages', 'integrations', 'src', 'index.mjs'),
      '../../mcp/src/index.mjs',
    ),
    'mcp',
  );
  assert.throws(
    () => assertAdapterSiblings(new Map([
      ['cli', new Set(['integrations'])],
      ['integrations', new Set()],
    ])),
    /adapter dependency forbidden: cli -> integrations/,
  );
  assert.throws(
    () => assertAdapterSiblings(new Map([
      ['pi', new Set(['mcp'])],
      ['mcp', new Set()],
    ])),
    /adapter dependency forbidden: pi -> mcp/,
  );
});

test('[req:MOD-21] packages cannot import legacy src/hooks outside explicit composition roots', () => {
  const packagesRoot = join(ROOT, 'packages');
  const violations = [];
  const observedCompositionImports = new Map(
    [...PACKAGE_COMPOSITION_IMPORTS].map(([file]) => [file, new Set()]),
  );
  for (const file of moduleFilesUnder(packagesRoot)) {
    const relativeFile = normalizedRelative(ROOT, file);
    for (const specifier of importSpecifiers(file)) {
      if (!specifier.startsWith('.')) continue;
      let target;
      try { target = resolve(dirname(file), decodeURIComponent(specifier)); }
      catch { continue; }
      const escaped = normalizedRelative(packagesRoot, target);
      if (escaped !== '..' && !escaped.startsWith('../')) continue;
      const allowed = PACKAGE_COMPOSITION_IMPORTS.get(relativeFile);
      if (allowed?.has(specifier)) observedCompositionImports.get(relativeFile).add(specifier);
      else violations.push(`${relativeFile} -> ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
  assert.deepEqual(observedCompositionImports, PACKAGE_COMPOSITION_IMPORTS);

  const detectorTarget = resolve(
    dirname(join(ROOT, 'packages', 'worktrees', 'src', 'probe.mjs')),
    '../../../hooks/active-context-store.mjs',
  );
  const escaped = normalizedRelative(packagesRoot, detectorTarget);
  assert.equal(escaped.startsWith('../'), true, 'mutant reverse import must be detected');
});
