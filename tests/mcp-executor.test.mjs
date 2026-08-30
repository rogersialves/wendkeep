import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bindProjectVault } from '../packages/vault/src/project-vault.mjs';
import { executeNativeMcpTool } from '../packages/mcp/src/executor.mjs';
import { ensureObserverDatabase, ingestObserverEvents, registerSqlProject } from '../src/observer-sql-store.mjs';
import { registerObserverToken } from '../packages/observer/src/token-registry.mjs';
import { makeDataDir } from './helpers/observer-fixture.mjs';

function boundProject(name) {
  const root = mkdtempSync(join(tmpdir(), `wk-mcp-${name}-`));
  const project = join(root, 'project');
  const vault = join(root, 'vault');
  mkdirSync(project);
  mkdirSync(vault);
  const binding = bindProjectVault({ projectRoot: project, vaultPath: vault });
  return { project, vault, projectId: binding.projectId };
}

test('[req:MCP-7] semantic reads resolve an explicit project without returning local paths', async () => {
  const fixture = boundProject('status');
  const result = await executeNativeMcpTool(
    { name: 'wendkeep_project_status' },
    { project_root: fixture.project },
  );
  assert.equal(result.project_id, fixture.projectId);
  assert.ok(['OFF', 'FLOW', 'GUIDE', 'GOVERN', 'ASSURE'].includes(result.profile));
  assert.doesNotMatch(JSON.stringify(result), /wk-mcp-status|[A-Z]:\\|\/tmp\//i);
});

test('[req:MCP-7] a foreign project declaration cannot borrow another project worktree binding', async () => {
  const first = boundProject('first');
  const second = boundProject('second');
  await assert.rejects(
    executeNativeMcpTool(
      { name: 'wendkeep_project_status' },
      { project_root: first.project, worktree_root: second.project },
    ),
    { code: 'MCP_PROJECT_SCOPE_MISMATCH' },
  );
});

test('[req:OBS-SEC-MCP] sensitive MCP reads require project-scoped capability and decrypt through the external key provider', async () => {
  const fixture = boundProject('observer-security');
  const dataDir = makeDataDir();
  const key = Buffer.alloc(32, 4);
  const db = ensureObserverDatabase(dataDir);
  try {
    registerSqlProject(db, { projectId: fixture.projectId });
    ingestObserverEvents(db, { projectId: fixture.projectId, events: [
      { schema_version: 1, event_id: 'mcp-session', kind: 'session.upsert', project_id: fixture.projectId, occurred_at: '2026-08-29T12:00:00.000Z', payload: { session_id: 'session-a' } },
      { schema_version: 1, event_id: 'mcp-agent', kind: 'agent.upsert', project_id: fixture.projectId, occurred_at: '2026-08-29T12:00:00.000Z', payload: { session_id: 'session-a', agent_id: 'agent-a', role: 'main' } },
      { schema_version: 1, event_id: 'mcp-call', kind: 'llm_call', project_id: fixture.projectId, occurred_at: '2026-08-29T12:00:00.000Z', payload: { call_id: 'call-a', session_id: 'session-a', agent_id: 'agent-a', role: 'main', prompt: 'encrypted MCP prompt', response: 'encrypted MCP response' } },
    ] });
    registerObserverToken(db, {
      tokenId: 'mcp-auditor', token: 'mcp-auditor-secret', role: 'auditor', projectIds: [fixture.projectId],
      scopes: ['usage:calls:read'], createdAt: '2026-08-29T12:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
    });
  } finally { db.close(); }
  const previous = {
    dataDir: process.env.WENDKEEP_OBSERVER_DATA_DIR,
    token: process.env.WENDKEEP_OBSERVER_TOKEN,
    key: process.env.WENDKEEP_OBSERVER_ENCRYPTION_KEY,
    keyId: process.env.WENDKEEP_OBSERVER_ENCRYPTION_KEY_ID,
  };
  try {
    process.env.WENDKEEP_OBSERVER_DATA_DIR = dataDir;
    delete process.env.WENDKEEP_OBSERVER_TOKEN;
    await assert.rejects(
      executeNativeMcpTool({ name: 'wendkeep_observer_query' }, { project_root: fixture.project, query: 'usage_calls' }),
      (error) => ['observer_token_missing', 'MCP_OBSERVER_AUTH_REQUIRED'].includes(error.code),
    );
    process.env.WENDKEEP_OBSERVER_TOKEN = 'mcp-auditor-secret';
    process.env.WENDKEEP_OBSERVER_ENCRYPTION_KEY = key.toString('base64');
    process.env.WENDKEEP_OBSERVER_ENCRYPTION_KEY_ID = 'mcp-key';
    const result = await executeNativeMcpTool(
      { name: 'wendkeep_observer_query' },
      { project_root: fixture.project, query: 'usage_calls' },
    );
    assert.equal(result.calls[0].prompt, 'encrypted MCP prompt');
    const protectedDb = ensureObserverDatabase(dataDir);
    try {
      const raw = protectedDb.prepare("SELECT prompt_text, response_text, prompt_envelope, response_envelope FROM llm_calls WHERE call_id = 'call-a'").get();
      assert.equal(JSON.stringify(raw).includes('encrypted MCP prompt'), false);
      assert.equal(JSON.stringify(raw).includes('encrypted MCP response'), false);
    } finally { protectedDb.close(); }
  } finally {
    for (const [name, value] of [
      ['WENDKEEP_OBSERVER_DATA_DIR', previous.dataDir],
      ['WENDKEEP_OBSERVER_TOKEN', previous.token],
      ['WENDKEEP_OBSERVER_ENCRYPTION_KEY', previous.key],
      ['WENDKEEP_OBSERVER_ENCRYPTION_KEY_ID', previous.keyId],
    ]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});
