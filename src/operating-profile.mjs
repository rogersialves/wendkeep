export const OPERATING_PROFILES = Object.freeze([
  'OFF',
  'FLOW',
  'GUIDE',
  'GOVERN',
  'ASSURE',
]);
export const DEFAULT_OPERATING_PROFILE = 'GOVERN';

const PROFILE_SET = new Set(OPERATING_PROFILES);

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
