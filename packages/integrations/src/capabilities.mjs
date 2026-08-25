export const HOST_CAPABILITIES = [
  'session.start', 'session.resume', 'session.stop', 'prompt.submit',
  'tool.pre', 'tool.post', 'tool.effect.read', 'tool.effect.write',
  'tool.effect.destructive', 'edit.attribution', 'plan.approved', 'decision.capture',
  'task.completed', 'subagent.start', 'subagent.stop', 'transcript.read', 'usage.read',
];

export const HOST_CAPABILITY_STATES = ['native', 'adapted', 'polled', 'manual', 'unavailable'];

function matrix(defaultState, overrides = {}) {
  return Object.fromEntries(HOST_CAPABILITIES.map((capability) => [
    capability, overrides[capability] || defaultState,
  ]));
}

const effectOverrides = {
  'tool.effect.read': 'adapted',
  'tool.effect.write': 'adapted',
  'tool.effect.destructive': 'adapted',
};

export const HOST_CAPABILITY_MANIFESTS = {
  claude: {
    schema_version: 1,
    manifest_version: '2026-08-25',
    host_id: 'claude',
    label: 'Claude Code',
    supported_major_versions: [1, 2],
    envelope_versions: [1],
    capabilities: matrix('native', {
      ...effectOverrides,
      'transcript.read': 'polled',
      'usage.read': 'polled',
    }),
  },
  codex: {
    schema_version: 1,
    manifest_version: '2026-08-25',
    host_id: 'codex',
    label: 'Codex',
    supported_major_versions: [0, 1],
    envelope_versions: [1],
    capabilities: matrix('unavailable', {
      ...effectOverrides,
      'session.start': 'native',
      'session.resume': 'adapted',
      'session.stop': 'native',
      'prompt.submit': 'native',
      'tool.pre': 'native',
      'edit.attribution': 'adapted',
      'decision.capture': 'manual',
      'subagent.start': 'native',
      'subagent.stop': 'native',
      'transcript.read': 'polled',
      'usage.read': 'polled',
    }),
  },
  pi: {
    schema_version: 1,
    manifest_version: '2026-08-25',
    host_id: 'pi',
    label: 'Pi',
    supported_major_versions: [0, 1],
    envelope_versions: [1],
    capabilities: matrix('unavailable', {
      ...effectOverrides,
      'session.start': 'adapted',
      'session.resume': 'adapted',
      'session.stop': 'adapted',
      'prompt.submit': 'adapted',
      'tool.pre': 'adapted',
      'decision.capture': 'manual',
      'task.completed': 'manual',
      'transcript.read': 'polled',
      'usage.read': 'polled',
    }),
  },
  'generic-mcp': {
    schema_version: 1,
    manifest_version: '2026-08-25',
    host_id: 'generic-mcp',
    label: 'Generic MCP/CLI',
    supported_major_versions: ['*'],
    envelope_versions: [1],
    capabilities: matrix('unavailable', {
      ...effectOverrides,
      'session.start': 'manual',
      'session.resume': 'manual',
      'session.stop': 'manual',
      'prompt.submit': 'manual',
      'decision.capture': 'manual',
      'task.completed': 'manual',
    }),
  },
};

const EVENT_CAPABILITIES = {
  SessionStart: 'session.start',
  SessionResume: 'session.resume',
  Stop: 'session.stop',
  UserPromptSubmit: 'prompt.submit',
  PreToolUse: 'tool.pre',
  PostToolUse: 'tool.post',
  PlanApproved: 'plan.approved',
  TaskCompleted: 'task.completed',
  SubagentStart: 'subagent.start',
  SubagentStop: 'subagent.stop',
};

function authorityFor(state) {
  if (['native', 'adapted', 'polled'].includes(state)) return 'verified';
  if (state === 'manual') return 'reported';
  return 'unavailable';
}

