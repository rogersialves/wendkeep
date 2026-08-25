// OP-2/OP-3 — public CLI for conservative, auditable operating-profile selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindProjectVault, resolveProjectVault } from '../src/project-vault.mjs';
import { setSessionOperatingProfile } from '../src/profile.mjs';
import {
  discoverWorktreeRepository,
  ensureWorktreeMetadata,
} from '../packages/vault/src/worktree-metadata.mjs';

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
        last_prompt_turn_id: 'turn-1',
        last_turn_sequence: 1,
        turn_sequences: { 'turn-1': 1 },
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

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`);
  return result;
}

function linkedWorktreeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'wk-profile-worktree-'));
  const main = join(root, 'main');
  const linked = join(root, 'linked');
  const vault = join(main, '.WendKeep-vault');
  mkdirSync(main, { recursive: true });
  git(main, 'init', '-b', 'main');
  git(main, 'config', 'user.email', 'tests@wendkeep.invalid');
  git(main, 'config', 'user.name', 'WendKeep Tests');
  writeFileSync(join(main, 'tracked.txt'), 'fixture\n');
  git(main, 'add', 'tracked.txt');
  git(main, 'commit', '-m', 'initial');
  bindProjectVault({ projectRoot: main, vaultPath: vault });
  git(main, 'add', '.wendkeep.json');
  git(main, 'commit', '-m', 'bind project');
  git(main, 'worktree', 'add', linked, '-b', 'wk/linked');
  const repository = discoverWorktreeRepository({ startDir: main });
  ensureWorktreeMetadata({
    repository,
    projectId: JSON.parse(readFileSync(join(main, '.wendkeep.json'), 'utf8')).projectId,
    vaultPath: vault,
  });
  return { root, main, linked };
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

test('profile use from a linked worktree persists and reads the canonical project profile', () => {
  const f = linkedWorktreeFixture();
  try {
    const linkedBindingBefore = readFileSync(join(f.linked, '.wendkeep.json'), 'utf8');
    assert.equal(resolveProjectVault({ startDir: f.linked }).source, 'worktree-registry');
    const changed = run(f.linked, 'use', 'OFF', '--json');
    assert.equal(changed.status, 0, changed.stderr);
    assert.equal(
      JSON.parse(readFileSync(join(f.main, '.wendkeep.json'), 'utf8')).harness.profile,
      'OFF',
    );

    const status = run(f.linked, 'status', '--json');
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).profile, 'OFF', status.stderr);
    assert.equal(JSON.parse(status.stdout).source, 'project-binding');
    assert.equal(readFileSync(join(f.linked, '.wendkeep.json'), 'utf8'), linkedBindingBefore);
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

test('[req:OP-3] [req:OP-11] profile route cria lease temporária sem reescrever bases persistentes', () => {
  const f = fixture();
  try {
    assert.equal(run(f.project, 'use', 'OFF').status, 0);
    assert.equal(run(f.project, 'use', 'GOVERN', '--session', 'session-1').status, 0);
    const absentStatus = run(f.project, 'status', '--session', 'session-1');
    assert.equal(absentStatus.status, 0, absentStatus.stderr);
    assert.equal(
      absentStatus.stdout.trim(),
      'GOVERN (session session-1; session-registry; base=GOVERN/session-registry; lease=absent)',
    );
    const configBefore = readFileSync(join(f.project, '.wendkeep.json'), 'utf8');
    const noteBefore = readFileSync(f.sessionPath);

    const routed = run(
      f.project, 'route', 'FLOW', '--session', 'session-1',
      '--reason', 'correção local e reversível', '--json',
    );
    assert.equal(routed.status, 0, routed.stderr);
    const payload = JSON.parse(routed.stdout);
    assert.equal(payload.profile, 'FLOW');
    assert.equal(payload.source, 'task-lease');
    assert.equal(payload.scope, 'task');
    assert.equal(payload.base_profile, 'GOVERN');
    assert.equal(payload.base_source, 'session-registry');
    assert.equal(payload.task_lease.state, 'active');
    assert.equal(payload.task_lease.request_turn_id, 'turn-1');
    assert.equal(payload.task_lease.request_turn_sequence, 1);
    assert.match(payload.task_lease.lease_id, /^[0-9a-f-]{36}$/i);
    assert.equal(payload.task_lease.reason, 'correção local e reversível');
    assert.equal(payload.task_lease.requested_by, 'llm-harness');
    assert.match(payload.task_lease.issued_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(payload.task_lease.expires_on, 'request-stop');

    const registry = JSON.parse(readFileSync(join(f.vault, '.brain', 'SESSION_REGISTRY.json'), 'utf8'));
    assert.equal(registry.sessions['session-1'].operating_profile, 'GOVERN');
    const auditedLease = registry.sessions['session-1'].operating_profile_task;
    assert.equal(auditedLease.profile, 'FLOW');
    assert.equal(auditedLease.reason, 'correção local e reversível');
    assert.equal(auditedLease.requested_by, 'llm-harness');
    assert.match(auditedLease.issued_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(auditedLease.expires_on, 'request-stop');
    assert.equal(readFileSync(join(f.project, '.wendkeep.json'), 'utf8'), configBefore);
    assert.deepEqual(readFileSync(f.sessionPath), noteBefore);

    const status = run(f.project, 'status', '--session', 'session-1', '--json');
    const current = JSON.parse(status.stdout);
    assert.equal(current.profile, 'FLOW');
    assert.equal(current.source, 'task-lease');
    assert.equal(current.scope, 'task');
    const humanStatus = run(f.project, 'status', '--session', 'session-1');
    assert.equal(humanStatus.status, 0, humanStatus.stderr);
    assert.equal(
      humanStatus.stdout.trim(),
      'FLOW (task session-1; task-lease; base=GOVERN/session-registry; lease=active)',
    );
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:OP-3] profile route rejeita sessão sem prompt causal registrado sem mutação parcial', () => {
  const f = fixture();
  try {
    const registryPath = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
    const original = JSON.parse(readFileSync(registryPath, 'utf8'));
    const invalidContexts = [
      { last_prompt_turn_id: '', last_turn_sequence: 1, turn_sequences: { 'turn-1': 1 } },
      { last_prompt_turn_id: 'turn-1', last_turn_sequence: 0, turn_sequences: { 'turn-1': 0 } },
      { last_prompt_turn_id: 'turn-1', last_turn_sequence: 1, turn_sequences: undefined },
      { last_prompt_turn_id: 'turn-1', last_turn_sequence: 1, turn_sequences: {} },
      { last_prompt_turn_id: 'turn-1', last_turn_sequence: 1, turn_sequences: { 'turn-1': 2 } },
    ];

    for (const context of invalidContexts) {
      const registry = structuredClone(original);
      Object.assign(registry.sessions['session-1'], context);
      writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
      const before = readFileSync(registryPath, 'utf8');
      const result = run(
        f.project, 'route', 'FLOW', '--session', 'session-1', '--reason', 'contexto causal incompleto',
      );

      assert.equal(result.status, 2, JSON.stringify(context));
      assert.match(result.stderr, /prompt causal|contexto|Rota temporária exige/i);
      assert.equal(readFileSync(registryPath, 'utf8'), before);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:OP-12] profile status restaura a base quando a sequência causal avança', () => {
  const f = fixture();
  try {
    assert.equal(run(f.project, 'use', 'GUIDE', '--session', 'session-1').status, 0);
    assert.equal(run(
      f.project, 'route', 'FLOW', '--session', 'session-1', '--reason', 'pedido um',
    ).status, 0);
    const path = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
    const registry = JSON.parse(readFileSync(path, 'utf8'));
    Object.assign(registry.sessions['session-1'], {
      last_prompt_turn_id: 'turn-2',
      last_turn_sequence: 2,
      turn_sequences: { 'turn-1': 1, 'turn-2': 2 },
    });
    writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

    const status = run(f.project, 'status', '--session', 'session-1', '--json');
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.profile, 'GUIDE');
    assert.equal(payload.source, 'session-registry');
    assert.equal(payload.scope, 'session');
    assert.equal(payload.base_profile, 'GUIDE');
    assert.equal(payload.task_lease.state, 'expired');
    const humanStatus = run(f.project, 'status', '--session', 'session-1');
    assert.equal(humanStatus.status, 0, humanStatus.stderr);
    assert.equal(
      humanStatus.stdout.trim(),
      'GUIDE (session session-1; session-registry; base=GUIDE/session-registry; lease=expired)',
    );
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('[req:OP-11] profile route rejeita OFF, motivo/sessão ausentes e flags inválidas sem mutar', () => {
  const f = fixture();
  try {
    const registryPath = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
    const before = readFileSync(registryPath, 'utf8');
    for (const args of [
      ['route', 'OFF', '--session', 'session-1', '--reason', 'não pode'],
      ['route', 'FLOW', '--reason', 'sem sessão'],
      ['route', 'FLOW', '--session', 'session-1'],
      ['route', 'FLOW', '--session', 'session-1', '--reason', ''],
      ['route', 'FLOW', '--session', 'session-1', '--reason', 'a', '--reason', 'b'],
    ]) {
      const result = run(f.project, ...args);
      assert.equal(result.status, 2, `${args.join(' ')}\n${result.stderr}`);
      assert.equal(readFileSync(registryPath, 'utf8'), before);
    }
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
    assert.equal(run(f.project, 'use', 'OFF', '--reason', 'somente route').status, 2);
    assert.equal(run(f.project, 'status', '--reason', 'somente route').status, 2);
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
  assert.match(result.stdout, /route <FLOW\|GUIDE\|GOVERN\|ASSURE>.*--reason <text>/s);
  assert.match(result.stdout, /task|request/i);
  assert.match(result.stdout, /Keep Core.*remains active/i);
});
