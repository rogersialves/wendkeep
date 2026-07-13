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
} from '../src/project-vault.mjs';

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
