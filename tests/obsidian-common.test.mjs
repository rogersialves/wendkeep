// Unit tests for vault resolution + diagnostics helpers in hooks/obsidian-common.mjs.
// Covers debt fixes (1) vault-missing → warn loud, and (2) WENDKEEP_DEBUG logging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveVault,
  getVaultBase,
  debugLog,
  warnIfDefaultVault,
} from '../hooks/obsidian-common.mjs';
import { bindProjectVault } from '../src/project-vault.mjs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Temporarily set/unset env vars (undefined => deleted), restoring afterwards.
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// Capture everything written to process.stderr during fn().
function captureStderr(fn) {
  const orig = process.stderr.write;
  let out = '';
  process.stderr.write = (chunk) => {
    out += String(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return out;
}

test('resolveVault: explicit payload wins over a global environment path', () => {
  withEnv({ OBSIDIAN_VAULT_PATH: '/tmp/envvault' }, () => {
    const r = resolveVault({ obsidian_vault_path: '/tmp/payload' });
    assert.equal(r.source, 'payload');
    assert.equal(r.base, resolve('/tmp/payload'));
  });
});

test('resolveVault: discovers the nearest project binding', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-common-project-'));
  const nested = join(root, 'src', 'nested');
  const vault = join(root, '.vault');
  mkdirSync(nested, { recursive: true });
  try {
    bindProjectVault({ projectRoot: root, vaultPath: vault });
    const r = withEnv({ OBSIDIAN_VAULT_PATH: join(root, 'wrong') }, () => resolveVault({ cwd: nested }));
    assert.equal(r.source, 'project-config');
    assert.equal(r.base, resolve(vault));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('getVaultBase fails closed without a project binding', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-common-empty-'));
  withEnv({ OBSIDIAN_VAULT_PATH: undefined }, () => {
    assert.throws(() => getVaultBase({ cwd: root }), { code: 'WENDKEEP_VAULT_UNCONFIGURED' });
  });
  rmSync(root, { recursive: true, force: true });
});

test('debugLog: silent unless WENDKEEP_DEBUG set', () => {
  const out = withEnv({ WENDKEEP_DEBUG: undefined }, () =>
    captureStderr(() => debugLog('hello')),
  );
  assert.equal(out, '');
});

test('debugLog: writes to stderr when WENDKEEP_DEBUG set', () => {
  const out = withEnv({ WENDKEEP_DEBUG: '1' }, () =>
    captureStderr(() => debugLog('boom', new Error('x'))),
  );
  assert.match(out, /boom/);
});

test('warnIfDefaultVault: warns when using the legacy project-local Claude registration', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-common-legacy-'));
  const vault = join(root, '.vault');
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ env: { OBSIDIAN_VAULT_PATH: vault } }));
  let source;
  const out = withEnv({ OBSIDIAN_VAULT_PATH: undefined }, () =>
    captureStderr(() => {
      source = warnIfDefaultVault({ cwd: root });
    }),
  );
  assert.equal(source, 'legacy-project-settings');
  assert.match(out, /\.wendkeep\.json/);
  assert.match(out, /wendkeep init/);
  rmSync(root, { recursive: true, force: true });
});

test('warnIfDefaultVault: silent when the project binding is configured', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-common-configured-'));
  bindProjectVault({ projectRoot: root, vaultPath: join(root, '.vault') });
  let source;
  const out = withEnv({ OBSIDIAN_VAULT_PATH: join(root, 'wrong') }, () =>
    captureStderr(() => {
      source = warnIfDefaultVault({ cwd: root });
    }),
  );
  assert.equal(source, 'project-config');
  assert.equal(out, '');
  rmSync(root, { recursive: true, force: true });
});
