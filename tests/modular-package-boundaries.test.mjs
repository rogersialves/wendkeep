import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SURFACES = ['cli', 'harness', 'vault', 'mcp', 'integrations', 'pi'];

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
    const source = readFileSync(file, 'utf8');
    for (const pattern of [
      /\bfrom\s+['"]([^'"]+)['"]/g,
      /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\bimport\s+['"]([^'"]+)['"]/g,
      /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ]) {
      let match;
      while ((match = pattern.exec(source))) {
        const specifier = match[1];
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
  }
  assert.deepEqual(violations, []);
});
