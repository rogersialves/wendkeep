import { MCP_EFFECT_MANIFEST, resolveMcpToolEffect } from './effects.mjs';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_EVIDENCE_BYTES = 512 * 1024;
const MAX_EVIDENCE_CANDIDATES = 4096;
const MAX_EVIDENCE_POSTINGS = 1_048_576;

function boundedInteger(value, fallback, maximum = MAX_PAGE_SIZE) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function cursorFor(offset) {
  return Buffer.from(JSON.stringify({ v: 1, offset }), 'utf8').toString('base64url');
}

function cursorOffset(value) {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    return parsed?.v === 1 && Number.isInteger(parsed.offset) && parsed.offset >= 0
      ? parsed.offset
      : 0;
  } catch { return 0; }
}

function supportsObserverSql(nodeVersion) {
  const [major = 0, minor = 0] = String(nodeVersion || '').split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

function availability(tool, nodeVersion) {
  if (tool.name !== 'wendkeep_observer_query' || supportsObserverSql(nodeVersion)) {
    return { available: true };
  }
  return {
    available: false,
    code: 'MCP_RUNTIME_UNSUPPORTED',
    requires: 'node>=22.13.0',
  };
}

const TOOL_REQUIRED_ARGUMENTS = Object.freeze({
  wendkeep_context_status: ['session_id'],
  wendkeep_evidence_recall: ['query'],
  wendkeep_change_show: ['change'],
  wendkeep_change_status: ['change'],
  wendkeep_task_show: ['session_id', 'task'],
  wendkeep_task_evaluate: ['session_id', 'task'],
  wendkeep_handoff_current: ['session_id'],
  wendkeep_evidence_latest: ['change'],
  wendkeep_memory_assert: ['payload'],
  wendkeep_context_select: ['payload'],
  wendkeep_task_claim: ['task'],
  wendkeep_task_complete: ['task'],
  wendkeep_handoff_publish: ['payload'],
});

const stringOrStringList = {
  oneOf: [
    { type: 'string' },
    { type: 'array', items: { type: 'string' }, uniqueItems: true },
  ],
};

function inputSchema(tool) {
  const required = ['project_root'];
  required.push(...(TOOL_REQUIRED_ARGUMENTS[tool.name] || []));
  if (tool.effect === 'write') {
    required.push('session_id', 'active_context_id', 'actor', 'reason', 'capabilities', 'lease');
  }
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties: {
      project_root: { type: 'string', minLength: 1 },
      worktree_root: { type: 'string', minLength: 1 },
      session_id: { type: 'string', minLength: 1 },
      active_context_id: { type: 'string', minLength: 1 },
      actor: { type: 'string', minLength: 1 },
      reason: { type: 'string', minLength: 1, maxLength: 500 },
      capabilities: { type: 'array', items: { type: 'string' }, uniqueItems: true },
      lease: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'expires_at'],
        properties: {
          id: { type: 'string', minLength: 1 },
          expires_at: { type: 'string', format: 'date-time' },
        },
      },
      change: { type: 'string' },
      task: { type: 'string' },
      query: { type: 'string' },
      cursor: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE },
      max_bytes: { type: 'integer', minimum: 2, maximum: MAX_EVIDENCE_BYTES },
      candidate_limit: { type: 'integer', minimum: 1, maximum: MAX_EVIDENCE_CANDIDATES },
      posting_budget: { type: 'integer', minimum: 1, maximum: MAX_EVIDENCE_POSTINGS },
      backend: { type: 'string', enum: ['auto', 'sqlite', 'lexical'] },
      filters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          authority: stringOrStringList,
          validity: stringOrStringList,
          entity_type: stringOrStringList,
          project_id: stringOrStringList,
          change_slug: stringOrStringList,
          session_id: stringOrStringList,
          work_session_id: stringOrStringList,
          logical_path: stringOrStringList,
          logical_path_prefix: stringOrStringList,
        },
      },
      payload: { type: 'object' },
    },
  };
}

