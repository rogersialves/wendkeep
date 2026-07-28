// Transitional architecture guard before the physical cli/harness/vault split.
// Dependency direction is harness/profile -> Vault; Vault must remain reusable and
// unaware of governance policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importSpecifiers } from './helpers/import-specifiers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('[req:MOD-12] sensor configuration keeps every id unique', () => {
  const config = JSON.parse(readFileSync(join(ROOT, 'wendkeep.sensors.json'), 'utf8'));
  const ids = config.sensors.map((sensor) => sensor.id);
  assert.equal(new Set(ids).size, ids.length, 'wendkeep.sensors.json contains duplicate sensor ids');
});

const VAULT_MODULES = [
  'packages/vault/src/project-vault.mjs',
  'packages/vault/src/vault-path-safety.mjs',
  'src/project-vault.mjs',
  'src/validate-core.mjs',
  'src/validate-memory.mjs',
  'src/vault-readme.mjs',
  'src/vault-theme.mjs',
  'src/vault-views.mjs',
  'hooks/brain-core.mjs',
  'hooks/derived-sections.mjs',
  'hooks/linked-notes.mjs',
  'hooks/locale.mjs',
  'hooks/memory-handoff.mjs',
  'hooks/memory-mode.mjs',
  'hooks/memory-schema.mjs',
  'hooks/memory-store.mjs',
  'hooks/obsidian-common.mjs',
  'hooks/session-identity.mjs',
  'hooks/session-note-io.mjs',
  'hooks/vault-path-safety.mjs',
  'hooks/vault-health.mjs',
];

const HARNESS_MODULES = new Set([
  'packages/harness/src/index.mjs',
  'packages/harness/src/flow-store.mjs',
  'packages/harness/src/operating-profile.mjs',
  'packages/harness/src/sensors-core.mjs',
  'src/operating-profile.mjs',
  'src/profile.mjs',
  'src/flow.mjs',
  'src/change.mjs',
  'src/spec.mjs',
  'src/sensors.mjs',
  'src/verify.mjs',
  'hooks/change-core.mjs',
  'hooks/change-context.mjs',
  'hooks/change-guard.mjs',
  'hooks/change-nag.mjs',
  'hooks/change-warn.mjs',
  'hooks/sensors-core.mjs',
  'hooks/spec-core.mjs',
  'hooks/git-snapshot.mjs',
  'hooks/flow-protected-policy.mjs',
  'hooks/session-iteration.mjs',
  'hooks/flow-core.mjs',
  'hooks/vault-runtime-store.mjs',
]);

function modulesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = join(dir, entry.name);
    if (entry.isDirectory()) return modulesUnder(target);
    return entry.isFile() && /\.(?:mjs|js|cjs)$/.test(entry.name) ? [target] : [];
  });
}

function vaultBoundaryModules() {
  const canonical = modulesUnder(join(ROOT, 'packages', 'vault'))
    .map((file) => relative(ROOT, file).replaceAll('\\', '/'));
  return [...new Set([...VAULT_MODULES, ...canonical])];
}

function localImports(modulePath, absolute = join(ROOT, modulePath), specifiers = importSpecifiers(absolute)) {
  const dynamic = specifiers.filter((specifier) => specifier.startsWith('<dynamic:'));
  assert.deepEqual(dynamic, [], `${modulePath}: non-literal dependency cannot be verified`);
  return specifiers.filter((specifier) => specifier.startsWith('.')).map((specifier) => {
    const base = resolve(dirname(absolute), specifier);
    const target = [
      base,
      `${base}.mjs`, `${base}.js`, `${base}.cjs`,
      join(base, 'index.mjs'), join(base, 'index.js'), join(base, 'index.cjs'),
    ].find(existsSync);
    assert.ok(target, `${modulePath}: unresolved local import ${specifier}`);
    return relative(ROOT, target).replaceAll('\\', '/');
  });
}

function vaultHarnessViolations(modulePath, absolute = join(ROOT, modulePath)) {
  const violations = [];
  const specifiers = importSpecifiers(absolute);
  for (const specifier of specifiers) {
    const packagePath = specifier.startsWith('wendkeep/') ? specifier.slice('wendkeep/'.length) : '';
    if (
      specifier === 'wendkeep/harness'
      || specifier.startsWith('wendkeep/harness/')
      || specifier === '@wendkeep/harness'
      || specifier.startsWith('@wendkeep/harness/')
      || HARNESS_MODULES.has(packagePath)
      || packagePath.startsWith('packages/harness/')
    ) {
      violations.push(`${modulePath} -> ${specifier}`);
    }
  }
  for (const imported of localImports(modulePath, absolute, specifiers)) {
    if (HARNESS_MODULES.has(imported) || imported.startsWith('packages/harness/')) {
      violations.push(`${modulePath} -> ${imported}`);
    }
  }
  return violations;
}

