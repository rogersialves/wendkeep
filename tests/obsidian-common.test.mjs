// Unit tests for vault resolution + diagnostics helpers in hooks/obsidian-common.mjs.
// Covers debt fixes (1) vault-missing → warn loud, and (2) WENDKEEP_DEBUG logging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveVault,
  getVaultBase,
  debugLog,
  warnIfDefaultVault,
  DEFAULT_VAULT_BASE,
} from '../hooks/obsidian-common.mjs';

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

test('resolveVault: OBSIDIAN_VAULT_PATH wins, source "env"', () => {
  withEnv({ OBSIDIAN_VAULT_PATH: '/tmp/envvault' }, () => {
    const r = resolveVault({ obsidian_vault_path: '/tmp/payload' });
    assert.equal(r.source, 'env');
    assert.equal(r.base, '/tmp/envvault');
  });
});

test('resolveVault: payload used when env unset, source "payload"', () => {
  withEnv({ OBSIDIAN_VAULT_PATH: undefined }, () => {
    const r = resolveVault({ obsidian_vault_path: '/tmp/payload' });
    assert.equal(r.source, 'payload');
    assert.equal(r.base, '/tmp/payload');
  });
});

test('resolveVault: falls back to DEFAULT_VAULT_BASE, source "default"', () => {
  withEnv({ OBSIDIAN_VAULT_PATH: undefined }, () => {
    const r = resolveVault({});
    assert.equal(r.source, 'default');
    assert.equal(r.base, DEFAULT_VAULT_BASE);
  });
});

test('getVaultBase stays backward-compatible', () => {
  withEnv({ OBSIDIAN_VAULT_PATH: '/tmp/envvault' }, () => {
    assert.equal(getVaultBase({ obsidian_vault_path: '/tmp/p' }), '/tmp/envvault');
  });
  withEnv({ OBSIDIAN_VAULT_PATH: undefined }, () => {
    assert.equal(getVaultBase({}), DEFAULT_VAULT_BASE);
  });
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

test('warnIfDefaultVault: warns loudly when falling back to default', () => {
  let source;
  const out = withEnv({ OBSIDIAN_VAULT_PATH: undefined }, () =>
    captureStderr(() => {
      source = warnIfDefaultVault({});
    }),
  );
  assert.equal(source, 'default');
  assert.match(out, /OBSIDIAN_VAULT_PATH/);
  assert.match(out, /wendkeep init/);
});

test('warnIfDefaultVault: silent when env vault configured', () => {
  let source;
  const out = withEnv({ OBSIDIAN_VAULT_PATH: '/tmp/envvault' }, () =>
    captureStderr(() => {
      source = warnIfDefaultVault({});
    }),
  );
  assert.equal(source, 'env');
  assert.equal(out, '');
});
