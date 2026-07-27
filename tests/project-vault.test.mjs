import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PROJECT_CONFIG_FILE,
  PROJECT_MARKER_REL,
  bindProjectVault,
  resolveProjectVault,
  updateProjectBinding,
} from '../src/project-vault.mjs';
import { resolveOperatingProfile, setOperatingProfile } from '../src/operating-profile.mjs';

function tempProject(name = 'project') {
  const parent = mkdtempSync(join(tmpdir(), 'wk-project-vault-'));
  const project = join(parent, name);
  const vault = join(project, '.vault');
  mkdirSync(project, { recursive: true });
  return { parent, project, vault };
}

test('project config resolves a relative vault from a nested Codex cwd', () => {
  const { parent, project, vault } = tempProject('alpha');
  const nested = join(project, 'packages', 'mobile');
  mkdirSync(nested, { recursive: true });
  try {
    const binding = bindProjectVault({ projectRoot: project, vaultPath: vault });
    const result = resolveProjectVault({ input: { cwd: nested } });
    assert.equal(result.base, resolve(vault));
    assert.equal(result.projectRoot, resolve(project));
    assert.equal(result.projectId, binding.projectId);
    assert.equal(result.source, 'project-config');
    const config = JSON.parse(readFileSync(join(project, PROJECT_CONFIG_FILE), 'utf8'));
    assert.equal(config.vault, '.vault');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('two projects remain isolated even when a wrong global Windows vault exists', () => {
  const a = tempProject('alpha');
  const b = tempProject('beta');
  const previous = process.env.OBSIDIAN_VAULT_PATH;
  try {
    bindProjectVault({ projectRoot: a.project, vaultPath: a.vault });
    bindProjectVault({ projectRoot: b.project, vaultPath: b.vault });
    process.env.OBSIDIAN_VAULT_PATH = join(a.parent, 'global-wrong-vault');
    assert.equal(resolveProjectVault({ input: { cwd: a.project } }).base, resolve(a.vault));
    assert.equal(resolveProjectVault({ input: { cwd: b.project } }).base, resolve(b.vault));
  } finally {
    if (previous === undefined) delete process.env.OBSIDIAN_VAULT_PATH;
    else process.env.OBSIDIAN_VAULT_PATH = previous;
    rmSync(a.parent, { recursive: true, force: true });
    rmSync(b.parent, { recursive: true, force: true });
  }
});

test('legacy Claude project setting is discovered by Codex without a global env', () => {
  const { parent, project, vault } = tempProject('legacy');
  mkdirSync(join(project, '.claude'), { recursive: true });
  writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({
    env: { OBSIDIAN_VAULT_PATH: vault },
  }));
  try {
    const result = resolveProjectVault({ input: { cwd: project } });
    assert.equal(result.base, resolve(vault));
    assert.equal(result.source, 'legacy-project-settings');
    assert.equal(result.projectRoot, resolve(project));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('[req:OP-2] legacy setting corrompido no projeto mais próximo não herda Vault do pai', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-project-vault-nested-'));
  const parentProject = join(root, 'parent');
  const childProject = join(parentProject, 'packages', 'child');
  const parentVault = join(parentProject, '.vault');
  mkdirSync(join(parentProject, '.claude'), { recursive: true });
  mkdirSync(join(childProject, '.claude'), { recursive: true });
  writeFileSync(join(parentProject, '.claude', 'settings.json'), JSON.stringify({
    env: { OBSIDIAN_VAULT_PATH: parentVault },
  }));
  const childSettings = join(childProject, '.claude', 'settings.json');
  writeFileSync(childSettings, '{ invalid json');
  try {
    assert.throws(
      () => resolveProjectVault({ input: { cwd: childProject } }),
      (error) => error?.code === 'WENDKEEP_VAULT_CONFIG_INVALID'
        && error.message.includes(childSettings),
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('[req:OP-2] binding JSON estruturalmente inválido vira diagnóstico canônico sob Vault explícito', () => {
  const { parent, project, vault } = tempProject('typed-corruption');
  writeFileSync(join(project, PROJECT_CONFIG_FILE), `${JSON.stringify({
    schemaVersion: 1,
    projectId: 'typed-corruption',
    vault: { unexpected: true },
  }, null, 2)}\n`);
  try {
    assert.throws(
      () => resolveProjectVault({ input: { cwd: project } }),
      (error) => error?.code === 'WENDKEEP_VAULT_CONFIG_INVALID',
    );
    const explicit = resolveProjectVault({ input: { cwd: project, obsidian_vault_path: vault } });
    assert.equal(explicit.base, resolve(vault));
    assert.equal(explicit.bindingError?.code, 'WENDKEEP_VAULT_CONFIG_INVALID');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('missing project binding fails closed and never returns the home fallback', () => {
  const { parent, project } = tempProject('unconfigured');
  try {
    assert.throws(
      () => resolveProjectVault({ input: { cwd: project } }),
      (error) => error?.code === 'WENDKEEP_VAULT_UNCONFIGURED' && /\.wendkeep\.json/.test(error.message),
    );
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('vault marker rejects cross-project contamination', () => {
  const a = tempProject('alpha');
  const b = tempProject('beta');
  try {
    bindProjectVault({ projectRoot: a.project, vaultPath: a.vault });
    mkdirSync(b.vault, { recursive: true });
    const configA = JSON.parse(readFileSync(join(a.project, PROJECT_CONFIG_FILE), 'utf8'));
    writeFileSync(join(b.project, PROJECT_CONFIG_FILE), `${JSON.stringify({
      schemaVersion: 1,
      projectId: 'beta-project',
      vault: a.vault,
    }, null, 2)}\n`);
    assert.ok(existsSync(join(a.vault, ...PROJECT_MARKER_REL.split('/'))));
    assert.throws(
      () => resolveProjectVault({ input: { cwd: b.project } }),
      (error) => error?.code === 'WENDKEEP_VAULT_PROJECT_MISMATCH'
        && error.message.includes(configA.projectId)
        && error.message.includes('beta-project'),
    );
  } finally {
    rmSync(a.parent, { recursive: true, force: true });
    rmSync(b.parent, { recursive: true, force: true });
  }
});

test('binding is idempotent and preserves the project identity', () => {
  const { parent, project, vault } = tempProject('stable');
  try {
    const first = bindProjectVault({ projectRoot: project, vaultPath: vault });
    const second = bindProjectVault({ projectRoot: project, vaultPath: vault });
    assert.equal(second.projectId, first.projectId);
    assert.equal(second.base, first.base);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('binding stores an external vault as an absolute path', () => {
  const project = tempProject('portable');
  const external = mkdtempSync(join(tmpdir(), 'wk-external-vault-'));
  try {
    bindProjectVault({ projectRoot: project.project, vaultPath: external });
    const config = JSON.parse(readFileSync(join(project.project, PROJECT_CONFIG_FILE), 'utf8'));
    assert.equal(config.vault, resolve(external));
    assert.equal(resolveProjectVault({ input: { cwd: project.project } }).base, resolve(external));
  } finally {
    rmSync(project.parent, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test('[req:OP-2] [req:OP-8] binding v1 sem harness.profile continua válido e resolve GOVERN', () => {
  const { parent, project, vault } = tempProject('legacy-profile');
  try {
    bindProjectVault({ projectRoot: project, vaultPath: vault });
    const result = resolveProjectVault({ input: { cwd: project } });
    assert.equal(result.config.schemaVersion, 1);
    assert.equal(resolveOperatingProfile(result.config).profile, 'GOVERN');
    assert.equal(resolveOperatingProfile(result.config).source, 'default');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('[req:OP-2] [req:OP-8] rebind preserva perfil e campos desconhecidos com merge de harness', () => {
  const { parent, project, vault } = tempProject('profile-preserve');
  try {
    const first = bindProjectVault({
      projectRoot: project,
      vaultPath: vault,
      configPatch: {
        futureTopLevel: { enabled: true },
        harness: { profile: 'FLOW', futureHarnessOption: 7 },
      },
    });
    const second = bindProjectVault({
      projectRoot: project,
      vaultPath: vault,
      configPatch: { harness: { anotherHarnessOption: 'kept' } },
    });
    const config = JSON.parse(readFileSync(join(project, PROJECT_CONFIG_FILE), 'utf8'));

    assert.equal(second.projectId, first.projectId);
    assert.equal(config.schemaVersion, 1);
    assert.equal(config.harness.profile, 'FLOW');
    assert.equal(config.harness.futureHarnessOption, 7);
    assert.equal(config.harness.anotherHarnessOption, 'kept');
    assert.deepEqual(config.futureTopLevel, { enabled: true });
    assert.equal(resolveOperatingProfile(second.config).profile, 'FLOW');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('[req:OP-2] configuração inválida preserva o Vault e converge para GOVERN em leitura', () => {
  const { parent, project, vault } = tempProject('invalid-profile');
  try {
    bindProjectVault({
      projectRoot: project,
      vaultPath: vault,
      configPatch: { harness: { profile: 'TURBO' } },
    });
    const result = resolveProjectVault({ input: { cwd: project } });
    assert.equal(result.base, resolve(vault));
    assert.deepEqual(resolveOperatingProfile(result.config), {
      profile: 'GOVERN',
      source: 'default-invalid',
      valid: false,
      configured: true,
      raw: 'TURBO',
    });
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('[req:OP-2] updateProjectBinding persiste setter estrito sem alterar identidade ou campos alheios', () => {
  const { parent, project, vault } = tempProject('profile-update');
  try {
    const first = bindProjectVault({
      projectRoot: project,
      vaultPath: vault,
      configPatch: { futureTopLevel: 42, harness: { futureHarnessOption: true } },
    });
    const beforeInvalid = readFileSync(join(project, PROJECT_CONFIG_FILE), 'utf8');
    assert.throws(
      () => updateProjectBinding(project, (config) => setOperatingProfile(config, 'invalid')),
      (error) => error?.code === 'WENDKEEP_OPERATING_PROFILE_INVALID',
    );
    assert.equal(readFileSync(join(project, PROJECT_CONFIG_FILE), 'utf8'), beforeInvalid, 'falha estrita não muta parcialmente');

    const updated = updateProjectBinding(project, (config) => setOperatingProfile(config, 'assure'));
    assert.equal(updated.config.harness.profile, 'ASSURE');
    assert.equal(updated.config.futureTopLevel, 42);
    assert.equal(updated.config.harness.futureHarnessOption, true);
    assert.equal(updated.config.projectId, first.projectId);
    assert.equal(updated.config.vault, '.vault');
    assert.equal(resolveProjectVault({ input: { cwd: project } }).projectId, first.projectId);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