test('[req:MOD-9] boundary scanner discovers every supported JavaScript module recursively', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-harness-boundary-'));
  try {
    mkdirSync(join(root, 'nested', 'deeper'), { recursive: true });
    writeFileSync(join(root, 'root.mjs'), 'export const root = true;\n');
    writeFileSync(join(root, 'nested', 'policy.js'), 'export const policy = true;\n');
    writeFileSync(join(root, 'nested', 'deeper', 'adapter.cjs'), 'module.exports = {};\n');
    writeFileSync(join(root, 'nested', 'ignored.txt'), 'not a module\n');

    const discovered = modulesUnder(root)
      .map((file) => relative(root, file).replaceAll('\\', '/'))
      .sort();
    assert.deepEqual(discovered, [
      'nested/deeper/adapter.cjs',
      'nested/policy.js',
      'root.mjs',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:MOD-9] boundary scanner recognizes ESM and CommonJS edges without comment or string false positives', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-harness-imports-'));
  const fixturePath = join(root, 'fixture.mjs');
  try {
    writeFileSync(fixturePath, [
      "import staticValue from './static.js';",
      "export { value } from './reexport.js';",
      "import './side-effect.mjs';",
      "const dynamicValue = await import('./dynamic.js', { with: { type: 'json' } });",
      "const common = require('./common.cjs');",
      "// require('./commented.cjs');",
      "const text = \"import './string.js'\";",
      "const template = `require('./template.cjs')`;",
      "object.require('./member.cjs');",
      "object.import('./member-import.js');",
      String.raw`const regex = /require\(['"]\.\/regex\.cjs['"]\)/;`,
      "const templateEdge = `${await import('./template-expression.mjs')}`;",
      "const moduleCommon = module.require('./module-require.cjs');",
      "const runtimeTarget = './runtime-target.js';",
      'void import(runtimeTarget);',
      'require(runtimeTarget);',
      'void staticValue; void dynamicValue; void common; void text; void template;',
      'void regex; void templateEdge; void moduleCommon;',
    ].join('\n'));

    assert.deepEqual(importSpecifiers(fixturePath), [
      './static.js',
      './reexport.js',
      './side-effect.mjs',
      './dynamic.js',
      './common.cjs',
      './template-expression.mjs',
      './module-require.cjs',
      '<dynamic:import>',
      '<dynamic:require>',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:MOD-9] [req:MOD-11] Vault boundary inventory covers every canonical workspace module', () => {
  const canonical = modulesUnder(join(ROOT, 'packages', 'vault'))
    .map((file) => relative(ROOT, file).replaceAll('\\', '/'));
  const inventory = vaultBoundaryModules();
  const missing = canonical.filter((modulePath) => !inventory.includes(modulePath));
  assert.deepEqual(missing, []);
  assert.ok(inventory.includes('packages/vault/src/locale.mjs'), 'missing canonical Vault locale boundary');
});

test('[req:MOD-9] Vault boundary rejects public and deep bare Harness specifiers', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-vault-bare-harness-'));
  const fixturePath = join(root, 'fixture.mjs');
  try {
    writeFileSync(fixturePath, [
      "import 'wendkeep/harness';",
      "import 'wendkeep/packages/harness/src/index.mjs';",
      "import '@wendkeep/harness';",
      "import 'wendkeep/hooks/sensors-core.mjs';",
    ].join('\n'));
    assert.deepEqual(vaultHarnessViolations('fixture.mjs', fixturePath), [
      'fixture.mjs -> wendkeep/harness',
      'fixture.mjs -> wendkeep/packages/harness/src/index.mjs',
      'fixture.mjs -> @wendkeep/harness',
      'fixture.mjs -> wendkeep/hooks/sensors-core.mjs',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:MOD-12] boundary inventory assigns the durable FLOW store to Harness', () => {
  assert.ok(HARNESS_MODULES.has('packages/harness/src/flow-store.mjs'));
  assert.ok(HARNESS_MODULES.has('hooks/vault-runtime-store.mjs'));
  assert.equal(VAULT_MODULES.includes('hooks/vault-runtime-store.mjs'), false);
  assert.ok(VAULT_MODULES.includes('hooks/vault-path-safety.mjs'));
});

test('[req:MOD-9] [req:MOD-12] Harness policy kernel is self-contained above the public Vault surface', () => {
  const harnessRoot = join(ROOT, 'packages', 'harness');
  const publicVaultIndex = join(ROOT, 'packages', 'vault', 'src', 'index.mjs');
  const modules = modulesUnder(harnessRoot);
  const inventory = modules.map((file) => relative(ROOT, file).replaceAll('\\', '/'));
  for (const required of [
    'packages/harness/src/index.mjs',
    'packages/harness/src/flow-store.mjs',
    'packages/harness/src/operating-profile.mjs',
    'packages/harness/src/sensors-core.mjs',
  ]) {
    assert.ok(inventory.includes(required), `missing Harness boundary module: ${required}`);
  }

  const violations = [];
  for (const absolute of modules) {
    const modulePath = relative(ROOT, absolute).replaceAll('\\', '/');
    for (const specifier of importSpecifiers(absolute)) {
      if (specifier.startsWith('node:')) continue;
      if (!specifier.startsWith('.')) {
        violations.push(`${modulePath} -> ${specifier}`);
        continue;
      }
      const target = resolve(dirname(absolute), specifier);
      if (target === publicVaultIndex) continue;
      const targetRelative = relative(harnessRoot, target);
      if (targetRelative.startsWith('..') || isAbsolute(targetRelative)) {
        violations.push(`${modulePath} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, [], `forbidden Harness dependencies:\n${violations.join('\n')}`);
});

test('[req:MOD-12] canonical FLOW store depends on the public Vault surface', () => {
  const modulePath = join(ROOT, 'packages', 'harness', 'src', 'flow-store.mjs');
  assert.ok(existsSync(modulePath), 'missing canonical Harness FLOW store boundary');
  assert.ok(
    importSpecifiers(modulePath).includes('../../vault/src/index.mjs'),
    'FLOW store must depend on the canonical index exported as wendkeep/vault',
  );
});

test('[req:OP-4] Vault modules do not import harness or operating-profile modules', () => {
  const violations = vaultBoundaryModules().flatMap((modulePath) => {
    assert.ok(existsSync(join(ROOT, modulePath)), `boundary inventory is stale: ${modulePath}`);
    return vaultHarnessViolations(modulePath);
  });
  assert.deepEqual(violations, [], `forbidden Vault -> harness dependencies:\n${violations.join('\n')}`);
});
