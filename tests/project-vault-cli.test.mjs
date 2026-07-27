import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindProjectVault } from '../src/project-vault.mjs';
import { spawnSync } from 'node:child_process';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

function withoutSensorVault(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.WENDKEEP_SENSOR_VAULT;
  return env;
}

function seedChange(vault, slug) {
  const dir = join(vault, '08-Mudanças', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'proposta.md'), `---\nstatus: active\n---\n# ${slug}\n`);
}

test('CLI discovers project vault and overrides an inherited global vault', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-cli-project-'));
  const project = join(root, 'app');
  const rightVault = join(project, '.vault');
  const wrongVault = join(root, 'wrong-vault');
  mkdirSync(project, { recursive: true });
  try {
    bindProjectVault({ projectRoot: project, vaultPath: rightVault });
    seedChange(rightVault, 'right-change');
    seedChange(wrongVault, 'wrong-change');
    const result = spawnSync(process.execPath, [BIN, 'change', 'list'], {
      cwd: project,
      encoding: 'utf8',
      env: withoutSensorVault({ OBSIDIAN_VAULT_PATH: wrongVault }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /right-change/);
    assert.doesNotMatch(result.stdout, /wrong-change/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('explicit --vault remains authoritative for CLI commands', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-cli-explicit-'));
  const project = join(root, 'app');
  const projectVault = join(project, '.vault');
  const explicitVault = join(root, 'explicit-vault');
  mkdirSync(project, { recursive: true });
  try {
    bindProjectVault({ projectRoot: project, vaultPath: projectVault });
    seedChange(projectVault, 'project-change');
    seedChange(explicitVault, 'explicit-change');
    const result = spawnSync(process.execPath, [BIN, 'change', 'list', '--vault', explicitVault], {
      cwd: project,
      encoding: 'utf8',
      env: { ...process.env, OBSIDIAN_VAULT_PATH: join(root, 'wrong') },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /explicit-change/);
    assert.doesNotMatch(result.stdout, /project-change/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('[req:OP-2] CLI não usa Vault global quando o binding local falha na identidade', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-cli-integrity-'));
  const project = join(root, 'app');
  const intendedVault = join(project, '.vault');
  const wrongVault = join(root, 'wrong-global-vault');
  mkdirSync(project, { recursive: true });
  mkdirSync(wrongVault, { recursive: true });
  try {
    bindProjectVault({ projectRoot: project, vaultPath: intendedVault });
    const markerPath = join(intendedVault, '.brain', 'PROJECT.json');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    writeFileSync(markerPath, `${JSON.stringify({ ...marker, projectId: 'outro-projeto' }, null, 2)}\n`);
    const result = spawnSync(process.execPath, [BIN, 'change', 'new', 'wrong-route', '--simple'], {
      cwd: project,
      encoding: 'utf8',
      env: withoutSensorVault({ OBSIDIAN_VAULT_PATH: wrongVault }),
    });
    assert.notEqual(result.status, 0, 'binding inválido deve abortar antes do dispatch');
    assert.match(result.stderr, /WENDKEEP_VAULT_PROJECT_MISMATCH|Vault de outro projeto/);
    assert.equal(existsSync(join(wrongVault, '08-Mudanças', 'wrong-route')), false);
    assert.equal(existsSync(join(intendedVault, '08-Mudanças', 'wrong-route')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor reports the project-local source without a Windows global env', () => {
  const project = mkdtempSync(join(tmpdir(), 'wk-doctor-project-'));
  const vault = join(project, '.vault');
  try {
    const init = spawnSync(process.execPath, [BIN, 'init', '--project', project, '--vault', vault, '--no-mcp', '--no-companions', '--no-colors', '--yes'], {
      encoding: 'utf8',
      env: withoutSensorVault({ OBSIDIAN_VAULT_PATH: join(project, 'wrong-global') }),
    });
    assert.equal(init.status, 0, init.stderr);
    const env = { ...process.env };
    delete env.OBSIDIAN_VAULT_PATH;
    delete env.WENDKEEP_SENSOR_VAULT;
    const result = spawnSync(process.execPath, [BIN, 'doctor', '--project', project], { cwd: project, encoding: 'utf8', env });
    assert.notEqual(result.status, 2, `vault resolution must succeed; stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stdout, /\[vault\].*project-config/);
    assert.match(result.stdout, new RegExp(vault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally { rmSync(project, { recursive: true, force: true }); }
});
