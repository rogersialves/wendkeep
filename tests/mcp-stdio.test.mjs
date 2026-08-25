import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { createNativeMcpServer } from '../packages/mcp/src/server.mjs';
import { runNativeMcpStdio } from '../packages/mcp/src/stdio.mjs';
import { bindProjectVault } from '../packages/vault/src/project-vault.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

test('[req:MCP-3] stdio transport accepts newline JSON-RPC and emits only protocol frames', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let bytes = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => { bytes += chunk; });
  const done = runNativeMcpStdio({
    input,
    output,
    server: createNativeMcpServer({ executeTool: async () => ({ ok: true }) }),
  });
  input.end([
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'wendkeep_project_status', arguments: { project_root: 'C:/projects/a' },
    } }),
    '',
  ].join('\n'));
  await done;
  const frames = bytes.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(frames.map((frame) => frame.id), [1, 2]);
  assert.equal(frames[1].result.structuredContent.ok, true);
  assert.equal(frames[1].result.structuredContent.schema_version, 1);
});

test('[req:MCP-3] malformed frames return JSON-RPC parse errors without crashing transport', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let bytes = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => { bytes += chunk; });
  const done = runNativeMcpStdio({ input, output, server: createNativeMcpServer() });
  input.end('{invalid json}\n');
  await done;
  assert.equal(JSON.parse(bytes).error.code, -32700);
});

test('[req:MCP-3] packaged CLI exposes the native stdio server without dynamic dependencies', () => {
  const result = spawnSync(process.execPath, [BIN, 'mcp', 'serve'], {
    cwd: tmpdir(),
    encoding: 'utf8',
    input: `${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' },
    })}\n`,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result.serverInfo.name, 'wendkeep-native');
  assert.doesNotMatch(result.stderr, /npm|latest|download/i);
});

test('[req:MCP-3] MCP help is available without resolving a project or starting stdio', () => {
  const result = spawnSync(process.execPath, [BIN, 'mcp', '--help'], {
    cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, OBSIDIAN_VAULT_PATH: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wendkeep mcp <serve\|config>/);
});

test('[req:MCP-3] stdio CLI resolves a real bound project through the semantic executor', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-mcp-e2e-'));
  const project = join(root, 'project');
  const vault = join(root, 'vault');
  mkdirSync(project);
  mkdirSync(vault);
  const binding = bindProjectVault({ projectRoot: project, vaultPath: vault });
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'wendkeep_project_status', arguments: { project_root: project },
    } },
  ].map((frame) => JSON.stringify(frame)).join('\n') + '\n';
  const result = spawnSync(process.execPath, [BIN, 'mcp', 'serve', '--vault', vault], {
    cwd: project, encoding: 'utf8', input,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  const frames = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(frames[1].result.isError, false);
  assert.equal(frames[1].result.structuredContent.project_id, binding.projectId);
  assert.equal(frames[1].result.structuredContent.schema_version, 1);
});
