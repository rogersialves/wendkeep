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

export const PROJECT_CONFIG_FILE = '.wendkeep.json';
export const PROJECT_MARKER_REL = '.brain/PROJECT.json';
export const PROJECT_CONFIG_SCHEMA = 1;

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

function vaultFromConfig(projectRoot, config) {
  if (!config || config.schemaVersion !== PROJECT_CONFIG_SCHEMA || !config.projectId || !config.vault) {
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
        };
      }
    } catch { /* init/doctor explicam JSON inválido; descoberta segue procurando */ }
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
    return {
      base: isAbsolute(explicit) ? resolve(explicit) : resolve(startDirectory(start), explicit),
      source: explicitVault ? 'explicit' : 'payload',
      projectRoot: startDirectory(start),
      projectId: '',
      configPath: '',
    };
  }

  const binding = findProjectBinding(start);
  if (binding) {
    const result = {
      base: binding.base,
      source: 'project-config',
      projectRoot: binding.projectRoot,
      projectId: binding.config.projectId,
      configPath: binding.configPath,
    };
    if (validateIdentity) validateMarker(result);
    return result;
  }

  if (allowLegacySettings) {
    const legacy = findLegacyProjectVault(start);
    if (legacy) return legacy;
  }

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

export function bindProjectVault({ projectRoot, vaultPath }) {
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
  const config = {
    schemaVersion: PROJECT_CONFIG_SCHEMA,
    projectId,
    vault: portableVaultPath(root, base),
  };
  const marker = {
    schemaVersion: PROJECT_CONFIG_SCHEMA,
    projectId,
    projectName: basename(root),
  };
  atomicJson(join(base, ...PROJECT_MARKER_REL.split('/')), marker);
  atomicJson(join(root, PROJECT_CONFIG_FILE), config);
  return { base, projectRoot: root, projectId, config, marker };
}