function toolDescriptor(tool, nodeVersion) {
  return {
    name: tool.name,
    description: `${tool.capability} (${tool.effect}, effect v${tool.effect_version})`,
    inputSchema: inputSchema(tool),
    outputSchema: {
      type: 'object',
      required: ['schema_version'],
      properties: { schema_version: { const: 1 } },
    },
    annotations: {
      readOnlyHint: tool.effect === 'read',
      destructiveHint: tool.effect === 'destructive',
      idempotentHint: tool.effect === 'read',
      openWorldHint: false,
    },
    _meta: {
      'wendkeep/effect': {
        catalog_version: MCP_EFFECT_MANIFEST.catalog_version,
        effect: tool.effect,
        effect_version: tool.effect_version,
        capability: tool.capability,
        input_schema: tool.input_schema,
        output_schema: tool.output_schema,
        manifest_integrity: MCP_EFFECT_MANIFEST.integrity,
      },
      availability: availability(tool, nodeVersion),
    },
  };
}

function sanitizeMessage(value) {
  return String(value || 'MCP tool failed')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g, '[REDACTED_SECRET]')
    .replace(/\b[A-Za-z]:\\[^\s)'"\r\n]+/g, '[LOCAL_PATH]')
    .replace(/\/[Uu]sers\/[^/\s]+\/[^\s)'"\r\n]+/g, '[LOCAL_PATH]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function toolError(code, message, { retryable = false } = {}) {
  const structuredContent = {
    schema_version: 1,
    error: { code, message: sanitizeMessage(message), retryable },
  };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function toolSuccess(value, {
  cursor = '', limit = DEFAULT_PAGE_SIZE, maxResponseBytes = 1_048_576,
} = {}) {
  let structuredContent = value;
  if (Array.isArray(value)) {
    const offset = cursorOffset(cursor);
    const pageSize = boundedInteger(limit, DEFAULT_PAGE_SIZE);
    const items = value.slice(offset, offset + pageSize);
    do {
      structuredContent = {
        schema_version: 1,
        items,
        ...(offset + items.length < value.length ? { next_cursor: cursorFor(offset + items.length) } : {}),
      };
      if (Buffer.byteLength(JSON.stringify(structuredContent), 'utf8') <= maxResponseBytes) break;
      items.pop();
    } while (items.length);
    if (!items.length && offset < value.length) {
      return toolError('MCP_RESPONSE_TOO_LARGE', 'one result item exceeds the configured byte budget');
    }
  } else {
    structuredContent = value && typeof value === 'object'
      ? { ...value, schema_version: 1 }
      : { schema_version: 1, value };
    if (Buffer.byteLength(JSON.stringify(structuredContent), 'utf8') > maxResponseBytes) {
      return toolError('MCP_RESPONSE_TOO_LARGE', 'tool result exceeds the configured byte budget');
    }
  }
  return {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function validateArguments(tool, args, now = Date.now()) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'MCP_ARGUMENTS_INVALID';
  if (!String(args.project_root || '').trim()) return 'MCP_PROJECT_REQUIRED';
  for (const field of TOOL_REQUIRED_ARGUMENTS[tool.name] || []) {
    if (!String(args[field] || '').trim()) return 'MCP_ARGUMENT_REQUIRED';
  }
  if (tool.effect !== 'write') return '';
  if (!Array.isArray(args.capabilities) || !args.capabilities.includes(tool.capability)) {
    return 'MCP_CAPABILITY_REQUIRED';
  }
  if (!String(args.session_id || '').trim()
    || !String(args.active_context_id || '').trim()
    || !String(args.actor || '').trim()
    || !String(args.reason || '').trim()
    || !String(args.lease?.id || '').trim()
    || !String(args.lease?.expires_at || '').trim()) return 'MCP_WRITE_CONTEXT_REQUIRED';
  const expiresAt = Date.parse(args.lease.expires_at);
  if (!Number.isFinite(expiresAt)) return 'MCP_LEASE_INVALID';
  if (expiresAt <= now) return 'MCP_LEASE_EXPIRED';
  return '';
}

function withControl(operation, timeoutMs, controller) {
  let timer;
  let onAbort;
  const { signal } = controller;
  timer = setTimeout(() => controller.abort(Object.assign(new Error('tool call timed out'), {
    code: 'MCP_TOOL_TIMEOUT',
  })), timeoutMs);
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      onAbort = () => {
        const reason = signal.reason;
        reject(typeof reason?.code === 'string' && reason.code.startsWith('MCP_')
          ? reason
          : Object.assign(new Error('tool call cancelled'), {
          code: 'MCP_TOOL_CANCELLED',
          }));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }),
  ]).finally(() => {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  });
}

export function createNativeMcpServer({
  executeTool = async () => ({}),
  nodeVersion = process.versions.node,
  defaultPageSize = DEFAULT_PAGE_SIZE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  serverVersion = '1',
  manifest = MCP_EFFECT_MANIFEST,
  maxRequestBytes = 1_048_576,
  maxResponseBytes = 1_048_576,
  now = () => Date.now(),
  auditToolCall = async () => {},
} = {}) {
  const pending = new Map();

  async function callTool(params = {}, requestId = null) {
    const startedAt = performance.now();
    const effect = resolveMcpToolEffect(params.name, { manifest });
    const finish = async (result, tool = null) => {
      const errorCode = result?.structuredContent?.error?.code || '';
      try {
        await auditToolCall({
          tool: tool?.name || String(params.name || '').slice(0, 120),
          effect: tool?.effect || effect.effect,
          capability: tool?.capability || effect.capability,
          outcome: result?.isError ? 'error' : 'success',
          error_code: errorCode,
          duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
        }, { projectRoot: String(params.arguments?.project_root || '') });
      } catch { /* audit failures must not corrupt protocol responses */ }
      return result;
    };
    if (!effect.known) {
      return finish(toolError('MCP_TOOL_UNKNOWN', 'tool is absent from the verified effect catalog'));
    }
    const tool = manifest.tools.find((candidate) => candidate.name === effect.name);
    const available = availability(tool, nodeVersion);
    if (!available.available) {
      return finish(toolError(available.code, `${tool.name} requires ${available.requires}`), tool);
    }
    const args = params.arguments || {};
    if (Buffer.byteLength(JSON.stringify({ name: params.name, arguments: args }), 'utf8') > maxRequestBytes) {
      return finish(toolError('MCP_REQUEST_TOO_LARGE', 'tool request exceeds the configured byte budget'), tool);
    }
    const validationCode = validateArguments(tool, args, now());
    if (validationCode) return finish(toolError(validationCode, `invalid arguments for ${tool.name}`), tool);
    const controller = new AbortController();
    if (requestId !== null && requestId !== undefined) pending.set(requestId, controller);
    try {
      const value = await withControl(
        Promise.resolve(executeTool(tool, args, { signal: controller.signal })),
        boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, 120_000),
        controller,
      );
      return finish(toolSuccess(value, {
        cursor: args.cursor,
        limit: boundedInteger(args.limit, defaultPageSize),
        maxResponseBytes,
      }), tool);
    } catch (error) {
      return finish(toolError(error?.code || 'MCP_TOOL_FAILED', error?.message || error, {
        retryable: error?.code === 'MCP_TOOL_TIMEOUT',
      }), tool);
    } finally {
      if (requestId !== null && requestId !== undefined) pending.delete(requestId);
    }
  }

  return {
    async handle(message = {}) {
      const id = message.id;
      if (message.jsonrpc !== '2.0') {
        return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } };
      }
      if (message.method === 'initialize') {
        return {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: message.params?.protocolVersion || '2025-06-18',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'wendkeep-native', version: serverVersion },
          },
        };
      }
      if (message.method === 'notifications/initialized') {
        return null;
      }
      if (message.method === 'notifications/cancelled') {
        pending.get(message.params?.requestId)?.abort();
        return null;
      }
      if (message.method === 'tools/list') {
        const offset = cursorOffset(message.params?.cursor);
        const pageSize = boundedInteger(message.params?.limit, defaultPageSize);
        const descriptors = manifest.tools.map((tool) => toolDescriptor(tool, nodeVersion));
        const tools = descriptors.slice(offset, offset + pageSize);
        return {
          jsonrpc: '2.0', id,
          result: {
            tools,
            ...(offset + tools.length < descriptors.length ? { nextCursor: cursorFor(offset + tools.length) } : {}),
          },
        };
      }
      if (message.method === 'tools/call') {
        return { jsonrpc: '2.0', id, result: await callTool(message.params, id) };
      }
      return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: 'Method not found' } };
    },
  };
}

export { supportsObserverSql };