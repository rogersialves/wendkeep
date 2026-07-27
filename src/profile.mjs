// Public operating-profile CLI. Keep project binding and session override mutations atomic,
// while profile policy itself remains pure in operating-profile.mjs.
import { mutateSessionRegistry, readSessionRegistry } from '../hooks/obsidian-common.mjs';
import {
  DEFAULT_OPERATING_PROFILE,
  normalizeOperatingProfile,
  resolveOperatingProfile,
  setOperatingProfile,
} from './operating-profile.mjs';
import { resolve } from 'node:path';
import { findProjectBinding, resolveProjectVault, updateProjectBinding } from './project-vault.mjs';

export const PROFILE_HELP = `wendkeep profile <subcommand>

  status [--session <id>]
  use <OFF|FLOW|GUIDE|GOVERN|ASSURE> [--session <id>]

Common options: --project <path> --vault <path> --session <id> --json
The Keep Core (Vault, session, and memory) remains active under every profile.
`;

const VALUE_OPTIONS = new Set(['--project', '--vault', '--session']);
const FLAG_OPTIONS = new Set(['--json']);

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1] || '';
  return argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

function commandArgs(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (['--project', '--vault', '--session'].includes(value)) { index += 1; continue; }
    if (value.startsWith('--project=') || value.startsWith('--vault=') || value.startsWith('--session=')) continue;
    if (value === '--json') continue;
    values.push(value);
  }
  return values;
}

