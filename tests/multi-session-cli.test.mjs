import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { newChange } from '../hooks/change-core.mjs';
import { readSessionRegistry, upsertSessionRegistry } from '../hooks/obsidian-common.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

function run(vault, args) {
  return spawnSync(process.execPath, [BIN, ...args, '--vault', vault], { encoding: 'utf8' });
}

test('session list/show e change bind operam sobre vínculo por conversa', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-multi-cli-'));
  try {
    upsertSessionRegistry(vault, 'codex-a', { status: 'active', provider: 'codex', session_file: '02-Sessões/a.md', transcript_path: 'a.jsonl' });
    upsertSessionRegistry(vault, 'claude-b', { status: 'active', provider: 'claude', session_file: '02-Sessões/b.md', transcript_path: 'b.jsonl' });
    newChange(vault, 'feature-a', { dateStr: '2026-07-12' });
    const bind = run(vault, ['change', 'bind', 'feature-a', '--session', 'codex-a']);
    assert.equal(bind.status, 0, bind.stderr);
    assert.equal(readSessionRegistry(vault).sessions['codex-a'].change_slug, 'feature-a');
    assert.equal(readSessionRegistry(vault).sessions['claude-b'].change_slug, undefined);
    const list = run(vault, ['session', 'list']);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /codex-a.*feature-a/);
    assert.match(list.stdout, /claude-b/);
    const show = run(vault, ['session', 'show', 'codex-a']);
    assert.equal(show.status, 0, show.stderr);
    assert.equal(JSON.parse(show.stdout).change_slug, 'feature-a');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
