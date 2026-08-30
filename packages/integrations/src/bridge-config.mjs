import { isAbsolute, relative, resolve, sep } from 'node:path';

import { ECOSYSTEM_ADAPTER_MANIFESTS, isVersionInRange } from './capabilities.mjs';
import { bridgeDiagnostic, bridgeError } from './bridge-diagnostics.mjs';

const ADAPTERS = ['spec-kit', 'superpowers'];

export function isProjectContainedPath(projectRoot, targetPath, pathApi = { relative, isAbsolute, sep }) {
  const rel = pathApi.relative(projectRoot, targetPath);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel));
}

export function inspectBridgeAdapterRoot(projectRoot, configuredRoot, { adapter = '', fs = null } = {}) {
  const invalid = (path, message) => ({
    valid: false,
    present: false,
    path,
    diagnostics: [bridgeDiagnostic('BRIDGE_SOURCE_INVALID', {
      adapter, path, message,
    })],
  });
  if (!fs || ['existsSync', 'lstatSync', 'realpathSync'].some((name) => typeof fs[name] !== 'function')) {
    return invalid(resolve(projectRoot), 'bridge filesystem capability is unavailable');
  }
  const { existsSync, lstatSync, realpathSync } = fs;
  let root;
  try {
    root = realpathSync(resolve(projectRoot));
  } catch (error) {
    return invalid(resolve(projectRoot), `project root is not a real directory: ${error?.message || error}`);
  }
  const candidate = resolve(root, configuredRoot || `.${adapter}`);
  if (!isProjectContainedPath(root, candidate)) {
    return invalid(candidate, `${adapter} root must stay inside the project`);
  }
  if (!existsSync(candidate)) return { valid: true, present: false, path: candidate, diagnostics: [] };
  try {
    const real = realpathSync(candidate);
    if (!isProjectContainedPath(root, real)) {
      return invalid(candidate, `${adapter} root symlink escapes the project`);
    }
    if (!lstatSync(real).isDirectory()) {
      return invalid(candidate, `${adapter} root must be a directory`);
    }
    return { valid: true, present: true, path: real, diagnostics: [] };
  } catch (error) {
    return invalid(candidate, `${adapter} root is unsafe: ${error?.message || error}`);
  }
}

export function normalizeBridgeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw bridgeError('BRIDGE_CONFIG_INVALID', 'bridge config must be an object');
  }
  if (input.schema_version !== undefined && input.schema_version !== 1) {
    throw bridgeError('BRIDGE_CONFIG_INVALID', 'bridge config requires schema_version 1');
  }
  const configured = input.adapters || {};
  const unknown = Object.keys(configured).filter((name) => !ADAPTERS.includes(name));
  if (unknown.length) throw bridgeError('BRIDGE_CONFIG_INVALID', `unknown bridge adapter: ${unknown.join(', ')}`);
  const adapters = {};
  for (const name of ADAPTERS) {
    const value = configured[name] || {};
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw bridgeError('BRIDGE_CONFIG_INVALID', `adapter config must be an object: ${name}`);
    }
    const ownershipClaims = value.ownership_claims === undefined ? [] : value.ownership_claims;
    if (!Array.isArray(ownershipClaims) || ownershipClaims.some((claim) => (
      !claim || typeof claim !== 'object' || Array.isArray(claim)
      || !String(claim.concept || '').trim() || !String(claim.owner || '').trim()
    ))) {
      throw bridgeError('BRIDGE_CONFIG_INVALID', `ownership_claims must contain concept/owner pairs: ${name}`);
    }
    adapters[name] = {
      enabled: value.enabled === true,
      ...(value.root ? { root: String(value.root) } : {}),
      ...(value.version ? { version: String(value.version) } : {}),
      ...(ownershipClaims.length ? {
        ownership_claims: ownershipClaims.map((claim) => ({
          concept: String(claim.concept).trim(), owner: String(claim.owner).trim(),
        })),
      } : {}),
    };
  }
  return { schema_version: 1, adapters };
}

export function readBridgeConfig(projectRoot, configPath = '', { fs = null } = {}) {
  if (!fs || ['existsSync', 'readFileSync', 'realpathSync'].some((name) => typeof fs[name] !== 'function')) {
    throw bridgeError('BRIDGE_CONFIG_INVALID', 'bridge filesystem capability is unavailable');
  }
  const { existsSync, readFileSync, realpathSync } = fs;
  const root = realpathSync(resolve(projectRoot));
  const path = resolve(root, configPath || '.wendkeep/ecosystem-bridges.json');
  if (!isProjectContainedPath(root, path)) {
    throw bridgeError('BRIDGE_CONFIG_INVALID', 'bridge config must stay inside the project', { path });
  }
  if (!existsSync(path)) return { path, exists: false, config: normalizeBridgeConfig({}) };
  const real = realpathSync(path);
  if (!isProjectContainedPath(root, real)) {
    throw bridgeError('BRIDGE_CONFIG_INVALID', 'bridge config symlink escapes the project', { path });
  }
  try {
    return { path: real, exists: true, config: normalizeBridgeConfig(JSON.parse(readFileSync(real, 'utf8'))) };
  } catch (error) {
    if (error?.code === 'BRIDGE_CONFIG_INVALID') throw error;
    throw bridgeError('BRIDGE_CONFIG_INVALID', `invalid bridge config: ${error?.message || error}`, { path });
  }
}

export function assessBridgeAdapter(name, { config = normalizeBridgeConfig({}), detectedVersion = '', present = true } = {}) {
  const manifest = ECOSYSTEM_ADAPTER_MANIFESTS[name];
  if (!manifest) {
    return { available: false, diagnostics: [bridgeDiagnostic('BRIDGE_ADAPTER_UNKNOWN', { adapter: name })] };
  }
  const adapter = config.adapters[name] || { enabled: false };
  if (!adapter.enabled) {
    return { available: false, diagnostics: [bridgeDiagnostic('BRIDGE_ADAPTER_DISABLED', {
      adapter: name, blocking: false, message: `${name} adapter is disabled`,
    })] };
  }
  if (!present) {
    return { available: false, diagnostics: [bridgeDiagnostic('BRIDGE_ADAPTER_MISSING', {
      adapter: name, message: `${name} adapter source was not found`,
    })] };
  }
  const version = detectedVersion || adapter.version || '';
  if (!version) {
    return { available: false, diagnostics: [bridgeDiagnostic('BRIDGE_VERSION_MISSING', {
      adapter: name, expected: manifest.compatibility_range,
    })] };
  }
  if (!isVersionInRange(version, manifest.compatibility_range)) {
    return { available: false, diagnostics: [bridgeDiagnostic('BRIDGE_VERSION_INCOMPATIBLE', {
      adapter: name, expected: manifest.compatibility_range, observed: version,
    })] };
  }
  return { available: true, adapter: name, version, manifest, diagnostics: [] };
}
