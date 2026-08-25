import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bindProjectVault } from '../packages/vault/src/project-vault.mjs';
import { executeNativeMcpTool } from '../packages/mcp/src/executor.mjs';

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
