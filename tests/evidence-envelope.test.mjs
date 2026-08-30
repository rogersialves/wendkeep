import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalSha256,
  buildEvidenceEnvelope,
  captureGitSnapshot,
  digestWorktreeEntries,
  evaluateEvidenceBinding,
  evidenceSensors,
  resolveEvidenceIdentity,
  sensorConfigSha256,
} from '../src/evidence-envelope.mjs';
import { buildHostCoverage } from '../src/host-capabilities.mjs';
import { runSensors } from '../hooks/sensors-core.mjs';
import { checkHarness } from '../hooks/harness-doctor.mjs';
import { writeVaultFileAtomic } from '../packages/vault/src/vault-path-safety.mjs';
import { createChangeAuthorityWriter } from '../src/verify.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepository() {
  const root = mkdtempSync(join(tmpdir(), 'wk-evidence-git-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'evidence@example.test']);
  git(root, ['config', 'user.name', 'Evidence Test']);
  git(root, ['checkout', '-b', 'main']);
  writeFileSync(join(root, 'alpha.txt'), 'alpha\n');
  writeFileSync(join(root, 'beta.txt'), 'beta\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'baseline']);
  return root;
}

test('[req:EVID-6] canonical SHA-256 is complete, prefixed and independent of object key order', () => {
  const left = canonicalSha256({ z: 2, a: { y: true, x: 'value' } });
  const right = canonicalSha256({ a: { x: 'value', y: true }, z: 2 });

  assert.equal(left, right);
  assert.match(left, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(left, canonicalSha256({ a: { x: 'changed', y: true }, z: 2 }));
});

test('[req:EVID-2] Git snapshot binds HEAD, index and staged, unstaged, untracked states independently', () => {
  const root = makeRepository();
  try {
    const clean = captureGitSnapshot(root);
    assert.equal(clean.dirty, false);
    assert.equal(clean.head_sha, git(root, ['rev-parse', 'HEAD']));
    assert.equal(clean.base_sha, clean.head_sha);
    assert.equal(clean.index_tree_sha, git(root, ['write-tree']));
    assert.match(clean.worktree_digest, /^sha256:[a-f0-9]{64}$/);

    writeFileSync(join(root, 'alpha.txt'), 'alpha staged\n');
    git(root, ['add', 'alpha.txt']);
    const staged = captureGitSnapshot(root);
    assert.equal(staged.dirty, true);
    assert.notEqual(staged.index_tree_sha, clean.index_tree_sha);
    assert.notEqual(staged.worktree_digest, clean.worktree_digest);

    writeFileSync(join(root, 'alpha.txt'), 'alpha unstaged\n');
    const unstaged = captureGitSnapshot(root);
    assert.equal(unstaged.index_tree_sha, staged.index_tree_sha);
    assert.notEqual(unstaged.worktree_digest, staged.worktree_digest);

    writeFileSync(join(root, 'untracked.txt'), 'new\n');
    const untracked = captureGitSnapshot(root);
    assert.equal(untracked.index_tree_sha, unstaged.index_tree_sha);
    assert.notEqual(untracked.worktree_digest, unstaged.worktree_digest);

    writeFileSync(join(root, 'hash#percent%.txt'), 'reserved URL characters\n');
    const specialPath = captureGitSnapshot(root);
    assert.notEqual(specialPath.worktree_digest, untracked.worktree_digest);
    writeFileSync(join(root, 'hash#percent%.txt'), 'changed reserved URL characters\n');
    assert.notEqual(captureGitSnapshot(root).worktree_digest, specialPath.worktree_digest);

    writeFileSync(join(root, 'asset.bin'), 'A\r\nB');
    const binaryCrlf = captureGitSnapshot(root);
    writeFileSync(join(root, 'asset.bin'), 'A\nB');
    assert.notEqual(captureGitSnapshot(root).worktree_digest, binaryCrlf.worktree_digest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:EVID-2] worktree digest normalizes text line endings and preserves binary bytes', () => {
  const lf = digestWorktreeEntries([
    { layer: 'worktree', status: 'M', path: 'docs/a.txt', content: Buffer.from('a\nb\n') },
  ]);
  const crlf = digestWorktreeEntries([
    { layer: 'worktree', status: 'M', path: 'docs\\a.txt', content: Buffer.from('a\r\nb\r\n') },
  ]);
  const binaryA = digestWorktreeEntries([
    { layer: 'untracked', status: '?', path: 'asset.bin', content: Buffer.from([0, 13, 10, 1]) },
  ]);
  const binaryB = digestWorktreeEntries([
    { layer: 'untracked', status: '?', path: 'asset.bin', content: Buffer.from([0, 10, 1]) },
  ]);
  const declaredBinaryCrlf = digestWorktreeEntries([
    { layer: 'untracked', status: '?', path: 'asset.bin', binary: true, content: Buffer.from('A\r\nB') },
  ]);
  const declaredBinaryLf = digestWorktreeEntries([
    { layer: 'untracked', status: '?', path: 'asset.bin', binary: true, content: Buffer.from('A\nB') },
  ]);

  assert.equal(lf, crlf);
  assert.notEqual(binaryA, binaryB);
  assert.notEqual(declaredBinaryCrlf, declaredBinaryLf);
});

test('[req:EVID-2] real rename and delete snapshots are deterministic without creating a commit', () => {
  const root = makeRepository();
  try {
    const head = git(root, ['rev-parse', 'HEAD']);
    git(root, ['mv', 'alpha.txt', 'renamed.txt']);
    rmSync(join(root, 'beta.txt'));
    writeFileSync(join(root, 'renamed.txt'), 'alpha\r\nrenamed\r\n');

    const first = captureGitSnapshot(root);
    const second = captureGitSnapshot(root);
    assert.deepEqual(second, first);
    assert.equal(first.head_sha, head);

    writeFileSync(join(root, 'renamed.txt'), 'alpha\nrenamed\n');
    const normalized = captureGitSnapshot(root);
    assert.equal(normalized.worktree_digest, first.worktree_digest);
    assert.equal(git(root, ['rev-list', '--count', 'HEAD']), '1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:EVID-3] selected sensor configuration is canonical and command-sensitive', () => {
  const sensors = [
    { id: 'b', severity: 'warning', command: 'node b.mjs' },
    { id: 'a', severity: 'critical', command: 'node a.mjs' },
  ];
  const forward = sensorConfigSha256(sensors, ['a', 'b']);
  const reverse = sensorConfigSha256([...sensors].reverse(), ['b', 'a']);

  assert.equal(forward, reverse);
  assert.match(forward, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(
    forward,
    sensorConfigSha256([{ ...sensors[0] }, { ...sensors[1], command: 'node changed.mjs' }], ['a', 'b']),
  );
});

test('[req:EVID-3] each sensor records its command, execution period, exit code and sanitized output digest', () => {
  const instants = [
    '2026-08-22T20:00:00.000Z',
    '2026-08-22T20:00:00.125Z',
  ];
  const [entry] = runSensors(
    [{ id: 'proof', severity: 'critical', command: 'node proof.mjs' }],
    ['proof'],
    {
      cwd: 'C:/repo',
      now: () => instants.shift(),
      spawn: () => ({ status: 0, signal: null, stdout: `${'x'.repeat(3000)} ghp_abcdefghijklmnop\n`, stderr: '' }),
    },
  );

  assert.deepEqual(
    {
      id: entry.id,
      status: entry.status,
      command: entry.command,
      exit_code: entry.exit_code,
      started_at: entry.started_at,
      finished_at: entry.finished_at,
      duration_ms: entry.duration_ms,
    },
    {
      id: 'proof',
      status: 'green',
      command: 'node proof.mjs',
      exit_code: 0,
      started_at: '2026-08-22T20:00:00.000Z',
      finished_at: '2026-08-22T20:00:00.125Z',
      duration_ms: 125,
    },
  );
  assert.match(entry.command_sha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(entry.output_sha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(entry.output_tail, /\[REDACTED_SECRET\]/);
  assert.doesNotMatch(entry.output_tail, /ghp_/);
  assert.ok(entry.output_tail.length <= 2000, `tail length ${entry.output_tail.length}`);
});

test('[req:EVID-1] [req:EVID-3] verify publishes the complete v2 envelope and changes with sensor config', () => {
  const root = makeRepository();
  const vault = join(root, '.vault');
  const changeDir = join(vault, '08-Mudanças', 'x');
  try {
    writeFileSync(join(root, '.git', 'info', 'exclude'), '.vault/\n');
    mkdirSync(join(vault, '.brain'), { recursive: true });
    mkdirSync(changeDir, { recursive: true });
    writeFileSync(join(vault, '.brain', 'PROJECT.json'), `${JSON.stringify({ projectId: 'project-evidence' })}\n`);
    writeFileSync(join(changeDir, 'proposta.md'), '---\nspec_impact: none\nspec_impact_reason: sensor-only fixture\nspecs: []\n---\n');
    writeFileSync(join(changeDir, 'tarefas.md'), '- [x] 1.1 prove [sensor:proof]\n');
    writeFileSync(join(root, 'wendkeep.sensors.json'), JSON.stringify({
      version: 1,
      sensors: [{ id: 'proof', severity: 'critical', command: 'node -e "process.stdout.write(\'green\')"' }],
    }));

    const run = () => execFileSync(process.execPath, [
      BIN, 'verify', '--vault', vault, '--project', root, '--change', 'x', '--session', 'session-evidence',
    ], { cwd: root, encoding: 'utf8' });
    run();
    const first = JSON.parse(readFileSync(join(changeDir, 'evidencia.json'), 'utf8'));

    assert.equal(first.schema_version, 2);
    assert.equal(first.project_id, 'project-evidence');
    assert.equal(first.work_session_id, 'session-evidence');
    assert.equal(first.change_slug, 'x');
    assert.equal(first.branch, 'main');
    assert.equal(first.head_sha, git(root, ['rev-parse', 'HEAD']));
    assert.equal(first.dirty, true, 'sensor config and local vault are untracked relevant state');
    for (const key of [
      'repository_id', 'worktree_id', 'base_sha', 'index_tree_sha', 'worktree_digest',
      'tasks_sha256', 'effective_spec_sha256', 'sensor_config_sha256', 'wendkeep_version',
      'platform', 'started_at', 'finished_at', 'envelope_id',
    ]) assert.ok(first[key], `${key} is present`);
    assert.equal(
      first.wendkeep_version,
      JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
    );
    assert.deepEqual(first.sensors.map((sensor) => sensor.id), ['proof']);

    writeFileSync(join(root, 'wendkeep.sensors.json'), JSON.stringify({
      version: 1,
      sensors: [{ id: 'proof', severity: 'critical', command: 'node -e "process.stdout.write(\'changed\')"' }],
    }));
    const configStaleStatus = spawnSync(process.execPath, [
      BIN, 'change', 'status', 'x', '--vault', vault, '--project', root, '--session', 'session-evidence',
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(configStaleStatus.status, 0, configStaleStatus.stderr);
    assert.match(configStaleStatus.stdout, /evidence-binding: stale .*sensor_config_sha256 changed/);
    assert.match(
      checkHarness(vault, root).attention.join('\n'),
      /x: evidence stale .*sensor_config_sha256 changed.*wendkeep verify/is,
    );

    run();
    const second = JSON.parse(readFileSync(join(changeDir, 'evidencia.json'), 'utf8'));
    assert.notEqual(second.sensor_config_sha256, first.sensor_config_sha256);
    assert.notEqual(second.sensors[0].command_sha256, first.sensors[0].command_sha256);

    const boundStatus = spawnSync(process.execPath, [
      BIN, 'change', 'status', 'x', '--vault', vault, '--project', root, '--session', 'session-evidence',
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(boundStatus.status, 0, boundStatus.stderr);
    assert.match(boundStatus.stdout, /evidence-binding: bound/);

    writeFileSync(join(root, 'beta.txt'), 'changed after verify\n');
    const staleStatus = spawnSync(process.execPath, [
      BIN, 'change', 'status', 'x', '--vault', vault, '--project', root, '--session', 'session-evidence',
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(staleStatus.status, 0, staleStatus.stderr);
    assert.match(staleStatus.stdout, /evidence-binding: stale .*worktree_digest changed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:EVID-4] verify refuses to replace prior evidence when a sensor changes HEAD', () => {
  const root = makeRepository();
  const vault = join(root, '.vault');
  const changeDir = join(vault, '08-Mudanças', 'x');
  try {
    writeFileSync(join(root, '.git', 'info', 'exclude'), '.vault/\n');
    mkdirSync(join(vault, '.brain'), { recursive: true });
    mkdirSync(changeDir, { recursive: true });
    writeFileSync(join(vault, '.brain', 'PROJECT.json'), `${JSON.stringify({ projectId: 'project-evidence' })}\n`);
    writeFileSync(join(changeDir, 'tarefas.md'), '- [x] 1.1 prove [sensor:proof]\n');
    writeFileSync(join(root, 'wendkeep.sensors.json'), JSON.stringify({
      version: 1,
      sensors: [{ id: 'proof', severity: 'critical', command: 'node -e "process.exit(0)"' }],
    }));
    const args = [BIN, 'verify', '--vault', vault, '--project', root, '--change', 'x', '--session', 'session-evidence'];
    execFileSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
    const before = readFileSync(join(changeDir, 'evidencia.json'), 'utf8');

    writeFileSync(join(root, 'wendkeep.sensors.json'), JSON.stringify({
      version: 1,
      sensors: [{
        id: 'proof',
        severity: 'critical',
        command: 'git -c user.email=evidence@example.test -c user.name=Evidence commit --allow-empty -m moved-head',
      }],
    }));
    const changed = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });

    assert.equal(changed.status, 2);
    assert.match(changed.stderr, /WENDKEEP_EVIDENCE_HEAD_CHANGED/);
    assert.equal(readFileSync(join(changeDir, 'evidencia.json'), 'utf8'), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:EVID-5] authority write is path-safe and a pre-rename fault preserves the prior JSON', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-evidence-atomic-'));
  const changeDir = join(vault, '08-Mudanças', 'x');
  const target = join(changeDir, 'evidencia.json');
  try {
    mkdirSync(changeDir, { recursive: true });
    writeVaultFileAtomic(vault, target, '{"generation":1}\n');

    assert.throws(
      () => writeVaultFileAtomic(vault, target, '{"generation":2}\n', 'utf8', {
        scopeRoot: changeDir,
        beforeRename: () => { throw Object.assign(new Error('fault-before-rename'), { code: 'FAULT' }); },
      }),
      (error) => error?.code === 'FAULT',
    );
    assert.equal(readFileSync(target, 'utf8'), '{"generation":1}\n');
    assert.deepEqual(readdirSync(changeDir), ['evidencia.json']);

    assert.throws(
      () => writeVaultFileAtomic(vault, join(changeDir, '..', '..', 'escaped.json'), '{}\n', 'utf8', {
        scopeRoot: changeDir,
      }),
      (error) => error?.code === 'VAULT_PATH_UNSAFE',
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:EVID-5] every verify authority artifact shares the atomic scoped writer', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-evidence-authority-'));
  const changeDir = join(vault, '08-Mudanças', 'x');
  mkdirSync(changeDir, { recursive: true });
  try {
    const write = createChangeAuthorityWriter(vault, changeDir);
    const files = ['evidencia.json', 'verificacao.json', 'verdict.json', '.evidence-hash', '.mutation-round'];
    for (const file of files) write(file, 'generation-1\n');

    const faulting = createChangeAuthorityWriter(vault, changeDir, {
      beforeRename: ({ file }) => {
        const error = new Error(`fault:${file}`);
        error.code = 'FAULT';
        throw error;
      },
    });
    for (const file of files) {
      assert.throws(() => faulting(file, 'generation-2\n'), (error) => error?.code === 'FAULT');
      assert.equal(readFileSync(join(changeDir, file), 'utf8'), 'generation-1\n', file);
    }
    assert.deepEqual(readdirSync(changeDir).sort(), files.sort());
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:EVID-7] v1 remains readable only as legacy-unbound', () => {
  const legacy = [{ id: 'tests', status: 'green', severity: 'critical' }];
  assert.deepEqual(evidenceSensors(legacy), legacy);
  assert.deepEqual(evaluateEvidenceBinding(legacy, {}), {
    state: 'legacy-unbound',
    reasons: ['evidence schema v1 has no checkout binding'],
  });
});

test('[req:EVID-6] [req:EVID-7] v2 distinguishes bound, stale and causal context mismatch', () => {
  const identity = {
    project_id: 'project-a', repository_id: 'repo-a', worktree_id: 'worktree-a', work_session_id: 'session-a',
  };
  const snapshot = {
    branch: 'main', base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), index_tree_sha: 'c'.repeat(40),
    worktree_digest: `sha256:${'d'.repeat(64)}`, dirty: true,
  };
  const expected = {
    change_slug: 'x',
    identity,
    snapshot,
    tasks_sha256: `sha256:${'1'.repeat(64)}`,
    effective_spec_sha256: `sha256:${'2'.repeat(64)}`,
    sensor_config_sha256: `sha256:${'3'.repeat(64)}`,
  };
  const envelope = buildEvidenceEnvelope({
    identity,
    changeSlug: 'x',
    snapshot,
    tasksSha256: expected.tasks_sha256,
    effectiveSpecSha256: expected.effective_spec_sha256,
    sensorConfigSha256: expected.sensor_config_sha256,
    sensors: [],
    startedAt: '2026-08-22T20:00:00.000Z',
    finishedAt: '2026-08-22T20:00:01.000Z',
    version: '0.78.0',
    runtimePlatform: 'test-x64',
    hostCoverage: buildHostCoverage({ hostId: 'codex', observedAt: '2026-08-25T12:00:00.000Z' }),
  });

  assert.equal(envelope.host_coverage.host_id, 'codex');
  assert.equal(envelope.host_coverage.degraded, true);

  assert.deepEqual(evaluateEvidenceBinding(envelope, expected), { state: 'bound', reasons: [] });
  assert.deepEqual(
    evaluateEvidenceBinding(envelope, { ...expected, snapshot: { ...snapshot, worktree_digest: `sha256:${'e'.repeat(64)}` } }),
    { state: 'stale', reasons: ['worktree_digest changed'] },
  );
  assert.deepEqual(
    evaluateEvidenceBinding(envelope, { ...expected, identity: { ...identity, worktree_id: 'worktree-b' } }),
    { state: 'context-mismatch', reasons: ['worktree_id mismatch'] },
  );
  for (const field of ['project_id', 'repository_id', 'work_session_id']) {
    const assessed = evaluateEvidenceBinding(envelope, {
      ...expected,
      identity: { ...identity, [field]: `foreign-${field}` },
    });
    assert.deepEqual(assessed, { state: 'context-mismatch', reasons: [`${field} mismatch`] }, field);
  }
  assert.deepEqual(
    evaluateEvidenceBinding(envelope, { ...expected, change_slug: 'foreign-change' }),
    { state: 'context-mismatch', reasons: ['change_slug mismatch'] },
  );
  for (const [field, value] of [
    ['head_sha', 'f'.repeat(40)],
    ['index_tree_sha', 'e'.repeat(40)],
    ['worktree_digest', `sha256:${'a'.repeat(64)}`],
  ]) {
    const assessed = evaluateEvidenceBinding(envelope, {
      ...expected,
      snapshot: { ...snapshot, [field]: value },
    });
    assert.equal(assessed.state, 'stale', field);
    assert.ok(assessed.reasons.includes(`${field} changed`), field);
  }
  for (const field of ['tasks_sha256', 'effective_spec_sha256', 'sensor_config_sha256']) {
    const assessed = evaluateEvidenceBinding(envelope, {
      ...expected,
      [field]: `sha256:${'f'.repeat(64)}`,
    });
    assert.equal(assessed.state, 'stale', field);
    assert.ok(assessed.reasons.includes(`${field} changed`), field);
  }
});

test('[req:EVID-6] linked worktrees share repository identity but cannot share evidence authority', () => {
  const container = mkdtempSync(join(tmpdir(), 'wk-evidence-worktrees-'));
  const main = join(container, 'main');
  const linked = join(container, 'linked');
  const vault = join(container, 'vault');
  try {
    mkdirSync(main);
    git(main, ['init']);
    git(main, ['config', 'user.email', 'evidence@example.test']);
    git(main, ['config', 'user.name', 'Evidence Test']);
    git(main, ['checkout', '-b', 'main']);
    writeFileSync(join(main, 'tracked.txt'), 'tracked\n');
    git(main, ['add', '.']);
    git(main, ['commit', '-m', 'baseline']);
    git(main, ['worktree', 'add', '-b', 'feature', linked]);
    mkdirSync(join(vault, '.brain'), { recursive: true });
    writeFileSync(join(vault, '.brain', 'PROJECT.json'), `${JSON.stringify({ projectId: 'project-worktrees' })}\n`);

    const mainIdentity = resolveEvidenceIdentity({
      vaultBase: vault, projectRoot: main, changeSlug: 'x', sessionId: 'session-main',
    });
    const linkedIdentity = resolveEvidenceIdentity({
      vaultBase: vault, projectRoot: linked, changeSlug: 'x', sessionId: 'session-linked',
    });

    assert.equal(linkedIdentity.repository_id, mainIdentity.repository_id);
    assert.notEqual(linkedIdentity.worktree_id, mainIdentity.worktree_id);
    const envelope = buildEvidenceEnvelope({
      identity: mainIdentity,
      changeSlug: 'x',
      snapshot: captureGitSnapshot(main),
      tasksSha256: canonicalSha256('tasks'),
      effectiveSpecSha256: canonicalSha256('spec'),
      sensorConfigSha256: canonicalSha256('sensors'),
      sensors: [],
      startedAt: '2026-08-22T20:00:00.000Z',
      finishedAt: '2026-08-22T20:00:01.000Z',
    });
    const assessed = evaluateEvidenceBinding(envelope, {
      identity: linkedIdentity,
      snapshot: captureGitSnapshot(linked),
      tasks_sha256: envelope.tasks_sha256,
      effective_spec_sha256: envelope.effective_spec_sha256,
      sensor_config_sha256: envelope.sensor_config_sha256,
    });
    assert.equal(assessed.state, 'context-mismatch');
    assert.ok(assessed.reasons.includes('worktree_id mismatch'));
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

test('[req:EVID-8] public schema requires every v2 binding and per-sensor provenance field', () => {
  const schema = JSON.parse(readFileSync(join(
    dirname(fileURLToPath(import.meta.url)), '..', 'schema', 'wendkeep.evidence-envelope-v2.schema.json',
  ), 'utf8'));
  for (const field of [
    'project_id', 'repository_id', 'worktree_id', 'work_session_id', 'change_slug', 'branch',
    'base_sha', 'head_sha', 'index_tree_sha', 'worktree_digest', 'dirty', 'tasks_sha256',
    'effective_spec_sha256', 'sensor_config_sha256', 'started_at', 'finished_at', 'sensors',
  ]) assert.ok(schema.required.includes(field), `${field} is required`);
  for (const field of [
    'command', 'command_sha256', 'started_at', 'finished_at', 'duration_ms', 'exit_code',
    'output_sha256', 'output_tail',
  ]) assert.ok(schema.$defs.sensor.required.includes(field), `sensor.${field} is required`);
});
