// End-to-end runtime contract for `wendkeep hook <name>` (debt fix 3b).
// Proves the package side of the hook contract: the spawned hook discovers the
// project-local binding from cwd, emits JSON on stdout, and fails closed when absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindProjectVault } from '../src/project-vault.mjs';

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

test('Codex hook discovers the project vault and ignores a wrong global env', () => {
  const neutralCwd = mkdtempSync(join(tmpdir(), 'wk-cwd-'));
  const vault = join(neutralCwd, '.vault');
  try {
    bindProjectVault({ projectRoot: neutralCwd, vaultPath: vault });
    const env = { ...process.env, OBSIDIAN_VAULT_PATH: join(neutralCwd, 'wrong-global-vault') };
    delete env.WENDKEEP_DEBUG;
    // simula runtime Codex: não vazar os marcadores de ambiente do Claude Code pai
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_SESSION_ID; delete env.CLAUDE_PROJECT_DIR;
    const transcript = join(neutralCwd, 'rollout.jsonl');
    writeFileSync(transcript, `${JSON.stringify({ type: 'session_meta', payload: { id: 'runtime-rollout', session_id: 'runtime-session', model_provider: 'openai' } })}\n`);
    const r = runHook('session-ensure', { env, cwd: neutralCwd, input: { transcript_path: transcript, session_id: 'runtime-session', prompt: 'test runtime' } });

    assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `stdout is JSON; got: ${r.stdout}`);
    assert.doesNotMatch(r.stderr || '', /wendkeep init/);
    assert.ok(
      readdirSync(vault).length > 0,
      'hook wrote into the project-configured vault',
    );
    assert.equal(existsSync(join(neutralCwd, 'wrong-global-vault')), false);
  } finally {
    rmSync(neutralCwd, { recursive: true, force: true });
  }
});

test('hook fails closed when no project vault is configured', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'wk-home-'));
  try {
    const env = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome };
    delete env.OBSIDIAN_VAULT_PATH;
    const r = runHook('session-ensure', { env, cwd: fakeHome });

    assert.equal(r.status, 0, `fail-closed hook exit 0; stderr=\n${r.stderr}`);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `stdout is JSON; got: ${r.stdout}`);
    assert.match(r.stderr || '', /\.wendkeep\.json/);
    assert.match(r.stderr || '', /wendkeep init/);
    assert.deepEqual(readdirSync(fakeHome), [], 'no fallback vault or session file was created');
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
