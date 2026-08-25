import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MCP_EFFECT_MANIFEST,
  resolveMcpToolEffect,
  verifyMcpEffectManifest,
} from '../packages/mcp/src/effects.mjs';
import { scopeDecision } from '../hooks/project-scope.mjs';
import { renderMcpClientConfig } from '../packages/mcp/src/config.mjs';

test('[req:MCP-1] signed catalog resolves exact tools and declared host aliases', () => {
  assert.equal(verifyMcpEffectManifest(MCP_EFFECT_MANIFEST).valid, true);
  assert.ok(MCP_EFFECT_MANIFEST.tools.every((tool) => (
    tool.input_schema === 'wendkeep://schema/mcp-tool-input-v1'
      && tool.output_schema === 'wendkeep://schema/mcp-tool-result-v1'
  )));
  assert.deepEqual(resolveMcpToolEffect('wendkeep_project_status'), {
    known: true,
    name: 'wendkeep_project_status',
    effect: 'read',
    capability: 'project:status',
    effect_version: 1,
  });
  assert.equal(
    resolveMcpToolEffect('mcp__wendkeep__wendkeep_task_claim').effect,
    'write',
  );
  assert.equal(resolveMcpToolEffect('mcp__other__wendkeep_project_status').known, false);
});

test('[req:MCP-9] native config generation covers generic, Claude, Cursor and Codex clients', () => {
  for (const client of ['generic', 'claude', 'cursor']) {
    const config = JSON.parse(renderMcpClientConfig(client, 'C:/vault'));
    assert.deepEqual(config.mcpServers['wendkeep-vault'].args, [
      '--no-install', 'wendkeep', 'mcp', 'serve', '--vault', 'C:/vault',
    ]);
  }
  const codex = renderMcpClientConfig('codex', 'C:/vault');
  assert.match(codex, /^\[mcp_servers\.wendkeep-vault\]/m);
  assert.match(codex, /"--no-install", "wendkeep", "mcp", "serve"/);
  assert.doesNotMatch(codex, /@latest|mcpvault/i);
});

test('[req:MCP-2] tampering, ambiguous effects and unknown tools fail closed', () => {
  const tampered = structuredClone(MCP_EFFECT_MANIFEST);
  tampered.tools[0].effect = 'read';
  tampered.tools[1].name = tampered.tools[0].name;
  assert.equal(verifyMcpEffectManifest(tampered).valid, false);
  assert.equal(resolveMcpToolEffect('wendkeep_missing').effect, 'unknown');
  assert.equal(resolveMcpToolEffect('wendkeep_project_status', { manifest: tampered }).effect, 'unknown');
});

test('[req:MCP-2] guard skips known reads but keeps writes and unknown MCP tools fail-closed', () => {
  assert.equal(scopeDecision({
    input: { tool_name: 'mcp__wendkeep__wendkeep_project_status', tool_input: {} },
    expectedScope: { conflict: true },
    actualScope: null,
    host: 'codex',
  }), null);

  for (const toolName of [
    'mcp__wendkeep__wendkeep_task_claim',
    'mcp__wendkeep__wendkeep_unknown',
  ]) {
    const decision = scopeDecision({ input: { tool_name: toolName, tool_input: {} }, host: 'codex' });
    assert.equal(decision.permissionDecision, 'deny');
    assert.match(decision.permissionDecisionReason, /WENDKEEP_SCOPE_MISSING/);
  }
});