export function verifyHostCapabilityManifest(manifest) {
  const errors = [];
  if (manifest?.schema_version !== 1) errors.push('schema_version');
  if (!/^[a-z][a-z0-9-]*$/.test(String(manifest?.host_id || ''))) errors.push('host_id');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(manifest?.manifest_version || ''))) errors.push('manifest_version');
  const keys = Object.keys(manifest?.capabilities || {}).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...HOST_CAPABILITIES].sort())) errors.push('capabilities');
  for (const state of Object.values(manifest?.capabilities || {})) {
    if (!HOST_CAPABILITY_STATES.includes(state)) errors.push('capability_state');
  }
  if (!Array.isArray(manifest?.supported_major_versions) || !manifest.supported_major_versions.length) errors.push('supported_versions');
  if (!Array.isArray(manifest?.envelope_versions) || !manifest.envelope_versions.length) errors.push('envelope_versions');
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function versionSupported(manifest, version) {
  if (manifest.supported_major_versions.includes('*') || !version) return true;
  const match = String(version).match(/^(\d+)(?:\.|$)/);
  return Boolean(match && manifest.supported_major_versions.includes(Number(match[1])));
}

export function buildCoverageFromManifest({
  hostId,
  hostVersion = '',
  observedAt = new Date().toISOString(),
  toolEffects = null,
} = {}) {
  const requested = String(hostId || '').trim().toLowerCase();
  const known = Object.hasOwn(HOST_CAPABILITY_MANIFESTS, requested);
  const manifest = HOST_CAPABILITY_MANIFESTS[known ? requested : 'generic-mcp'];
  const supported = versionSupported(manifest, hostVersion);
  const capabilities = HOST_CAPABILITIES.map((capability) => {
    let state = manifest.capabilities[capability];
    if (capability.startsWith('tool.effect.')) {
      const effect = capability.slice('tool.effect.'.length);
      if (toolEffects?.manifest_valid !== true || toolEffects?.[effect] !== true) state = 'unavailable';
    }
    return { capability, state, authority: authorityFor(state) };
  });
  const degradations = capabilities
    .filter((item) => ['manual', 'unavailable'].includes(item.state))
    .map((item) => ({
      capability: item.capability,
      state: item.state,
      code: item.state === 'manual' ? 'HOST_CAPABILITY_MANUAL' : 'HOST_CAPABILITY_UNAVAILABLE',
      blocking: item.state === 'unavailable',
    }));
  if (!known) degradations.unshift({ capability: '', state: 'manual', code: 'HOST_UNKNOWN', blocking: false });
  if (!supported) degradations.unshift({ capability: '', state: 'unavailable', code: 'HOST_VERSION_UNPROVEN', blocking: true });
  return {
    schema_version: 1,
    manifest_version: manifest.manifest_version,
    host_id: manifest.host_id,
    requested_host_id: requested || manifest.host_id,
    host_version: String(hostVersion || ''),
    version_supported: supported,
    observed_at: new Date(observedAt).toISOString(),
    degraded: degradations.length > 0,
    capabilities,
    degradations,
    tool_effects: toolEffects || {
      manifest_valid: false, catalog_version: '', read: false, write: false,
      destructive: false, unknown: 'fail-closed',
    },
  };
}

function validWaiver(value, capability) {
  return value?.capability === capability
    && value?.authority === 'human'
    && String(value?.approved_by || '').trim()
    && String(value?.reason || '').trim();
}

export function evaluateHostCoverage(coverage, required = [], { waivers = [] } = {}) {
  const rows = new Map((coverage?.capabilities || []).map((item) => [item.capability, item]));
  const findings = [];
  const waived = [];
  for (const capability of [...new Set(required)]) {
    const row = rows.get(capability);
    if (row && row.authority === 'verified') continue;
    const waiver = waivers.find((item) => validWaiver(item, capability));
    if (waiver) {
      waived.push({ capability, approved_by: String(waiver.approved_by), reason: String(waiver.reason) });
      continue;
    }
    findings.push({
      capability,
      state: row?.state || 'unavailable',
      code: row?.state === 'manual' ? 'HOST_CAPABILITY_MANUAL' : 'HOST_CAPABILITY_UNAVAILABLE',
    });
  }
  return { ok: findings.length === 0, findings, waived };
}

export function normalizeHostEnvelope({ hostId, event, envelopeVersion } = {}) {
  const manifest = HOST_CAPABILITY_MANIFESTS[String(hostId || '').toLowerCase()];
  if (!manifest || !manifest.envelope_versions.includes(Number(envelopeVersion))) {
    return { ok: false, code: 'HOST_ENVELOPE_UNKNOWN' };
  }
  const capability = EVENT_CAPABILITIES[String(event || '')];
  if (!capability) return { ok: false, code: 'HOST_ENVELOPE_UNKNOWN' };
  const state = manifest.capabilities[capability];
  return { ok: true, capability, state, authority: authorityFor(state) };
}
