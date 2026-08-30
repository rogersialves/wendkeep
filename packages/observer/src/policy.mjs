import { createHash } from 'node:crypto';
import { redactObserverValue } from './redaction.mjs';

const CAPTURE = {
  document: new Set(['none', 'metadata', 'selected', 'full']),
  transcript: new Set(['none', 'metadata', 'messages', 'full']),
  prompt: new Set(['none', 'redacted', 'full']),
  response: new Set(['none', 'redacted', 'full']),
  usage: new Set(['none', 'aggregate', 'calls']),
};

const DEFAULTS = Object.freeze({
  document_capture: 'metadata',
  transcript_capture: 'metadata',
  prompt_capture: 'redacted',
  response_capture: 'redacted',
  usage_capture: 'aggregate',
  require_loopback_auth: false,
  encryption_required: false,
});

const SESSION_FIELDS = [
  'session_id', 'sessionId', 'provider', 'status', 'change_slug', 'changeSlug',
];
const SESSION_TIMESTAMPS = ['started_at', 'startedAt', 'ended_at', 'endedAt'];
const AGENT_FIELDS = [
  ...SESSION_FIELDS, 'agent_id', 'agentId', 'parent_agent_id', 'parentAgentId',
  'role', 'agent_type', 'agentType', 'workflow', 'model', 'effort',
];

function structuralFields(strings, integers = [], timestamps = []) {
  return Object.freeze({
    strings: Object.freeze(strings),
    integers: Object.freeze(integers),
    timestamps: Object.freeze(timestamps),
  });
}

export const OBSERVER_EVENT_STRUCTURAL_CONTRACT = Object.freeze({
  envelope: structuralFields(['event_id', 'kind', 'project_id'], ['schema_version'], ['occurred_at']),
  payload: Object.freeze({
    'document.upsert': structuralFields([
      'document_id', 'documentId', 'logical_path', 'logicalPath', 'entity_type', 'entityType',
      'source_session_id', 'sourceSessionId', 'source_turn_id', 'sourceTurnId',
      'operation', 'op',
    ], ['revision'], ['captured_at', 'capturedAt']),
    'document.delete': structuralFields([
      'logical_path', 'logicalPath', 'entity_type', 'entityType',
      'source_session_id', 'sourceSessionId', 'source_turn_id', 'sourceTurnId',
      'operation', 'op',
    ], ['revision']),
    'session.upsert': structuralFields([...SESSION_FIELDS], [], [...SESSION_TIMESTAMPS]),
    'agent.upsert': structuralFields([...AGENT_FIELDS], [], [...SESSION_TIMESTAMPS]),
    'usage.rollup': structuralFields([
      ...AGENT_FIELDS, 'rollup_key', 'rollupKey', 'model_provider', 'modelProvider',
      'cost_status', 'costStatus', 'pricing_source', 'pricingSource', 'pricing_version', 'pricingVersion',
    ], ['revision'], [...SESSION_TIMESTAMPS]),
    llm_call: structuralFields([
      ...AGENT_FIELDS, 'call_id', 'callId', 'model_provider', 'modelProvider',
      'cost_status', 'costStatus', 'transcript_id', 'transcriptId',
    ], ['sequence'], [...SESSION_TIMESTAMPS, 'occurred_at']),
    'transcript.upsert': structuralFields([
      ...AGENT_FIELDS, 'transcript_id', 'transcriptId', 'coverage', 'source',
    ], [], [...SESSION_TIMESTAMPS]),
  }),
});

function policyError(message) {
  return Object.assign(new Error(message), { code: 'observer_policy_invalid' });
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw policyError(`${label} inválido.`);
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw policyError(`${label} contém campo desconhecido: ${unknown}`);
}

function captureFor(policy, dataClass) {
  return policy[`${dataClass}_capture`];
}

function globMatches(pattern, value) {
  if (!pattern) return true;
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '\u0000').replaceAll('*', '[^/]*').replaceAll('\u0000', '.*');
  return new RegExp(`^${escaped}$`, 'u').test(String(value || '').replaceAll('\\', '/'));
}

function ruleMatches(rule, context) {
  return (!rule.project_id || rule.project_id === context.projectId)
    && (!rule.data_class || rule.data_class === context.dataClass)
    && (!rule.entity_type || rule.entity_type === context.entityType)
    && globMatches(rule.path, context.path);
}

