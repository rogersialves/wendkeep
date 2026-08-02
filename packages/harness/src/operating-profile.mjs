export const OPERATING_PROFILES = Object.freeze([
  'OFF',
  'FLOW',
  'GUIDE',
  'GOVERN',
  'ASSURE',
]);
export const DEFAULT_OPERATING_PROFILE = 'GOVERN';
export const ADAPTIVE_OPERATING_PROFILES = Object.freeze([
  'FLOW',
  'GUIDE',
  'GOVERN',
  'ASSURE',
]);

const PROFILE_SET = new Set(OPERATING_PROFILES);
const ADAPTIVE_PROFILE_SET = new Set(ADAPTIVE_OPERATING_PROFILES);
export const TASK_PROFILE_REASON_MAX_LENGTH = 500;

function policy(profile, route, options) {
  return Object.freeze({
    profile,
    route: Object.freeze(route),
    keepCore: true,
    ...options,
  });
}

export const OPERATING_PROFILE_POLICIES = Object.freeze({
  OFF: policy('OFF', ['LLM'], {
    harness: false,
    contract: 'native',
    requiresChange: false,
    requiresReview: false,
    requiresConfirmation: false,
  }),
  FLOW: policy('FLOW', ['E', 'V'], {
    harness: true,
    contract: 'flow',
    requiresChange: false,
    requiresReview: false,
    requiresConfirmation: false,
  }),
  GUIDE: policy('GUIDE', ['P', 'E', 'V'], {
    harness: true,
    contract: 'simple-change',
    requiresChange: true,
    requiresReview: false,
    requiresConfirmation: false,
  }),
  GOVERN: policy('GOVERN', ['P', 'R', 'E', 'V'], {
    harness: true,
    contract: 'change',
    requiresChange: true,
    requiresReview: true,
    requiresConfirmation: false,
  }),
  ASSURE: policy('ASSURE', ['P', 'R', 'E', 'V', 'C'], {
    harness: true,
    contract: 'change',
    requiresChange: true,
    requiresReview: true,
    requiresConfirmation: true,
  }),
});

function invalidProfileError(value) {
  const rendered = typeof value === 'string' ? `"${value}"` : String(value);
  const error = new Error(
    `Perfil de Operação inválido: ${rendered}. Use ${OPERATING_PROFILES.join(', ')}.`,
  );
  error.code = 'WENDKEEP_OPERATING_PROFILE_INVALID';
  return error;
}

function canonicalProfile(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toUpperCase();
}

function taskProfileError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function taskProfile(value) {
  const profile = canonicalProfile(value);
  if (ADAPTIVE_PROFILE_SET.has(profile)) return profile;
  throw taskProfileError(
    'WENDKEEP_TASK_PROFILE_INVALID',
    `Perfil temporário inválido: ${typeof value === 'string' ? `"${value}"` : String(value)}. `
      + `Use ${ADAPTIVE_OPERATING_PROFILES.join(', ')}; OFF exige seleção humana persistente.`,
  );
}

function taskReason(value) {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason && reason.length <= TASK_PROFILE_REASON_MAX_LENGTH) return reason;
  throw taskProfileError(
    'WENDKEEP_TASK_PROFILE_REASON_INVALID',
    `Motivo da rota temporária deve ter entre 1 e ${TASK_PROFILE_REASON_MAX_LENGTH} caracteres.`,
  );
}

