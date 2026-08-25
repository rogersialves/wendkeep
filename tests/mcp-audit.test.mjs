import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMcpAuditor } from '../packages/mcp/src/audit.mjs';

test('[req:MCP-8] local audit is append-only metadata and ignores undeclared payload fields', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-mcp-audit-'));
  mkdirSync(join(vault, '.brain'));
  const audit = createMcpAuditor(vault, { now: () => new Date('2026-08-24T12:00:00.000Z') });
  await audit({
    tool: 'wendkeep_project_status', effect: 'read', capability: 'project:status',
    outcome: 'success', duration_ms: 2, payload: { token: 'must-not-persist' },
  });
  await audit({
    tool: 'wendkeep_task_claim', effect: 'write', capability: 'task:claim',
    outcome: 'error', error_code: 'MCP_CAPABILITY_REQUIRED', duration_ms: 3,
  });
  const raw = readFileSync(join(vault, '.brain', 'runtime', 'MCP_AUDIT.jsonl'), 'utf8');
  const rows = raw.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tool, 'wendkeep_project_status');
  assert.equal(rows[1].error_code, 'MCP_CAPABILITY_REQUIRED');
  assert.doesNotMatch(raw, /must-not-persist|token|payload/i);
});
