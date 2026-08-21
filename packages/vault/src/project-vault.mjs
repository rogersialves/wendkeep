// Keep Core: project-to-Vault binding and resolution, independent from Harness policy.
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { resolveWorktreeVaultBinding } from './worktree-metadata.mjs';

export const PROJECT_CONFIG_FILE = '.wendkeep.json';
export const PROJECT_MARKER_REL = '.brain/PROJECT.json';
export const PROJECT_CONFIG_SCHEMA = 1;

const PROJECT_VAULT_INTEGRITY_CODES = new Set([
  'WENDKEEP_VAULT_CONFIG_INVALID',
  'WENDKEEP_VAULT_MARKER_MISSING',
  'WENDKEEP_VAULT_PROJECT_MISMATCH',
]);

export function isProjectVaultIntegrityError(error) {
  return PROJECT_VAULT_INTEGRITY_CODES.has(error?.code);
}

function json(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    const wrapped = new Error(`Configuração WendKeep inválida em "${path}": ${error.message}`);
    wrapped.code = 'WENDKEEP_VAULT_CONFIG_INVALID';
    throw wrapped;
  }
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, content, 'utf8');
  renameSync(temp, path);
  return true;
}

function startDirectory(value) {
  const candidate = resolve(String(value || process.cwd()));
  try { return statSync(candidate).isFile() ? dirname(candidate) : candidate; }
  catch { return candidate; }
}

