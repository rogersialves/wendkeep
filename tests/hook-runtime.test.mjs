// End-to-end runtime contract for `wendkeep hook <name>` (debt fix 3b).
// Proves the package side of the hook contract: the spawned hook honors the
// OBSIDIAN_VAULT_PATH env it is given (regardless of cwd), emits a JSON object on
// stdout, and warns loudly on stderr when no vault is configured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'bin', 'wendkeep.mjs');

function runHook(name, { env, cwd, input = {} }) {
  return spawnSync(process.execPath, [BIN, 'hook', name], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    env,
  });
}

test('hook honors OBSIDIAN_VAULT_PATH and writes there (cwd-independent)', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-vault-'));
  const neutralCwd = mkdtempSync(join(tmpdir(), 'wk-cwd-'));
  try {
    const env = { ...process.env, OBSIDIAN_VAULT_PATH: vault };
    delete env.WENDKEEP_DEBUG;
    // simula runtime Codex: não vazar os marcadores de ambiente do Claude Code pai
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_SESSION_ID; delete env.CLAUDE_PROJECT_DIR;
    const transcript = join(neutralCwd, 'rollout.jsonl');
    writeFileSync(transcript, `${JSON.stringify({ type: 'session_meta', payload: { id: 'runtime-rollout', session_id: 'runtime-session', model_provider: 'openai' } })}\n`);
    const r = runHook('session-ensure', { env, cwd: neutralCwd, input: { transcript_path: transcript, session_id: 'runtime-session', prompt: 'test runtime' } });

    assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `stdout is JSON; got: ${r.stdout}`);
    assert.doesNotMatch(r.stderr || '', /WARNING: OBSIDIAN_VAULT_PATH/);
    assert.ok(
      readdirSync(vault).length > 0,
      'hook wrote into the env-configured vault, not elsewhere',
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(neutralCwd, { recursive: true, force: true });
  }
});

test('hook warns loudly on stderr when no vault is configured', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'wk-home-'));
  try {
    const env = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome };
    delete env.OBSIDIAN_VAULT_PATH;
    const r = runHook('session-ensure', { env, cwd: fakeHome });

    assert.equal(r.status, 0, `fail-open exit 0; stderr=\n${r.stderr}`);
    assert.match(r.stderr || '', /WARNING: OBSIDIAN_VAULT_PATH/);
    assert.match(r.stderr || '', /wendkeep init/);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
