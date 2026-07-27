// OP-2/OP-3 — public CLI for conservative, auditable operating-profile selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindProjectVault } from '../src/project-vault.mjs';
import { setSessionOperatingProfile } from '../src/profile.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wk-profile-cli-'));
  const project = join(root, 'project');
  const vault = join(root, 'vault');
  mkdirSync(join(vault, '.brain'), { recursive: true });
  mkdirSync(project, { recursive: true });
  bindProjectVault({ projectRoot: project, vaultPath: vault });
  const sessionRel = '02-Sessões/2026/07-JUL/DIA 26/profile.md';
  const sessionPath = join(vault, sessionRel);
  const sessionBytes = Buffer.from([
    '\uFEFF---',
    'id: session-1',
    '---',
    '',
    '# Sessão vinculada real',
    '',
    '## Iterações',
    '',
    '- bytes desta nota não podem mudar',
    '',
  ].join('\r\n'), 'utf8');
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeFileSync(sessionPath, sessionBytes);
  writeFileSync(join(vault, '.brain', 'SESSION_REGISTRY.json'), `${JSON.stringify({
    version: 2,
    sessions: {
      'session-1': {
        status: 'active',
        provider: 'codex',
        session_file: sessionRel,
      },
    },
  }, null, 2)}\n`);
  return { root, project, vault, sessionPath, sessionBytes };
}

function run(project, ...args) {
  return spawnSync(process.execPath, [BIN, 'profile', ...args, '--project', project], {
    cwd: project,
    encoding: 'utf8',
    env: { ...process.env, OBSIDIAN_VAULT_PATH: '' },
  });
}

