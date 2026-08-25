import { createHash } from 'node:crypto';

const EFFECTS = new Set(['read', 'write', 'destructive']);

const TOOLS = [
  ['wendkeep_project_status', 'read', 'project:status'],
  ['wendkeep_context_status', 'read', 'context:status'],
  ['wendkeep_memory_recall', 'read', 'memory:recall'],
  ['wendkeep_memory_conflicts', 'read', 'memory:conflicts'],
  ['wendkeep_change_list', 'read', 'change:list'],
  ['wendkeep_change_show', 'read', 'change:show'],
  ['wendkeep_change_status', 'read', 'change:status'],
  ['wendkeep_spec_effective', 'read', 'spec:effective'],
  ['wendkeep_task_show', 'read', 'task:show'],
  ['wendkeep_task_evaluate', 'read', 'task:evaluate'],
  ['wendkeep_handoff_current', 'read', 'handoff:current'],
  ['wendkeep_evidence_latest', 'read', 'evidence:latest'],
  ['wendkeep_observer_query', 'read', 'observer:query'],
  ['wendkeep_memory_assert', 'write', 'memory:assert'],
  ['wendkeep_checkpoint_create', 'write', 'checkpoint:create'],
  ['wendkeep_context_select', 'write', 'context:select'],
  ['wendkeep_task_claim', 'write', 'task:claim'],
  ['wendkeep_task_complete', 'write', 'task:complete'],
  ['wendkeep_handoff_publish', 'write', 'handoff:publish'],
].map(([name, effect, capability]) => ({
  name,
  effect,
  capability,
  effect_version: 1,
  input_schema: 'wendkeep://schema/mcp-tool-input-v1',
  output_schema: 'wendkeep://schema/mcp-tool-result-v1',
}));

function manifestPayload(manifest) {
  return {
    schema_version: manifest?.schema_version,
    catalog_version: manifest?.catalog_version,
    server_aliases: manifest?.server_aliases,
    tools: manifest?.tools,
  };
}

function manifestIntegrity(manifest) {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(manifestPayload(manifest)), 'utf8')
    .digest('hex')}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export const MCP_EFFECT_MANIFEST = deepFreeze({
  schema_version: 1,
  catalog_version: '2026-08-24',
  server_aliases: ['wendkeep', 'wendkeep-native'],
  tools: TOOLS,
  integrity: 'sha256:de96c2f3f5ae3d814440b541db778f87be4550ebd2ce9dd5ae2377f354770046',
});

export function verifyMcpEffectManifest(manifest) {
  const names = new Set();
  const aliases = new Set();
  const errors = [];
  if (manifest?.schema_version !== 1) errors.push('schema_version');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(manifest?.catalog_version || ''))) errors.push('catalog_version');
  if (!Array.isArray(manifest?.server_aliases) || !manifest.server_aliases.length) errors.push('server_aliases');
  for (const alias of manifest?.server_aliases || []) {
    if (!/^[a-z][a-z0-9-]*$/.test(alias) || aliases.has(alias)) errors.push('server_alias');
    aliases.add(alias);
  }
  if (!Array.isArray(manifest?.tools) || !manifest.tools.length) errors.push('tools');
  for (const tool of manifest?.tools || []) {
    if (!/^wendkeep_[a-z0-9_]+$/.test(String(tool?.name || '')) || names.has(tool.name)) errors.push('tool_name');
    names.add(tool?.name);
    if (!EFFECTS.has(tool?.effect)) errors.push('tool_effect');
    if (!/^[a-z]+:[a-z]+$/.test(String(tool?.capability || ''))) errors.push('tool_capability');
    if (tool?.effect_version !== 1) errors.push('effect_version');
    if (tool?.input_schema !== 'wendkeep://schema/mcp-tool-input-v1') errors.push('input_schema');
    if (tool?.output_schema !== 'wendkeep://schema/mcp-tool-result-v1') errors.push('output_schema');
  }
  const expected = manifestIntegrity(manifest);
  if (manifest?.integrity !== expected) errors.push('integrity');
  return { valid: errors.length === 0, errors: [...new Set(errors)], expected_integrity: expected };
}

function semanticToolName(toolName, manifest) {
  const name = String(toolName || '');
  if (name.startsWith('wendkeep_')) return name;
  for (const alias of manifest.server_aliases || []) {
    const prefix = `mcp__${alias}__`;
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return '';
}

export function resolveMcpToolEffect(toolName, { manifest = MCP_EFFECT_MANIFEST } = {}) {
  if (!verifyMcpEffectManifest(manifest).valid) {
    return { known: false, name: '', effect: 'unknown', capability: '', effect_version: 0 };
  }
  const name = semanticToolName(toolName, manifest);
  const tool = manifest.tools.find((candidate) => candidate.name === name);
  return tool
    ? {
      known: true,
      name: tool.name,
      effect: tool.effect,
      capability: tool.capability,
      effect_version: tool.effect_version,
    }
    : { known: false, name, effect: 'unknown', capability: '', effect_version: 0 };
}