export function createObserverPolicy(input = {}) {
  assertObject(input, 'policy');
  assertKnownKeys(input, new Set([
    'document_capture', 'transcript_capture', 'prompt_capture', 'response_capture', 'usage_capture',
    'require_loopback_auth', 'encryption_required', 'rules', 'redaction', 'retention',
  ]), 'policy');
  for (const field of ['require_loopback_auth', 'encryption_required']) {
    if (Object.hasOwn(input, field) && typeof input[field] !== 'boolean') throw policyError(`${field} deve ser boolean.`);
  }
  if (Object.hasOwn(input, 'rules') && !Array.isArray(input.rules)) throw policyError('rules deve ser array.');
  if (Object.hasOwn(input, 'redaction')) {
    assertObject(input.redaction, 'redaction');
    assertKnownKeys(input.redaction, new Set(['rules']), 'redaction');
    if (Object.hasOwn(input.redaction, 'rules') && !Array.isArray(input.redaction.rules)) throw policyError('redaction.rules deve ser array.');
  }
  if (Object.hasOwn(input, 'retention')) {
    assertObject(input.retention, 'retention');
    assertKnownKeys(input.retention, new Set(['document', 'transcript', 'prompt', 'response', 'usage', 'documents', 'calls', 'transcripts']), 'retention');
    if (Object.values(input.retention).some((value) => !Number.isInteger(value) || value < 0)) throw policyError('retention deve usar inteiros não negativos.');
  }
  const policy = {
    ...DEFAULTS,
    ...input,
    rules: Array.isArray(input.rules) ? input.rules.map((rule) => ({ ...rule })) : [],
    redaction: input.redaction && typeof input.redaction === 'object' ? structuredClone(input.redaction) : {},
    retention: input.retention && typeof input.retention === 'object' ? structuredClone(input.retention) : {},
  };
  for (const rule of policy.rules) {
    assertObject(rule, 'rule');
    assertKnownKeys(rule, new Set(['project_id', 'data_class', 'path', 'entity_type', 'capture']), 'rule');
  }
  for (const rule of policy.redaction.rules || []) {
    assertObject(rule, 'redaction rule');
    assertKnownKeys(rule, new Set(['pattern', 'replacement']), 'redaction rule');
    if (String(rule.replacement || '').length > 160) throw policyError('replacement de redaction excede o limite.');
  }
  for (const rule of policy.redaction.rules || []) {
    const pattern = String(rule?.pattern || '');
    if (!pattern || pattern.length > 512 || /\\[1-9]/.test(pattern)
      || /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d*,?\d*\})/.test(pattern)) {
      throw policyError('regra de redaction insegura ou inválida.');
    }
    try { new RegExp(pattern, 'giu'); }
    catch { throw policyError('regra de redaction insegura ou inválida.'); }
  }
  for (const dataClass of Object.keys(CAPTURE)) {
    const capture = captureFor(policy, dataClass);
    if (!CAPTURE[dataClass].has(capture)) throw policyError(`capture inválido para ${dataClass}: ${capture}`);
  }
  for (const rule of policy.rules) {
    if (!CAPTURE[rule.data_class]?.has(rule.capture)) {
      throw policyError(`regra de capture inválida para ${rule.data_class || 'classe ausente'}`);
    }
  }
  return policy;
}

export function saveObserverPolicy(db, projectId, policyInput, { updatedAt = new Date().toISOString() } = {}) {
  const policy = createObserverPolicy(policyInput);
  db.prepare(`INSERT INTO observer_retention_policies(project_id, policy_json, updated_at)
    VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET policy_json = excluded.policy_json, updated_at = excluded.updated_at`)
    .run(projectId, JSON.stringify(policy), new Date(updatedAt).toISOString());
  return policy;
}

export function readObserverPolicy(db, projectId) {
  const row = db.prepare('SELECT policy_json FROM observer_retention_policies WHERE project_id = ?').get(projectId);
  return row ? createObserverPolicy(JSON.parse(row.policy_json)) : createObserverPolicy();
}

export function evaluateObserverPolicy(policyInput, context = {}) {
  const policy = policyInput?.rules ? policyInput : createObserverPolicy(policyInput);
  const dataClass = String(context.dataClass || 'document');
  if (!CAPTURE[dataClass]) throw policyError(`classe de dado desconhecida: ${dataClass}`);
  let capture = captureFor(policy, dataClass);
  for (const rule of policy.rules) {
    if (ruleMatches(rule, { ...context, dataClass })) capture = rule.capture;
  }
  return {
    data_class: dataClass,
    capture,
    encryption_required: Boolean(policy.encryption_required),
    retention_days: Number(policy.retention?.[dataClass] ?? 0) || 0,
  };
}

function metadataOnly(payload, capture) {
  return {
    ...payload,
    content: '',
    coverage: payload.coverage ? 'summary_only' : payload.coverage,
    capture,
  };
}

function protectText(value, capture, redaction) {
  if (capture === 'none') return '';
  if (capture === 'redacted') return redactObserverValue(value, redaction);
  return String(value ?? '');
}