test('profile status defaults legacy bindings to GOVERN without rewriting them', () => {
  const f = fixture();
  try {
    const before = readFileSync(join(f.project, '.wendkeep.json'), 'utf8');
    const result = run(f.project, 'status', '--json');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      profile: 'GOVERN',
      source: 'default',
      scope: 'project',
      session_id: null,
    });
    assert.equal(readFileSync(join(f.project, '.wendkeep.json'), 'utf8'), before);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('profile use persists explicit OFF at project scope and status reads it back', () => {
  const f = fixture();
  try {
    const changed = run(f.project, 'use', 'OFF', '--json');
    assert.equal(changed.status, 0, changed.stderr);
    assert.equal(JSON.parse(changed.stdout).profile, 'OFF');
    const config = JSON.parse(readFileSync(join(f.project, '.wendkeep.json'), 'utf8'));
    assert.equal(config.harness.profile, 'OFF');
    assert.equal(config.harness.profileSource, 'explicit-cli');
    assert.match(config.harness.profileUpdatedAt, /^\d{4}-\d{2}-\d{2}T/);

    const status = run(f.project, 'status', '--json');
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).profile, 'OFF');
    assert.equal(JSON.parse(status.stdout).source, 'project-binding');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:OP-3] session override is audited without replacing project default, identity or note bytes', () => {
  const f = fixture();
  try {
    const noteBefore = readFileSync(f.sessionPath);
    const changed = run(f.project, 'use', 'FLOW', '--session', 'session-1', '--json');
    assert.equal(changed.status, 0, changed.stderr);
    const registry = JSON.parse(readFileSync(join(f.vault, '.brain', 'SESSION_REGISTRY.json'), 'utf8'));
    assert.equal(registry.sessions['session-1'].operating_profile, 'FLOW');
    assert.equal(registry.sessions['session-1'].operating_profile_source, 'explicit-cli');
    assert.match(registry.sessions['session-1'].operating_profile_updated_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(registry.sessions['session-1'].session_file, '02-Sessões/2026/07-JUL/DIA 26/profile.md');
    assert.deepEqual(readFileSync(f.sessionPath), noteBefore);
    assert.deepEqual(readFileSync(f.sessionPath), f.sessionBytes);

    const sessionStatus = run(f.project, 'status', '--session', 'session-1', '--json');
    assert.equal(sessionStatus.status, 0, sessionStatus.stderr);
    assert.equal(JSON.parse(sessionStatus.stdout).profile, 'FLOW');
    assert.equal(JSON.parse(sessionStatus.stdout).source, 'session-registry');

    const projectStatus = run(f.project, 'status', '--json');
    assert.equal(JSON.parse(projectStatus.stdout).profile, 'GOVERN');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('invalid profile or unknown session exits 2 without partial mutation', () => {
  const f = fixture();
  try {
    const beforeConfig = readFileSync(join(f.project, '.wendkeep.json'), 'utf8');
    const beforeRegistry = readFileSync(join(f.vault, '.brain', 'SESSION_REGISTRY.json'), 'utf8');
    const invalid = run(f.project, 'use', 'AUTO');
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /OFF.*FLOW.*GUIDE.*GOVERN.*ASSURE/i);
    const missing = run(f.project, 'use', 'OFF', '--session', 'missing');
    assert.equal(missing.status, 2);
    assert.equal(readFileSync(join(f.project, '.wendkeep.json'), 'utf8'), beforeConfig);
    assert.equal(readFileSync(join(f.vault, '.brain', 'SESSION_REGISTRY.json'), 'utf8'), beforeRegistry);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('unknown or incomplete flags fail closed instead of mutating project scope', () => {
  const f = fixture();
  try {
    const registryPath = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    registry.sessions['--project'] = { status: 'active', provider: 'codex' };
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    const before = readFileSync(join(f.project, '.wendkeep.json'), 'utf8');
    const beforeRegistry = readFileSync(registryPath, 'utf8');
    assert.equal(run(f.project, 'use', 'OFF', '--sesion', 'session-1').status, 2);
    assert.equal(run(f.project, 'use', 'OFF', '--session').status, 2);
    assert.equal(run(f.project, 'use', 'OFF', '--session', 'session-1', '--session', 'missing').status, 2);
    assert.equal(run(f.project, 'use', 'OFF', '--json', '--json').status, 2);
    assert.equal(run(f.project, 'use', 'OFF', '--session=--project', '--json').status, 2);
    assert.equal(run(f.project, 'use', 'OFF', 'extra').status, 2);
    assert.equal(readFileSync(join(f.project, '.wendkeep.json'), 'utf8'), before);
    assert.equal(readFileSync(registryPath, 'utf8'), beforeRegistry);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('explicit --vault still reads the matching project binding profile', () => {
  const f = fixture();
  try {
    assert.equal(run(f.project, 'use', 'FLOW').status, 0);
    const status = run(f.project, 'status', '--vault', f.vault, '--json');
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).profile, 'FLOW');
    assert.equal(JSON.parse(status.stdout).source, 'project-binding');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('explicit --vault from a nested cwd updates the binding root, not the subdirectory', () => {
  const f = fixture();
  const nested = join(f.project, 'packages', 'app');
  mkdirSync(nested, { recursive: true });
  try {
    const changed = run(nested, 'use', 'ASSURE', '--vault', f.vault, '--json');
    assert.equal(changed.status, 0, changed.stderr);
    const config = JSON.parse(readFileSync(join(f.project, '.wendkeep.json'), 'utf8'));
    assert.equal(config.harness.profile, 'ASSURE');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('Windows vault casing still resolves the matching binding', { skip: process.platform !== 'win32' }, () => {
  const f = fixture();
  try {
    assert.equal(run(f.project, 'use', 'GUIDE').status, 0);
    const status = run(f.project, 'status', '--vault', f.vault.toUpperCase(), '--json');
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).profile, 'GUIDE');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('explicit --vault remains authoritative when the nearby binding is malformed', () => {
  const f = fixture();
  try {
    assert.equal(run(f.project, 'use', 'FLOW', '--session', 'session-1').status, 0);
    writeFileSync(join(f.project, '.wendkeep.json'), '{ invalid json');
    const status = run(f.project, 'status', '--vault', f.vault, '--json');
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).profile, 'GOVERN');
    assert.equal(JSON.parse(status.stdout).source, 'default');
    assert.equal(JSON.parse(status.stdout).binding_error?.code, 'WENDKEEP_VAULT_CONFIG_INVALID');
    assert.match(status.stderr, /WENDKEEP_VAULT_CONFIG_INVALID/);

    const sessionStatus = run(f.project, 'status', '--session', 'session-1', '--vault', f.vault, '--json');
    assert.equal(sessionStatus.status, 0, sessionStatus.stderr);
    assert.equal(JSON.parse(sessionStatus.stdout).profile, 'FLOW');
    assert.equal(JSON.parse(sessionStatus.stdout).source, 'session-registry');
    assert.equal(JSON.parse(sessionStatus.stdout).binding_error?.code, 'WENDKEEP_VAULT_CONFIG_INVALID');
    assert.match(sessionStatus.stderr, /WENDKEEP_VAULT_CONFIG_INVALID/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:OP-3] invalid, empty or null session override fails safe to GOVERN consistently with hooks', () => {
  const f = fixture();
  try {
    assert.equal(run(f.project, 'use', 'FLOW').status, 0);
    const path = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
    for (const invalidOverride of ['TURBO', '', null]) {
      const registry = JSON.parse(readFileSync(path, 'utf8'));
      registry.sessions['session-1'].operating_profile = invalidOverride;
      writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`);
      const status = run(f.project, 'status', '--session', 'session-1', '--json');
      assert.equal(status.status, 0, status.stderr);
      assert.equal(JSON.parse(status.stdout).profile, 'GOVERN');
      assert.equal(JSON.parse(status.stdout).source, 'session-override-invalid');
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('prototype names never count as registry sessions', () => {
  const f = fixture();
  try {
    const before = readFileSync(join(f.vault, '.brain', 'SESSION_REGISTRY.json'), 'utf8');
    const result = run(f.project, 'use', 'OFF', '--session', 'constructor');
    assert.equal(result.status, 2);
    assert.equal(readFileSync(join(f.vault, '.brain', 'SESSION_REGISTRY.json'), 'utf8'), before);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('atomic session setter never recreates a session that vanished before the lock', () => {
  const f = fixture();
  try {
    const path = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
    const registry = JSON.parse(readFileSync(path, 'utf8'));
    delete registry.sessions['session-1'];
    writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`);
    assert.throws(
      () => setSessionOperatingProfile(f.vault, 'session-1', 'OFF', { now: '2026-07-26T12:00:00.000Z' }),
      /sessão não encontrada/i,
    );
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(path, 'utf8')).sessions, 'session-1'), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:OP-9] ajuda pública de profile documenta resolução explícita de projeto e Vault', () => {
  const result = spawnSync(process.execPath, [BIN, 'profile', '--help'], {
    encoding: 'utf8',
    env: { ...process.env, OBSIDIAN_VAULT_PATH: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--project <path> --vault <path> --session <id> --json/);
  assert.match(result.stdout, /Keep Core.*remains active/i);
});