function walkParents(start) {
  const result = [];
  let current = startDirectory(start);
  const root = parse(current).root;
  while (true) {
    result.push(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}

function inputStart(input = {}, fallback = '') {
  return input.cwd
    || input.project_dir
    || input.projectDir
    || input.workspace?.cwd
    || process.env.CLAUDE_PROJECT_DIR
    || fallback
    || process.cwd();
}

function bindingDiagnostic(error) {
  return {
    code: error?.code || 'WENDKEEP_VAULT_CONFIG_INVALID',
    message: error?.message || 'Configuração WendKeep inválida.',
  };
}

function vaultFromConfig(projectRoot, config) {
  const valid = config
    && typeof config === 'object'
    && !Array.isArray(config)
    && config.schemaVersion === PROJECT_CONFIG_SCHEMA
    && typeof config.projectId === 'string'
    && config.projectId.trim()
    && typeof config.vault === 'string'
    && config.vault.trim();
  if (!valid) {
    const error = new Error(
      `Configuração incompleta em "${join(projectRoot, PROJECT_CONFIG_FILE)}". `
      + 'Rode `wendkeep init --project <path> --vault <path>`.',
    );
    error.code = 'WENDKEEP_VAULT_CONFIG_INVALID';
    throw error;
  }
  return isAbsolute(config.vault) ? resolve(config.vault) : resolve(projectRoot, config.vault);
}

export function readProjectBinding(projectRoot) {
  const root = resolve(projectRoot);
  const path = join(root, PROJECT_CONFIG_FILE);
  if (!existsSync(path)) return null;
  const config = json(path);
  return { config, configPath: path, projectRoot: root, base: vaultFromConfig(root, config) };
}

export function findProjectBinding(start) {
  for (const projectRoot of walkParents(start)) {
    const found = readProjectBinding(projectRoot);
    if (found) return found;
  }
  return null;
}

export function findLegacyProjectVault(start) {
  for (const projectRoot of walkParents(start)) {
    const settingsPath = join(projectRoot, '.claude', 'settings.json');
    if (!existsSync(settingsPath)) continue;
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      const raw = settings?.env?.OBSIDIAN_VAULT_PATH;
      if (typeof raw === 'string' && raw.trim()) {
        return {
          base: isAbsolute(raw) ? resolve(raw) : resolve(projectRoot, raw),
          projectRoot,
          source: 'legacy-project-settings',
          configPath: settingsPath,
          projectId: '',
          config: null,
        };
      }
    } catch (error) {
      const wrapped = new Error(`Configuração WendKeep legada inválida em "${settingsPath}": ${error.message}`);
      wrapped.code = 'WENDKEEP_VAULT_CONFIG_INVALID';
      throw wrapped;
    }
  }
  return null;
}

export function readVaultMarker(vaultPath) {
  const markerPath = join(resolve(vaultPath), ...PROJECT_MARKER_REL.split('/'));
  if (!existsSync(markerPath)) return null;
  return { marker: json(markerPath), markerPath };
}

function validateMarker(result) {
  const found = readVaultMarker(result.base);
  if (!found) {
    const error = new Error(
      `O vault "${result.base}" ainda não possui ${PROJECT_MARKER_REL}. `
      + `Rode \`wendkeep init --project "${result.projectRoot}" --vault "${result.base}" --yes\`.`,
    );
    error.code = 'WENDKEEP_VAULT_MARKER_MISSING';
    throw error;
  }
  if (found.marker?.projectId !== result.projectId) {
    const error = new Error(
      `Vault de outro projeto: configuração "${result.projectId}" aponta para marcador `
      + `"${found.marker?.projectId || 'ausente'}" em "${found.markerPath}".`,
    );
    error.code = 'WENDKEEP_VAULT_PROJECT_MISMATCH';
    throw error;
  }
}

export function resolveProjectVault({
  input = {},
  startDir = '',
  explicitVault = '',
  allowLegacySettings = true,
  validateIdentity = true,
} = {}) {
  const start = inputStart(input, startDir);
  const explicit = explicitVault || input?.obsidian_vault_path;
  if (explicit) {
    let bindingError = null;
    try { findProjectBinding(start); }
    catch (error) {
      if (error?.code !== 'WENDKEEP_VAULT_CONFIG_INVALID') throw error;
      bindingError = bindingDiagnostic(error);
    }
    return {
      base: isAbsolute(explicit) ? resolve(explicit) : resolve(startDirectory(start), explicit),
      source: explicitVault ? 'explicit' : 'payload',
      projectRoot: startDirectory(start),
      projectId: '',
      configPath: '',
      config: null,
      ...(bindingError ? { bindingError } : {}),
    };
  }

  let binding = null;
  let bindingFailure = null;
  try { binding = findProjectBinding(start); }
  catch (error) {
    if (error?.code !== 'WENDKEEP_VAULT_CONFIG_INVALID') throw error;
    bindingFailure = error;
  }
  if (binding) {
    let result = {
      base: binding.base,
      source: 'project-config',
      projectRoot: binding.projectRoot,
      projectId: binding.config.projectId,
      configPath: binding.configPath,
      config: binding.config,
    };
    if (validateIdentity) {
      try {
        validateMarker(result);
      } catch (error) {
        const canUsePrivateBinding = error?.code === 'WENDKEEP_VAULT_MARKER_MISSING'
          && !isAbsolute(binding.config.vault);
        if (!canUsePrivateBinding) throw error;
        const privateBinding = resolveWorktreeVaultBinding({
          startDir: start,
          projectId: binding.config.projectId,
        });
        if (!privateBinding) throw error;
        result = {
          ...result,
          base: privateBinding.base,
          source: 'worktree-registry',
          projectRoot: privateBinding.projectRoot,
          repositoryId: privateBinding.repositoryId,
          registryPath: privateBinding.registryPath,
        };
        validateMarker(result);
      }
    }
    return result;
  }

  if (allowLegacySettings) {
    const legacy = findLegacyProjectVault(start);
    if (legacy) {
      return {
        ...legacy,
        ...(bindingFailure ? { bindingError: bindingDiagnostic(bindingFailure) } : {}),
      };
    }
  }

  if (bindingFailure) throw bindingFailure;

  const error = new Error(
    `Nenhum vault WendKeep vinculado ao projeto em "${startDirectory(start)}". `
    + `Crie ${PROJECT_CONFIG_FILE} com \`wendkeep init --project "${startDirectory(start)}" --vault <path> --yes\`.`,
  );
  error.code = 'WENDKEEP_VAULT_UNCONFIGURED';
  throw error;
}

function portableVaultPath(projectRoot, vaultPath) {
  const rel = relative(projectRoot, vaultPath);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.replaceAll('\\', '/');
  return vaultPath;
}

function objectRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function bindProjectVault({ projectRoot, vaultPath, configPatch = {} }) {
  const root = resolve(projectRoot);
  const base = isAbsolute(vaultPath) ? resolve(vaultPath) : resolve(root, vaultPath);
  const existing = readProjectBinding(root);
  const existingMarker = readVaultMarker(base);
  const projectId = existing?.config?.projectId || existingMarker?.marker?.projectId || randomUUID();

  if (existingMarker?.marker?.projectId && existingMarker.marker.projectId !== projectId) {
    const error = new Error(
      `Não é seguro vincular "${root}" ao vault de outro projeto: `
      + `esperado "${projectId}", encontrado "${existingMarker.marker.projectId}".`,
    );
    error.code = 'WENDKEEP_VAULT_PROJECT_MISMATCH';
    throw error;
  }

  mkdirSync(join(base, '.brain'), { recursive: true });
  const previousConfig = objectRecord(existing?.config);
  const patch = objectRecord(configPatch);
  const config = {
    ...previousConfig,
    ...patch,
    schemaVersion: PROJECT_CONFIG_SCHEMA,
    projectId,
    vault: portableVaultPath(root, base),
  };
  if (previousConfig.harness || patch.harness) {
    config.harness = {
      ...objectRecord(previousConfig.harness),
      ...objectRecord(patch.harness),
    };
  }
  const marker = {
    ...objectRecord(existingMarker?.marker),
    schemaVersion: PROJECT_CONFIG_SCHEMA,
    projectId,
    projectName: basename(root),
  };
  atomicJson(join(base, ...PROJECT_MARKER_REL.split('/')), marker);
  atomicJson(join(root, PROJECT_CONFIG_FILE), config);
  return { base, projectRoot: root, projectId, config, marker };
}

export function updateProjectBinding(projectRoot, updater) {
  const binding = readProjectBinding(projectRoot);
  if (!binding) {
    const error = new Error(
      `Nenhum binding WendKeep em "${resolve(projectRoot)}". Rode \`wendkeep init\` primeiro.`,
    );
    error.code = 'WENDKEEP_VAULT_UNCONFIGURED';
    throw error;
  }
  if (typeof updater !== 'function') {
    throw new TypeError('updateProjectBinding exige uma função updater.');
  }

  const current = {
    ...binding.config,
    ...(binding.config.harness ? { harness: { ...objectRecord(binding.config.harness) } } : {}),
  };
  const candidate = updater(current);
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    const error = new Error('Updater do binding WendKeep deve retornar um objeto de configuração.');
    error.code = 'WENDKEEP_VAULT_CONFIG_INVALID';
    throw error;
  }

  const config = {
    ...candidate,
    schemaVersion: PROJECT_CONFIG_SCHEMA,
    projectId: binding.config.projectId,
    vault: binding.config.vault,
  };
  atomicJson(binding.configPath, config);
  return {
    ...binding,
    config,
    base: vaultFromConfig(binding.projectRoot, config),
  };
}
