import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  DEFAULT_OPERATING_PROFILE,
  evaluateTaskOperatingProfileLease,
  normalizeOperatingProfile,
  operatingProfilePolicy,
  resolveOperatingProfile,
} from '../src/operating-profile.mjs';
import { findProjectBinding, resolveProjectVault } from '../src/project-vault.mjs';
import { readSessionRegistry } from './obsidian-common.mjs';
import { resolveSessionIdentity } from './session-identity.mjs';
import { resolveCommandActiveContext } from '../src/active-context-runtime.mjs';
import { sessionTaskOperatingProfile } from './operating-profile-task-store.mjs';

function bindingDiagnostic(error, configPath = '') {
  return {
    code: error?.code || 'WENDKEEP_VAULT_CONFIG_INVALID',
    message: error?.message
      || `Configuração WendKeep inválida${configPath ? ` em "${configPath}"` : ''}.`,
  };
}

function readResolvedConfig(resolution, suppliedConfig) {
  if (suppliedConfig && typeof suppliedConfig === 'object' && !Array.isArray(suppliedConfig)) {
    return { config: suppliedConfig, bindingError: null };
  }
  if (resolution?.config && typeof resolution.config === 'object' && !Array.isArray(resolution.config)) {
    return { config: resolution.config, bindingError: null };
  }
  if (!resolution?.configPath || !existsSync(resolution.configPath)) {
    return { config: {}, bindingError: null };
  }
  try {
    const parsed = JSON.parse(readFileSync(resolution.configPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { config: parsed, bindingError: null };
    }
    return {
      config: {},
      bindingError: bindingDiagnostic(null, resolution.configPath),
    };
  } catch (error) {
    return {
      config: {},
      bindingError: bindingDiagnostic(error, resolution.configPath),
    };
  }
}

function sessionOverride(entry) {
  if (!entry || !Object.prototype.hasOwnProperty.call(entry, 'operating_profile')) return null;
  const raw = entry.operating_profile;
  try {
    return {
      profile: normalizeOperatingProfile(raw, { strict: true }),
      source: 'session-override',
      valid: true,
      configured: true,
      raw,
    };
  } catch {
    return {
      profile: DEFAULT_OPERATING_PROFILE,
      source: 'session-override-invalid',
      valid: false,
      configured: true,
      raw,
    };
  }
}

function nonNegativeSequence(value, fallback = null) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function taskLeaseContext(entry, input, sessionId) {
  return {
    sessionId,
    turnId: input?.turn_id || input?.turnId || entry?.last_prompt_turn_id || '',
    turnSequence: nonNegativeSequence(
      input?.turn_sequence ?? input?.turnSequence,
      nonNegativeSequence(entry?.last_turn_sequence),
    ),
  };
}

function canonicalPath(value) {
  const path = resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function matchingProjectBinding(vaultResolution, input) {
  if (vaultResolution?.config) {
    return { binding: null, bindingError: vaultResolution.bindingError || null };
  }
  if (vaultResolution?.bindingError) {
    return { binding: null, bindingError: vaultResolution.bindingError };
  }
  const start = input?.cwd
    || input?.project_dir
    || input?.projectDir
    || input?.workspace?.cwd
    || vaultResolution?.projectRoot
    || process.cwd();
  try {
    const binding = findProjectBinding(start);
    return {
      binding: binding && canonicalPath(binding.base) === canonicalPath(vaultResolution.base)
        ? binding
        : null,
      bindingError: vaultResolution.bindingError || null,
    };
  } catch (error) {
    // An explicitly supplied vault is authoritative even when an unrelated
    // nearby project config is malformed, but corruption remains observable.
    if (input?.obsidian_vault_path
      || ['explicit', 'payload', 'legacy-project-settings'].includes(vaultResolution?.source)) {
      return { binding: null, bindingError: bindingDiagnostic(error) };
    }
    throw error;
  }
}

// Resolution precedence for hooks: active request lease -> explicit session override
// -> project binding -> GOVERN.
// Binding corruption is never interpreted as OFF: an authoritative Vault keeps the Keep Core
// alive under GOVERN and carries a visible diagnostic to each entrypoint.
export function resolveHookOperatingProfile({
  input = {},
  resolution = null,
  config = null,
  provider,
} = {}) {
  const initialResolution = resolution || resolveProjectVault({ input });
  const matched = matchingProjectBinding(initialResolution, input);
  const binding = matched.binding;
  const vaultResolution = binding ? {
    ...initialResolution,
    projectRoot: binding.projectRoot,
    projectId: binding.config.projectId,
    configPath: binding.configPath,
    config: binding.config,
  } : initialResolution;
  const configState = readResolvedConfig(vaultResolution, config);
  const bindingError = initialResolution.bindingError
    || matched.bindingError
    || configState.bindingError
    || null;
  const project = resolveOperatingProfile(bindingError ? {} : configState.config);
  const identity = resolveSessionIdentity(vaultResolution.base, input, provider);
  const entry = identity.state === 'resolved'
    ? readSessionRegistry(vaultResolution.base).sessions?.[identity.canonicalConversationId] || null
    : null;
  let activeContext = null;
  let contextError = null;
  if (!bindingError && identity.state === 'resolved') {
    try {
      activeContext = resolveCommandActiveContext({
        vaultBase: vaultResolution.base,
        projectRoot: input?.cwd || vaultResolution.projectRoot || process.cwd(),
        sessionId: identity.canonicalConversationId,
      });
    } catch (error) {
      contextError = bindingDiagnostic(error);
    }
  }
  const base = sessionOverride(entry) || project;
  const taskLease = evaluateTaskOperatingProfileLease(
    contextError ? null : sessionTaskOperatingProfile(
      vaultResolution.base,
      identity.canonicalConversationId || '',
      { context: activeContext },
    ),
    taskLeaseContext(entry, input, identity.canonicalConversationId || ''),
  );
  const selected = taskLease.state === 'active'
    ? {
      profile: taskLease.profile,
      source: 'task-lease',
      valid: true,
      configured: true,
      raw: taskLease.profile,
    }
    : base;
  return {
    ...selected,
    policy: operatingProfilePolicy(selected.profile),
    vaultBase: vaultResolution.base,
    projectRoot: vaultResolution.projectRoot,
    identity,
    entry,
    baseProfile: base.profile,
    baseSource: base.source,
    taskLease,
    activeContext,
    ...(contextError ? { contextError } : {}),
    resolution: vaultResolution,
    ...(bindingError ? { bindingError } : {}),
  };
}

export function hookProfilePolicy(profile = DEFAULT_OPERATING_PROFILE) {
  return operatingProfilePolicy(profile);
}

// Prefix the profile so change-core's 64-char filename cap can never truncate it away.
export function profileSentinelId(sessionId, profile = DEFAULT_OPERATING_PROFILE) {
  return `${normalizeOperatingProfile(profile).toLowerCase()}--${sessionId || 'nosession'}`;
}