function preserveStructuralFields(original, protectedValue, contract) {
  for (const key of contract?.strings || []) {
    if (!Object.hasOwn(original, key)) continue;
    const value = original[key];
    if (value !== null && typeof value !== 'string') throw policyError(`${key} estrutural deve ser string ou null.`);
    protectedValue[key] = value;
  }
  for (const key of contract?.integers || []) {
    if (!Object.hasOwn(original, key)) continue;
    const value = original[key];
    if (!Number.isInteger(value) || value < 0) throw policyError(`${key} estrutural deve ser inteiro não negativo.`);
    protectedValue[key] = value;
  }
  for (const key of contract?.timestamps || []) {
    if (!Object.hasOwn(original, key)) continue;
    const value = original[key];
    if (value !== null && (typeof value !== 'string' || Number.isNaN(Date.parse(value)))) {
      throw policyError(`${key} estrutural deve ser date-time ou null.`);
    }
    protectedValue[key] = value;
  }
  return protectedValue;
}

function protectedContentHash(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function transcriptMessagesOnly(value) {
  const source = String(value || '');
  const sanitizeMessage = (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const role = String(item.role || '');
    if (!['user', 'assistant', 'system'].includes(role) || typeof item.content !== 'string') return null;
    return { role, content: item.content };
  };
  const sanitizeMessages = (items) => items.map(sanitizeMessage).filter(Boolean);
  try {
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) return JSON.stringify(sanitizeMessages(parsed));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.messages)) {
      return JSON.stringify({ messages: sanitizeMessages(parsed.messages) });
    }
    return '';
  } catch {
    const lines = source.split(/\r?\n/u).filter(Boolean);
    const items = lines.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    });
    if (!lines.length || items.some((item) => item === null)) return '';
    return sanitizeMessages(items).map(JSON.stringify).join('\n');
  }
}

export function protectObserverEvent(event, { policy: policyInput = {} } = {}) {
  const policy = policyInput?.rules ? policyInput : createObserverPolicy(policyInput);
  const payload = structuredClone(event?.payload || {});
  const context = {
    projectId: String(event?.project_id || ''),
    path: String(payload.logical_path || ''),
    entityType: String(payload.entity_type || ''),
  };
  let protectedPayload = preserveStructuralFields(
    payload,
    redactObserverValue(payload, policy.redaction),
    OBSERVER_EVENT_STRUCTURAL_CONTRACT.payload[event?.kind],
  );
  if (event?.kind === 'document.delete') {
    delete protectedPayload.content;
    delete protectedPayload.content_hash;
    delete protectedPayload.contentHash;
  } else if (event?.kind?.startsWith('document.')) {
    const decision = evaluateObserverPolicy(policy, { ...context, dataClass: 'document' });
    if (decision.capture === 'none') return null;
    if (decision.capture === 'metadata' || decision.capture === 'selected') protectedPayload = metadataOnly(protectedPayload, decision.capture);
    else protectedPayload.capture = decision.capture;
  } else if (event?.kind === 'transcript.upsert') {
    const decision = evaluateObserverPolicy(policy, { ...context, dataClass: 'transcript' });
    if (decision.capture === 'none') return null;
    if (decision.capture === 'metadata') protectedPayload = metadataOnly(protectedPayload, decision.capture);
    else if (decision.capture === 'messages') {
      protectedPayload.content = transcriptMessagesOnly(protectedPayload.content);
      protectedPayload.capture = decision.capture;
    }
    else protectedPayload.capture = decision.capture;
  } else if (event?.kind === 'usage.rollup') {
    const usageDecision = evaluateObserverPolicy(policy, { ...context, dataClass: 'usage' });
    if (usageDecision.capture === 'none') return null;
    protectedPayload.capture = usageDecision.capture;
  } else if (event?.kind === 'llm_call') {
    const usageDecision = evaluateObserverPolicy(policy, { ...context, dataClass: 'usage' });
    if (usageDecision.capture !== 'calls') return null;
    const promptDecision = evaluateObserverPolicy(policy, { ...context, dataClass: 'prompt' });
    const responseDecision = evaluateObserverPolicy(policy, { ...context, dataClass: 'response' });
    protectedPayload.prompt_text = protectText(payload.prompt_text ?? payload.prompt, promptDecision.capture, policy.redaction);
    protectedPayload.response_text = protectText(payload.response_text ?? payload.response, responseDecision.capture, policy.redaction);
    delete protectedPayload.prompt;
    delete protectedPayload.response;
    protectedPayload.capture = usageDecision.capture;
  }
  if (event?.kind === 'document.upsert' || event?.kind === 'transcript.upsert') {
    protectedPayload.content_hash = protectedContentHash(protectedPayload.content);
    delete protectedPayload.contentHash;
  }
  return { ...event, payload: protectedPayload };
}