function validateArgv(argv) {
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (FLAG_OPTIONS.has(value)) {
      if (seen.has(value)) throw new Error(`opção duplicada: ${value}`);
      seen.add(value);
      continue;
    }
    if (VALUE_OPTIONS.has(value)) {
      if (seen.has(value)) throw new Error(`opção duplicada: ${value}`);
      seen.add(value);
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${value} requer um valor`);
      index += 1;
      continue;
    }
    if (value.startsWith('--')) {
      const name = value.split('=', 1)[0];
      if (!VALUE_OPTIONS.has(name)) throw new Error(`opção desconhecida: ${name}`);
      if (seen.has(name)) throw new Error(`opção duplicada: ${name}`);
      seen.add(name);
      const inlineValue = value.slice(name.length + 1);
      if (!inlineValue || inlineValue.startsWith('--')) throw new Error(`${name} requer um valor`);
    }
  }
}

function canonicalPath(value) {
  const path = resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function output(payload, json) {
  if (json) process.stdout.write(`${JSON.stringify(payload)}\n`);
  else {
    const scope = payload.scope === 'session' ? `session ${payload.session_id}` : 'project';
    process.stdout.write(`${payload.profile} (${scope}; ${payload.source})\n`);
  }
  if (payload.binding_error) {
    const code = payload.binding_error.code || 'WENDKEEP_VAULT_CONFIG_INVALID';
    process.stderr.write(`wendkeep profile: ${code}: ${payload.binding_error.message || 'binding WendKeep inválido'}\n`);
  }
}

function fail(message) {
  process.stderr.write(`wendkeep profile: ${message}\n`);
  return 2;
}

function context(argv) {
  const explicitVault = optionValue(argv, '--vault');
  const startDir = optionValue(argv, '--project') || process.cwd();
  const resolved = resolveProjectVault({ startDir, explicitVault });
  let binding = null;
  try { binding = findProjectBinding(startDir); }
  catch (error) {
    if (!explicitVault) throw error;
  }
  const matchingBinding = binding && canonicalPath(binding.base) === canonicalPath(resolved.base) ? binding : null;
  const projectConfig = resolved.config || matchingBinding?.config || {};
  return {
    resolved: {
      ...resolved,
      projectRoot: matchingBinding?.projectRoot || (resolved.config ? resolved.projectRoot : null),
    },
    projectConfig,
    vaultBase: resolved.base,
  };
}

export function setSessionOperatingProfile(vaultBase, sessionId, profile, { now } = {}) {
  const selected = normalizeOperatingProfile(profile, { strict: true });
  const updatedAt = now || new Date().toISOString();
  return mutateSessionRegistry(vaultBase, (registry) => {
    const sessions = registry.sessions || (registry.sessions = {});
    if (!Object.hasOwn(sessions, sessionId)) throw new Error(`sessão não encontrada: ${sessionId}`);
    const current = sessions[sessionId];
    sessions[sessionId] = {
      ...current,
      operating_profile: selected,
      operating_profile_source: 'explicit-cli',
      operating_profile_updated_at: updatedAt,
      updated_at: updatedAt,
    };
    return sessions[sessionId];
  });
}

function sessionProfile(vaultBase, sessionId, projectResolved) {
  const sessions = readSessionRegistry(vaultBase).sessions || {};
  if (!Object.hasOwn(sessions, sessionId)) throw new Error(`sessão não encontrada: ${sessionId}`);
  const entry = sessions[sessionId];
  if (Object.hasOwn(entry, 'operating_profile')) {
    try {
      return {
        profile: normalizeOperatingProfile(entry.operating_profile, { strict: true }),
        source: 'session-registry',
      };
    } catch {
      return {
        profile: DEFAULT_OPERATING_PROFILE,
        source: 'session-override-invalid',
      };
    }
  }
  return { profile: projectResolved.profile, source: projectResolved.source };
}

export function runProfile(argv = []) {
  try { validateArgv(argv); }
  catch (error) { return fail(error.message); }
  const args = commandArgs(argv);
  const sub = args[0] || 'status';
  const json = argv.includes('--json');
  const sessionId = optionValue(argv, '--session') || '';

  let state;
  try { state = context(argv); }
  catch (error) { return fail(error.message); }

  const projectResolved = resolveOperatingProfile(state.projectConfig);
  if (sub === 'status' || sub === 'show') {
    if (args.length > 1) return fail(`${sub} não aceita argumentos posicionais adicionais`);
    try {
      const effective = sessionId
        ? sessionProfile(state.vaultBase, sessionId, projectResolved)
        : { profile: projectResolved.profile, source: projectResolved.source };
      output({
        profile: effective.profile,
        source: effective.source,
        scope: sessionId ? 'session' : 'project',
        session_id: sessionId || null,
        ...(state.resolved.bindingError ? { binding_error: state.resolved.bindingError } : {}),
      }, json);
      return 0;
    } catch (error) { return fail(error.message); }
  }

  if (sub !== 'use' && sub !== 'set') return fail('use status | use <OFF|FLOW|GUIDE|GOVERN|ASSURE>');
  if (args.length !== 2) return fail(`${sub} requer exatamente um perfil`);
  let profile;
  try { profile = normalizeOperatingProfile(args[1], { strict: true }); }
  catch { return fail('perfil inválido; use OFF, FLOW, GUIDE, GOVERN ou ASSURE'); }

  if (sessionId) {
    try { setSessionOperatingProfile(state.vaultBase, sessionId, profile); }
    catch (error) { return fail(error.message); }
    output({
      profile,
      source: 'session-registry',
      scope: 'session',
      session_id: sessionId,
      ...(state.resolved.bindingError ? { binding_error: state.resolved.bindingError } : {}),
    }, json);
    return 0;
  }

  if (!state.resolved.projectRoot) return fail('binding de projeto necessário para alterar o perfil padrão');
  try {
    const updatedAt = new Date().toISOString();
    updateProjectBinding(state.resolved.projectRoot, (current) => {
      const next = setOperatingProfile(current, profile);
      return {
        ...next,
        harness: {
          ...next.harness,
          profileSource: 'explicit-cli',
          profileUpdatedAt: updatedAt,
        },
      };
    });
  } catch (error) { return fail(error.message); }
  output({
    profile,
    source: 'project-binding',
    scope: 'project',
    session_id: null,
    ...(state.resolved.bindingError ? { binding_error: state.resolved.bindingError } : {}),
  }, json);
  return 0;
}
