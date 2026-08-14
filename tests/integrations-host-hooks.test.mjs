import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST_HOOKS_PATH = resolve(ROOT, 'packages', 'integrations', 'src', 'host-hooks.mjs');
const HOST_HOOK_EXPORTS = [
  'CHANGE_GATE_HOOKS',
  'CHANGE_NUDGE_HOOKS',
  'CODEX_MATCHER_EVENTS',
  'SESSION_HOOKS',
  'codexHookEntry',
  'codexHookSpecs',
  'hookCommand',
  'hookCommandLocal',
  'hookCommandLocalLegacy',
];

test('[req:MOD-20] [req:MOD-21] Integrations owns host-hook rules while taxonomy remains identity-compatible', async () => {
  assert.ok(existsSync(HOST_HOOKS_PATH), 'missing canonical Integrations host-hook catalog');

  const [canonical, taxonomy] = await Promise.all([
    import('../packages/integrations/src/host-hooks.mjs'),
    import('../src/taxonomy.mjs'),
  ]);

  assert.deepEqual(Object.keys(canonical).sort(), [...HOST_HOOK_EXPORTS].sort());
  for (const name of HOST_HOOK_EXPORTS) {
    assert.equal(taxonomy[name], canonical[name], `taxonomy must preserve identity for ${name}`);
  }

  assert.deepEqual(canonical.CODEX_MATCHER_EVENTS, new Set(['SessionStart', 'PreToolUse']));
  assert.equal(canonical.hookCommand('session-stop'), 'npx wendkeep hook session-stop');
  assert.equal(
    canonical.hookCommandLocal('change-context'),
    'node "${CLAUDE_PROJECT_DIR}/node_modules/wendkeep/hooks/change-context.mjs"',
  );
  assert.equal(
    canonical.hookCommandLocalLegacy('change-context'),
    'node node_modules/wendkeep/hooks/change-context.mjs',
  );
  assert.deepEqual(
    canonical.codexHookSpecs([
      { name: 'session-start', codex: true },
      { name: 'custom-command', codex: true, command: 'echo custom' },
      { name: 'claude-only' },
    ]),
    [{ name: 'session-start', codex: true }],
  );
  assert.deepEqual(
    canonical.codexHookEntry({ name: 'session-stop', timeout: 60, statusMessage: 'checkpoint' }),
    {
      type: 'command',
      command: 'npx wendkeep hook session-stop',
      timeoutSec: 60,
      statusMessage: 'checkpoint',
    },
  );

  for (const excluded of [
    'HOOK_FILES',
    'RUNNABLE_HOOKS',
    'VAULT_FOLDERS',
    'COMPANIONS',
    'companionHookSpecs',
    'MCP_SERVER_KEY',
  ]) {
    assert.equal(excluded in canonical, false, `${excluded} must remain outside host-hooks.mjs`);
    assert.ok(excluded in taxonomy, `${excluded} must remain available from taxonomy.mjs`);
  }
});
