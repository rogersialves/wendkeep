import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { bindProjectVault } from '../packages/vault/src/project-vault.mjs';
import { recallEvidenceForMcp } from '../packages/mcp/src/evidence-recall.mjs';
import { MCP_EFFECT_MANIFEST } from '../packages/mcp/src/effects.mjs';
import { executeNativeMcpTool } from '../packages/mcp/src/executor.mjs';
import { createNativeMcpServer } from '../packages/mcp/src/server.mjs';
import {
  refreshEvidenceIndex,
  refreshEvidenceSearchIndex,
} from '../hooks/evidence-recall.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wk-mcp-evidence-recall-'));
  const project = join(root, 'project');
  const vault = join(root, 'vault');
  mkdirSync(project);
  mkdirSync(vault);
  const binding = bindProjectVault({ projectRoot: project, vaultPath: vault });
  mkdirSync(join(vault, '04-Decisões'), { recursive: true });
  return {
    root,
    project,
    vault,
    projectId: binding.projectId,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeDecision(vault, name, body, {
  authority = 'verified',
  validity = 'active',
  date = '2026-08-27',
} = {}) {
  writeFileSync(join(vault, '04-Decisões', `${name}.md`), [
    '---',
    `title: ${name}`,
    `authority: ${authority}`,
    `validity: ${validity}`,
    `date: ${date}`,
    '---',
    `# ${name}`,
    '',
    '## Evidência',
    '',
    body,
    '',
  ].join('\n'));
}

function build(vault) {
  const index = refreshEvidenceIndex(vault);
  refreshEvidenceSearchIndex(vault, index.chunks, {
    force: true,
    sqlite: 'off',
  });
  return index;
}

function request(id, method, params = {}) {
  return { jsonrpc: '2.0', id, method, params };
}

test('[req:RECALL-12] [req:MCP-10] evidence recall pages indexed candidates with opaque cursors and byte budgets', () => {
  const item = fixture();
  try {
    writeDecision(item.vault, 'ADR-motor-a', 'O contrato motor-foguete alfa foi validado.');
    writeDecision(item.vault, 'ADR-motor-b', 'O contrato motor-foguete beta foi validado.');
    writeDecision(item.vault, 'ADR-motor-c', 'O contrato motor-foguete gama foi validado.');
    build(item.vault);

    const first = recallEvidenceForMcp(item.vault, {
      query: 'motor-foguete contrato',
      backend: 'lexical',
      filters: { authority: 'verified', validity: 'active' },
      limit: 1,
      max_bytes: 4096,
      candidate_limit: 10,
      posting_budget: 100,
    });
    assert.equal(first.results.length, 1);
    assert.equal(first.has_more, true);
    assert.ok(first.next_cursor);
    assert.equal(first.results[0].content_omitted, true);
    assert.equal(Object.hasOwn(first.results[0], 'content'), false);
    assert.equal(Object.hasOwn(first.results[0], 'logical_path'), false);
    assert.match(first.results[0].logical_ref, /^04-Decisões\//);
    assert.equal(first.candidates.backend, 'lexical-sidecar');
    assert.equal(first.candidates.has_more, false);
    assert.equal(first.complete_candidate_set, true);
    assert.ok(first.returned_bytes <= first.max_bytes);

    const second = recallEvidenceForMcp(item.vault, {
      query: 'motor-foguete contrato',
      backend: 'lexical',
      filters: { authority: 'verified', validity: 'active' },
      cursor: first.next_cursor,
      limit: 1,
      max_bytes: 4096,
      candidate_limit: 10,
      posting_budget: 100,
    });
    assert.equal(second.results.length, 1);
    assert.notEqual(second.results[0].logical_ref, first.results[0].logical_ref);
    assert.equal(second.as_of, first.as_of);
    assert.equal(second.offset, 1);

    assert.throws(
      () => recallEvidenceForMcp(item.vault, {
        query: 'consulta diferente',
        cursor: first.next_cursor,
        backend: 'lexical',
      }),
      { code: 'MCP_EVIDENCE_CURSOR_INVALID' },
    );
    assert.throws(
      () => recallEvidenceForMcp(item.vault, {
        query: 'motor-foguete contrato',
        backend: 'lexical',
        max_bytes: 2,
      }),
      { code: 'MCP_EVIDENCE_BUDGET_TOO_SMALL' },
    );
    assert.throws(
      () => recallEvidenceForMcp(item.vault, {
        query: 'motor-foguete contrato',
        filters: [],
      }),
      { code: 'MCP_EVIDENCE_RECALL_INVALID' },
    );
  } finally {
    item.cleanup();
  }
});

test('[req:RECALL-12] [req:MCP-10] native executor preserves relative provenance without local paths', async () => {
  const item = fixture();
  try {
    writeDecision(item.vault, 'ADR-nebulosa', 'A âncora nebulosa-executor preserva a evidência.');
    build(item.vault);
    const tool = MCP_EFFECT_MANIFEST.tools.find((candidate) => (
      candidate.name === 'wendkeep_evidence_recall'
    ));
    assert.equal(tool.effect, 'read');
    assert.equal(tool.capability, 'evidence:recall');

    const result = await executeNativeMcpTool(tool, {
      project_root: item.project,
      query: 'nebulosa-executor',
      backend: 'lexical',
      limit: 5,
      max_bytes: 8192,
    });
    assert.equal(result.schema_version, 1);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].logical_ref, '04-Decisões/ADR-nebulosa.md');
    assert.equal(Object.hasOwn(result.results[0], 'logical_path'), false);
    assert.equal(result.candidates.backend, 'lexical-sidecar');
    assert.doesNotMatch(JSON.stringify(result), /wk-mcp-evidence-recall|[A-Z]:\\|\/tmp\//i);
  } finally {
    item.cleanup();
  }
});

test('[req:RECALL-12] [req:MCP-10] server advertises typed recall inputs and rejects a missing query pre-execution', async () => {
  let executions = 0;
  const server = createNativeMcpServer({
    defaultPageSize: 100,
    executeTool: async () => {
      executions += 1;
      return {
        results: [{ logical_ref: '04-Decisões/ADR.md', excerpt: 'ok' }],
        next_cursor: 'opaque-cursor',
        has_more: true,
      };
    },
  });
  const listed = await server.handle(request(1, 'tools/list'));
  const descriptor = listed.result.tools.find((tool) => (
    tool.name === 'wendkeep_evidence_recall'
  ));
  assert.ok(descriptor);
  assert.equal(descriptor.annotations.readOnlyHint, true);
  assert.ok(descriptor.inputSchema.required.includes('query'));
  assert.equal(descriptor.inputSchema.properties.backend.enum.includes('lexical'), true);
  assert.equal(descriptor.inputSchema.properties.max_bytes.maximum, 512 * 1024);
  assert.equal(descriptor.inputSchema.properties.candidate_limit.maximum, 4096);
  assert.equal(descriptor.inputSchema.properties.posting_budget.maximum, 1_048_576);
  assert.equal(descriptor.inputSchema.properties.filters.additionalProperties, false);

  const missing = await server.handle(request(2, 'tools/call', {
    name: 'wendkeep_evidence_recall',
    arguments: { project_root: 'C:/projects/a' },
  }));
  assert.equal(missing.result.isError, true);
  assert.equal(missing.result.structuredContent.error.code, 'MCP_ARGUMENT_REQUIRED');
  assert.equal(executions, 0);

  const called = await server.handle(request(3, 'tools/call', {
    name: 'wendkeep_evidence_recall',
    arguments: {
      project_root: 'C:/projects/a',
      query: 'contrato',
      limit: 1,
      max_bytes: 4096,
      backend: 'auto',
      filters: { authority: 'verified' },
    },
  }));
  assert.equal(called.result.isError, false);
  assert.equal(executions, 1);
  assert.equal(called.result.structuredContent.next_cursor, 'opaque-cursor');
  assert.equal(Object.hasOwn(called.result.structuredContent, 'items'), false);
});
