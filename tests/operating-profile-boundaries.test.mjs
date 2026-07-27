// Transitional architecture guard before the physical cli/harness/vault split.
// Dependency direction is harness/profile -> Vault; Vault must remain reusable and
// unaware of governance policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const VAULT_MODULES = [
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
  'hooks/vault-runtime-store.mjs',
  'hooks/vault-health.mjs',
];

const HARNESS_MODULES = new Set([
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
]);

function localImports(modulePath) {
  const absolute = join(ROOT, modulePath);
  const source = readFileSync(absolute, 'utf8');
  const specifiers = [];
  for (const pattern of [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ]) {
    let match;
    while ((match = pattern.exec(source))) specifiers.push(match[1]);
  }
  return specifiers.filter((specifier) => specifier.startsWith('.')).map((specifier) => {
    const base = resolve(dirname(absolute), specifier);
    const target = [base, `${base}.mjs`, join(base, 'index.mjs')].find(existsSync);
    assert.ok(target, `${modulePath}: unresolved local import ${specifier}`);
    return relative(ROOT, target).replaceAll('\\', '/');
  });
}

test('[req:OP-4] boundary inventory covers the durable FLOW vault store', () => {
  assert.ok(VAULT_MODULES.includes('hooks/vault-runtime-store.mjs'));
  assert.ok(VAULT_MODULES.includes('hooks/vault-path-safety.mjs'));
});

test('[req:OP-4] Vault modules do not import harness or operating-profile modules', () => {
  const violations = [];
  for (const modulePath of VAULT_MODULES) {
    assert.ok(existsSync(join(ROOT, modulePath)), `boundary inventory is stale: ${modulePath}`);
    for (const imported of localImports(modulePath)) {
      if (HARNESS_MODULES.has(imported)) violations.push(`${modulePath} -> ${imported}`);
    }
  }
  assert.deepEqual(violations, [], `forbidden Vault -> harness dependencies:\n${violations.join('\n')}`);
});
