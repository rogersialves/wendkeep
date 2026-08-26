import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../bin/wendkeep.mjs', import.meta.url));

function runCli(args) {
  const cwd = mkdtempSync(join(tmpdir(), 'wendkeep-node-compat-'));
  const env = { ...process.env };
  delete env.OBSIDIAN_VAULT_PATH;
  delete env.CLAUDE_PROJECT_DIR;
  try {
    return spawnSync(process.execPath, [cli, ...args], {
      cwd,
      env,
      encoding: 'utf8',
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('[req:CI-COMPAT-1] minimum Node imports every runtime boundary used by Core', async () => {
  const modules = await Promise.all([
    import('wendkeep/vault'),
    import('wendkeep/harness'),
    import('../packages/cli/src/index.mjs'),
    import('../packages/mcp/src/index.mjs'),
    import('../packages/integrations/src/index.mjs'),
    import('../packages/pi/src/index.mjs'),
  ]);
  for (const module of modules) assert.equal(typeof module, 'object');
});

test('[req:CI-COMPAT-2] CLI and MCP help start without project state', () => {
  for (const args of [['--help'], ['mcp', '--help']]) {
    const result = runCli(args);
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    assert.ifError(result.error);
    assert.equal(result.status, 0, output);
    assert.match(output, /wendkeep/i);
  }
});

test('[req:CI-COMPAT-3] Observer SQL stays import-safe below its minimum Node', async () => {
  const observer = await import('../src/observer-sql-store.mjs');
  const node18 = observer.observerSqlRuntimeSupport('18.20.0');
  assert.equal(node18.supported, false);
  assert.equal(node18.minimum, '22.13.0');

  const current = observer.observerSqlRuntimeSupport();
  if (current.supported) return;

  const dataDir = mkdtempSync(join(tmpdir(), 'wendkeep-observer-compat-'));
  try {
    assert.throws(
      () => observer.openObserverDatabase(dataDir),
      (error) => {
        assert.equal(error?.code, 'WENDKEEP_OBSERVER_NODE_UNSUPPORTED');
        assert.match(error?.message || '', /22\.13\.0/);
        return true;
      },
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
