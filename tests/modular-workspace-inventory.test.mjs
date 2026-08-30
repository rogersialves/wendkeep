import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SURFACES = ['cli', 'commit', 'harness', 'integrations', 'mcp', 'observer', 'pi', 'vault'];
const PUBLIC_PACKAGE_EXPORTS = new Map([
  ['./commit', './packages/commit/src/index.mjs'],
  ['./harness', './packages/harness/src/index.mjs'],
  ['./vault', './packages/vault/src/index.mjs'],
]);

const json = (path) => JSON.parse(readFileSync(path, 'utf8'));

test('[req:MOD-1] root inventory keeps eight exact private workspaces and only approved public surfaces', () => {
  const root = json(join(ROOT, 'package.json'));
  const packageDirs = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()
      && existsSync(join(ROOT, 'packages', entry.name, 'package.json')))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(packageDirs, SURFACES);
  assert.deepEqual(root.workspaces, ['packages/*']);
  assert.ok(root.files.includes('packages'));

  const manifests = SURFACES.map((surface) => json(join(ROOT, 'packages', surface, 'package.json')));
  const names = manifests.map((manifest) => manifest.name);
  assert.deepEqual(names, SURFACES.map((surface) => `@wendkeep/${surface}`));
  assert.equal(new Set(names).size, SURFACES.length);
  assert.ok(manifests.every((manifest) => manifest.private === true));

  const packageExports = Object.entries(root.exports)
    .filter(([, target]) => String(target).startsWith('./packages/'));
  assert.deepEqual(new Map(packageExports), PUBLIC_PACKAGE_EXPORTS);
  assert.equal(Object.hasOwn(root.exports, './observer'), false);
});