function taskSequence(value) {
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

function taskContextError() {
  return taskProfileError(
    'WENDKEEP_TASK_PROFILE_CONTEXT_INVALID',
    'Rota temporária exige sessão, prompt causal, lease id e timestamp válidos.',
  );
}

export function createTaskOperatingProfileLease({
  profile,
  reason,
  sessionId,
  turnId = '',
  turnSequence,
  leaseId,
  issuedAt,
} = {}) {
  const selected = taskProfile(profile);
  const auditedReason = taskReason(reason);
  const session = typeof sessionId === 'string' ? sessionId.trim() : '';
  const requestTurnId = typeof turnId === 'string' ? turnId.trim() : '';
  const sequence = taskSequence(turnSequence);
  const id = typeof leaseId === 'string' ? leaseId.trim() : '';
  const issued = typeof issuedAt === 'string' ? issuedAt.trim() : '';
  if (!session || !requestTurnId || sequence === null || !id || !issued || !Number.isFinite(Date.parse(issued))) {
    throw taskContextError();
  }
  return {
    lease_id: id,
    state: 'active',
    profile: selected,
    requested_by: 'llm-harness',
    reason: auditedReason,
    session_id: session,
    request_turn_id: requestTurnId,
    request_turn_sequence: sequence,
    issued_at: issued,
    expires_on: 'request-stop',
  };
}

export function evaluateTaskOperatingProfileLease(lease, {
  sessionId = '',
  turnId = '',
  turnSequence,
} = {}) {
  if (lease === undefined || lease === null) return { state: 'absent' };
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) return { state: 'invalid' };

  let normalized;
  try {
    normalized = createTaskOperatingProfileLease({
      profile: lease.profile,
      reason: lease.reason,
      sessionId: lease.session_id,
      turnId: lease.request_turn_id,
      turnSequence: lease.request_turn_sequence,
      leaseId: lease.lease_id,
      issuedAt: lease.issued_at,
    });
  } catch {
    return {
      state: 'invalid',
      ...(typeof lease.lease_id === 'string' && lease.lease_id ? { lease_id: lease.lease_id } : {}),
    };
  }
  if (lease.requested_by !== 'llm-harness' || lease.expires_on !== 'request-stop') {
    return { state: 'invalid', lease_id: normalized.lease_id };
  }
  if (lease.state === 'consumed' || lease.state === 'expired') {
    return { ...lease, ...normalized, state: lease.state };
  }
  if (lease.state !== 'active') return { state: 'invalid', lease_id: normalized.lease_id };

  const currentSession = typeof sessionId === 'string' ? sessionId.trim() : '';
  const currentTurnId = typeof turnId === 'string' ? turnId.trim() : '';
  const currentSequence = taskSequence(turnSequence);
  if (!currentSession || !currentTurnId || currentSequence === null) {
    return { ...normalized, state: 'invalid' };
  }
  if (normalized.session_id !== currentSession) {
    return { ...normalized, state: 'invalid' };
  }
  const turnIdMismatch = normalized.request_turn_id !== currentTurnId;
  if (turnIdMismatch || normalized.request_turn_sequence !== currentSequence) {
    return { ...normalized, state: 'expired' };
  }
  return normalized;
}

export function normalizeOperatingProfile(value, { strict = false } = {}) {
  const normalized = canonicalProfile(value);
  if (PROFILE_SET.has(normalized)) return normalized;
  if (strict) throw invalidProfileError(value);
  return DEFAULT_OPERATING_PROFILE;
}

export function resolveOperatingProfile(config = {}) {
  const harness = config && typeof config === 'object' && !Array.isArray(config)
    && config.harness && typeof config.harness === 'object' && !Array.isArray(config.harness)
    ? config.harness
    : null;
  const configured = !!harness && Object.prototype.hasOwnProperty.call(harness, 'profile');
  if (!configured) {
    return {
      profile: DEFAULT_OPERATING_PROFILE,
      source: 'default',
      valid: true,
      configured: false,
      raw: null,
    };
  }

  const raw = harness.profile;
  const normalized = canonicalProfile(raw);
  if (PROFILE_SET.has(normalized)) {
    return {
      profile: normalized,
      source: 'project-binding',
      valid: true,
      configured: true,
      raw,
    };
  }
  return {
    profile: DEFAULT_OPERATING_PROFILE,
    source: 'default-invalid',
    valid: false,
    configured: true,
    raw,
  };
}

export function operatingProfilePolicy(value) {
  return OPERATING_PROFILE_POLICIES[normalizeOperatingProfile(value)];
}

export function setOperatingProfile(config = {}, value) {
  const profile = normalizeOperatingProfile(value, { strict: true });
  const base = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const harness = base.harness && typeof base.harness === 'object' && !Array.isArray(base.harness)
    ? base.harness
    : {};
  return {
    ...base,
    harness: {
      ...harness,
      profile,
    },
  };
}
