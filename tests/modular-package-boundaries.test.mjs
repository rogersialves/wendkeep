import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importSpecifiers } from './helpers/import-specifiers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SURFACES = ['cli', 'harness', 'vault', 'mcp', 'integrations', 'pi'];
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

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('[req:MOD-1] root declares all six internal workspaces exactly once', () => {
  const root = json(join(ROOT, 'package.json'));
  const packageDirs = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
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
