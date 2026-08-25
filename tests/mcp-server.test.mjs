import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createNativeMcpServer } from '../packages/mcp/src/server.mjs';

function request(id, method, params = {}) {
  return { jsonrpc: '2.0', id, method, params };
}

test('[req:MCP-3] handshake, paginated tools/list and semantic tools/call use valid JSON-RPC', async () => {
  const calls = [];
  const server = createNativeMcpServer({
    executeTool: async (tool, args) => {
      calls.push({ tool, args });
      return { project_id: 'project-a', profile: 'OFF' };
    },
    defaultPageSize: 4,
  });

  const initialized = await server.handle(request(1, 'initialize', {
    protocolVersion: '2025-06-18', clientInfo: { name: 'fixture', version: '1' },
  }));
  assert.equal(initialized.result.serverInfo.name, 'wendkeep-native');
  assert.equal(initialized.result.capabilities.tools.listChanged, false);

  const first = await server.handle(request(2, 'tools/list'));
  assert.equal(first.result.tools.length, 4);
  assert.ok(first.result.nextCursor);
  const second = await server.handle(request(3, 'tools/list', { cursor: first.result.nextCursor }));
  assert.notEqual(second.result.tools[0].name, first.result.tools[0].name);

  const called = await server.handle(request(4, 'tools/call', {
    name: 'wendkeep_project_status', arguments: { project_root: 'C:/projects/a' },
  }));
  assert.equal(called.result.isError, false);
  assert.deepEqual(called.result.structuredContent, {
    project_id: 'project-a', profile: 'OFF', schema_version: 1,
  });
  assert.deepEqual(JSON.parse(called.result.content[0].text), called.result.structuredContent);
  assert.equal(calls[0].tool.name, 'wendkeep_project_status');
});

test('[req:MCP-4] unknown tools and unauthorized writes fail typed without partial execution', async () => {
  let executions = 0;
  const server = createNativeMcpServer({ executeTool: async () => { executions += 1; return {}; } });

  const unknown = await server.handle(request(1, 'tools/call', {
    name: 'wendkeep_unknown', arguments: { project_root: 'C:/projects/a' },
  }));
  assert.equal(unknown.result.isError, true);
  assert.equal(unknown.result.structuredContent.error.code, 'MCP_TOOL_UNKNOWN');

  const denied = await server.handle(request(2, 'tools/call', {
    name: 'wendkeep_task_claim',
    arguments: {
      project_root: 'C:/projects/a', session_id: 'session-a', actor: 'codex', reason: 'claim task',
      capabilities: [], task: '1',
    },
  }));
  assert.equal(denied.result.isError, true);
  assert.equal(denied.result.structuredContent.error.code, 'MCP_CAPABILITY_REQUIRED');
  assert.equal(executions, 0);

  const allowed = await server.handle(request(3, 'tools/call', {
    name: 'wendkeep_task_claim',
    arguments: {
      project_root: 'C:/projects/a', session_id: 'session-a', actor: 'codex', reason: 'claim task',
      capabilities: ['task:claim'],
      task: '1',
      active_context_id: 'context-a',
      lease: { id: 'lease-a', expires_at: '2099-01-01T00:00:00.000Z' },
    },
  }));
  assert.equal(allowed.result.isError, false);
  assert.equal(executions, 1);
});

test('[req:MCP-4] expired leases and oversized payloads fail before execution', async () => {
  let executions = 0;
  const server = createNativeMcpServer({
    maxRequestBytes: 500,
    executeTool: async () => { executions += 1; return {}; },
  });
  const expired = await server.handle(request(1, 'tools/call', {
    name: 'wendkeep_task_claim',
    arguments: {
      project_root: 'C:/projects/a', session_id: 'session-a', actor: 'codex', reason: 'claim',
      capabilities: ['task:claim'], active_context_id: 'context-a', task: '1',
      lease: { id: 'lease-a', expires_at: '2020-01-01T00:00:00.000Z' },
    },
  }));
  assert.equal(expired.result.structuredContent.error.code, 'MCP_LEASE_EXPIRED');

  const oversized = await server.handle(request(2, 'tools/call', {
    name: 'wendkeep_project_status',
    arguments: { project_root: 'C:/projects/a', payload: { data: 'x'.repeat(1_000) } },
  }));
  assert.equal(oversized.result.structuredContent.error.code, 'MCP_REQUEST_TOO_LARGE');
  assert.equal(executions, 0);
});

test('[req:MCP-8] audit metadata records outcomes without copying tool payloads', async () => {
  const events = [];
  const server = createNativeMcpServer({
    auditToolCall: async (event) => events.push(event),
    executeTool: async () => ({ ok: true }),
  });
  await server.handle(request(1, 'tools/call', {
    name: 'wendkeep_project_status',
    arguments: { project_root: 'C:/projects/a', payload: { token: 'secret-payload-value' } },
  }));
  assert.equal(events.length, 1);
  assert.equal(events[0].tool, 'wendkeep_project_status');
  assert.equal(events[0].outcome, 'success');
  assert.doesNotMatch(JSON.stringify(events[0]), /secret-payload-value/i);
  assert.doesNotMatch(JSON.stringify(events[0]), /projects\/a/i);
  assert.deepEqual(Object.keys(events[0]).sort(), [
    'capability', 'duration_ms', 'effect', 'error_code', 'outcome', 'tool',
  ]);
});

test('[req:MCP-5] Node 18 keeps Core available and declares Observer SQL unavailable', async () => {
  const server = createNativeMcpServer({
    nodeVersion: '18.20.8',
    executeTool: async () => ({ ok: true }),
  });
  const listed = await server.handle(request(1, 'tools/list'));
  const observer = listed.result.tools.find((tool) => tool.name === 'wendkeep_observer_query');
  assert.equal(observer._meta.availability.available, false);
  assert.equal(observer._meta.availability.code, 'MCP_RUNTIME_UNSUPPORTED');

  const core = await server.handle(request(2, 'tools/call', {
    name: 'wendkeep_project_status', arguments: { project_root: 'C:/projects/a' },
  }));
  assert.equal(core.result.isError, false);
  const unavailable = await server.handle(request(3, 'tools/call', {
    name: 'wendkeep_observer_query', arguments: { project_root: 'C:/projects/a', query: 'changes' },
  }));
  assert.equal(unavailable.result.structuredContent.error.code, 'MCP_RUNTIME_UNSUPPORTED');
});

test('[req:MCP-6] large arrays paginate structurally and timeout stays a typed error', async () => {
  let timedSignal;
  const server = createNativeMcpServer({
    defaultPageSize: 10,
    timeoutMs: 20,
    executeTool: async (tool, _args, { signal }) => {
      if (tool.name === 'wendkeep_memory_recall') return Array.from({ length: 25 }, (_, id) => ({ id }));
      timedSignal = signal;
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { late: true };
    },
  });
  const page = await server.handle(request(1, 'tools/call', {
    name: 'wendkeep_memory_recall', arguments: { project_root: 'C:/projects/a', limit: 10 },
  }));
  assert.equal(page.result.structuredContent.items.length, 10);
  assert.ok(page.result.structuredContent.next_cursor);
  assert.doesNotThrow(() => JSON.parse(page.result.content[0].text));

  const timedOut = await server.handle(request(2, 'tools/call', {
    name: 'wendkeep_project_status', arguments: { project_root: 'C:/projects/a' },
  }));
  assert.equal(timedOut.result.structuredContent.error.code, 'MCP_TOOL_TIMEOUT');
  assert.equal(timedSignal.aborted, true);
});

test('[req:MCP-6] response byte budgets shrink array pages without invalid JSON', async () => {
  const server = createNativeMcpServer({
    maxResponseBytes: 600,
    defaultPageSize: 10,
    executeTool: async () => Array.from({ length: 10 }, (_, id) => ({ id, text: 'x'.repeat(150) })),
  });
  const page = await server.handle(request(1, 'tools/call', {
    name: 'wendkeep_memory_recall', arguments: { project_root: 'C:/projects/a', limit: 10 },
  }));
  assert.equal(page.result.isError, false);
  assert.ok(page.result.structuredContent.items.length < 10);
  assert.ok(page.result.structuredContent.next_cursor);
  assert.ok(Buffer.byteLength(page.result.content[0].text, 'utf8') <= 600);
  assert.doesNotThrow(() => JSON.parse(page.result.content[0].text));
});

test('[req:MCP-6] cancellation aborts an in-flight call with a typed result', async () => {
  const server = createNativeMcpServer({
    timeoutMs: 1_000,
    executeTool: async (_tool, _args, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), {
        code: 'MCP_TOOL_CANCELLED',
      })), { once: true });
      setTimeout(() => resolve({ late: true }), 500);
    }),
  });
  const pending = server.handle(request(41, 'tools/call', {
    name: 'wendkeep_project_status', arguments: { project_root: 'C:/projects/a' },
  }));
  await server.handle(request(42, 'notifications/cancelled', { requestId: 41 }));
  const cancelled = await pending;
  assert.equal(cancelled.result.structuredContent.error.code, 'MCP_TOOL_CANCELLED');
});
