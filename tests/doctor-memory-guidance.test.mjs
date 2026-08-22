import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { reduceMemoryEvents } from '../hooks/memory-store.mjs';
import { renderSharedMemory } from '../hooks/memory-schema.mjs';
import { runVaultHealth } from '../hooks/vault-health.mjs';
import { renderVaultHealthLines } from '../src/doctor.mjs';
import { renderCoreSkeleton } from '../src/validate-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'wendkeep.mjs');
const HEALTH_HOOK = join(ROOT, 'hooks', 'vault-health.mjs');
const PROJECT_ID = 'doctor-guidance-project';

function memoryEvent() {
  return {
    v: 1,
    project_id: PROJECT_ID,
    event_id: 'mem-doctor-guidance',
    memory_key: 'handoff.latest',
    operation: 'assert',
    value: 'safe-current-value',
    authority: 'verified',
    canonical_session_id: 'doctor-guidance-session',
    activation_id: 'doctor-guidance-activation',
    activation_epoch: 1,
    turn_sequence: 1,
    source_turn_id: 'doctor-guidance-turn',
    observed_at: '2026-08-02T12:00:00.000Z',
    evidence: ['tests/doctor-memory-guidance.test.mjs'],
  };
}

function fixture() {
  const project = mkdtempSync(join(tmpdir(), 'wk-doctor-guidance-'));
  const vault = join(project, '.doctor-guidance-vault');
  const brain = join(vault, '.brain');
  mkdirSync(brain, { recursive: true });
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'doctor-guidance' }));
  writeFileSync(join(project, '.wendkeep.json'), JSON.stringify({ vault: '.doctor-guidance-vault' }));
  writeFileSync(join(brain, 'PROJECT.json'), `${JSON.stringify({ schemaVersion: 1, projectId: PROJECT_ID })}\n`);
  writeFileSync(join(brain, 'CORE.md'), renderCoreSkeleton());
  writeFileSync(join(brain, 'SESSION_REGISTRY.json'), `${JSON.stringify({ version: 2, sessions: {} })}\n`);

  const event = memoryEvent();
  const reduced = reduceMemoryEvents([event]);
  writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), `${JSON.stringify(event)}\n`);
  writeFileSync(join(brain, 'SHARED_MEMORY.md'), renderSharedMemory({
    revision: reduced.revision,
    eventCursor: reduced.eventCursor,
    stateHash: reduced.stateHash,
    events: reduced.activeEvents,
    updatedAt: '2026-08-02T12:00:00.000Z',
    reviewAfter: '2026-08-09T12:00:00.000Z',
  }));
  writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), [
    {
      candidate_id: 'private-candidate-a', reason: 'conflict', status: 'active',
      memory_key: 'handoff.latest', values: ['private-value-a', 'private-value-b'],
      events: [{ event_id: 'private-event-a', value: 'private-full-event-a' }],
    },
    {
      candidate_id: 'private-candidate-b', reason: 'conflict', status: 'active',
      memory_key: 'handoff.latest', values: ['private-value-c', 'private-value-d'],
      events: [{ event_id: 'private-event-b', value: 'private-full-event-b' }],
    },
    {
      candidate_id: 'private-candidate-c', reason: 'conflict', status: 'active',
      memory_key: 'quality.latest-sensors', values: ['private-value-e', 'private-value-f'],
      events: [{ event_id: 'private-event-c', value: 'private-full-event-c' }],
    },
  ].map((item) => JSON.stringify(item)).join('\n') + '\n');
  return { project, vault };
}

function byteSnapshot(root) {
  const entries = [];
  const walk = (dir, rel = '') => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const itemRel = rel ? `${rel}/${name}` : name;
      if (statSync(path).isDirectory()) walk(path, itemRel);
      else entries.push([itemRel, readFileSync(path, 'utf8')]);
    }
  };
  walk(root);
  return entries;
}

function createAlias(t, source, target, type = 'hardlink') {
  try {
    if (type === 'hardlink') linkSync(source, target);
    else symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
      t.skip(`${type}s unavailable on this filesystem: ${error.code}`);
      return false;
    }
    throw error;
  }
}

function assertExceptionalHealthSurfaces({ project, vault }) {
  const before = byteSnapshot(project);
  const expectedCommand = `npx --no-install wendkeep memory status --gate --vault "${vault}"`;
  const direct = spawnSync(process.execPath, [HEALTH_HOOK, '--vault', vault], {
    cwd: project,
    encoding: 'utf8',
  });
  assert.equal(direct.status, 1, direct.stderr || direct.stdout);
  assert.equal(direct.stderr, '', 'standalone hook must not replace JSON with stderr/stack traces');
  const json = JSON.parse(direct.stdout);
  const inProcess = runVaultHealth({ vaultBase: vault });
  assert.deepEqual(json, inProcess, 'standalone JSON and in-process exceptional health are identical');
  assert.equal(json.ok, false);
  assert.equal(json.memoryStatus, 'blocked');
  const memoryFailures = json.failures.filter((failure) => failure.startsWith('Memória:'));
  assert.ok(memoryFailures.length > 0, 'exception is classified as a memory failure');
  assert.ok(memoryFailures.some((failure) => failure.includes(expectedCommand)));
  assert.ok(memoryFailures.every((failure) => (
    /npx --no-install wendkeep memory (?:status --gate|migrate --apply|repair|curate) --vault /.test(failure)
      && failure.includes(`--vault "${vault}"`)
  )), 'every memory failure includes a safe command with the resolved Vault');

  const doctor = spawnSync(process.execPath, [BIN, 'doctor', '--project', project, '--vault', vault], {
    cwd: project,
    encoding: 'utf8',
  });
  assert.equal(doctor.status, 1, doctor.stderr || doctor.stdout);
  assert.match(doctor.stdout, /\[memória\] bloqueada/i);
  assert.ok(doctor.stdout.includes(expectedCommand));
  assert.doesNotMatch(doctor.stdout, /bundle de memória íntegro/i);
  assert.doesNotMatch(doctor.stdout, /"failures"|"warnings"|"metrics"|"memoryStatus"/);
  assert.deepEqual(byteSnapshot(project), before, 'exceptional diagnostics remain byte-for-byte read-only');
}

test('[req:DIAG-8] [req:DIAG-11] missing Vault keeps doctor human and hook JSON actionable', () => {
  const project = mkdtempSync(join(tmpdir(), 'wk-doctor-missing-vault-'));
  const vault = join(project, '.missing-vault');
  try {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'doctor-missing-vault' }));
    assertExceptionalHealthSurfaces({ project, vault });
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('[req:DIAG-8] [req:DIAG-11] unsafe .brain junction keeps doctor human and hook JSON actionable', (t) => {
  const source = fixture();
  const project = mkdtempSync(join(tmpdir(), 'wk-doctor-junction-'));
  const vault = join(project, '.junction-vault');
  try {
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'doctor-junction' }));
    if (!createAlias(t, join(source.vault, '.brain'), join(vault, '.brain'), 'junction')) return;
    assertExceptionalHealthSurfaces({ project, vault });
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(source.project, { recursive: true, force: true });
  }
});

test('[req:DIAG-8] [req:DIAG-11] unsafe registry hardlink keeps doctor human and hook JSON actionable', (t) => {
  const { project, vault } = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-doctor-registry-outside-'));
  try {
    const source = join(outside, 'SESSION_REGISTRY.json');
    const target = join(vault, '.brain', 'SESSION_REGISTRY.json');
    writeFileSync(source, '{"private":"registry-content"}\n');
    rmSync(target);
    if (!createAlias(t, source, target)) return;
    assertExceptionalHealthSurfaces({ project, vault });
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:DIAG-8] [req:DIAG-11] doctor renders grouped memory conflicts humanly and remains read-only', () => {
  const { project, vault } = fixture();
  try {
    const before = byteSnapshot(project);
    const result = spawnSync(process.execPath, [BIN, 'doctor', '--project', project, '--vault', vault], {
      cwd: project,
      encoding: 'utf8',
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stdout, /\[integridade\]/i);
    assert.match(result.stdout, /\[memória\]/i);
    assert.match(result.stdout, /próximo handoff:\s*2/i);
    assert.match(result.stdout, /sensores de qualidade:\s*1/i);
    assert.ok(result.stdout.includes(`npx --no-install wendkeep memory curate --vault "${vault}"`));
    assert.doesNotMatch(result.stdout, /"failures"|"warnings"|"metrics"|"memoryStatus"/);
    assert.doesNotMatch(result.stdout, /private-candidate|private-event|private-value|private-full-event/);
    assert.deepEqual(byteSnapshot(project), before, 'doctor must remain byte-for-byte read-only');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('[req:DIAG-11] direct vault-health hook preserves structured JSON', () => {
  const { project, vault } = fixture();
  try {
    const before = byteSnapshot(project);
    const result = spawnSync(process.execPath, [HEALTH_HOOK, '--vault', vault], {
      cwd: project,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(Array.isArray(payload.failures));
    assert.ok(Array.isArray(payload.warnings));
    assert.equal(payload.metrics.memory.activeConflicts, 3);
    assert.deepEqual(byteSnapshot(project), before, 'standalone JSON hook must remain byte-for-byte read-only');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('[req:MEM-HANDOFF-4] doctor separates terminal handoff debt from actionable conflicts in one snapshot', () => {
  const { project, vault } = fixture();
  const brain = join(vault, '.brain');
  try {
    writeFileSync(join(brain, 'SESSION_REGISTRY.json'), `${JSON.stringify({
      version: 2,
      sessions: {
        'session-a': { status: 'done', change_slug: 'change-a' },
        'session-b': { status: 'superseded', change_slug: 'change-b' },
      },
    })}\n`);
    writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), [
      {
        candidate_id: 'historical-a', reason: 'conflict', status: 'active',
        memory_key: 'handoff.latest', event_ids: ['event-a', 'event-b'],
        events: [
          { event_id: 'event-a', value: 'old A', canonical_session_id: 'session-a' },
          { event_id: 'event-b', value: 'old B', canonical_session_id: 'session-b' },
        ],
      },
    ].map(JSON.stringify).join('\n') + '\n');

    const result = runVaultHealth({ vaultBase: vault });
    assert.equal(result.memoryStatus, 'warning');
    assert.equal(result.metrics.memory.activeConflicts, 0);
    assert.equal(result.metrics.memory.repairableHandoffs, 1);
    const warning = result.warnings.find((item) => /handoff/i.test(item));
    assert.match(warning, /histórico.*reparável/i);
    const dryRun = `npx --no-install wendkeep memory rescope --vault "${vault}"`;
    const apply = `npx --no-install wendkeep memory rescope --apply --vault "${vault}"`;
    const curate = `npx --no-install wendkeep memory curate --all --vault "${vault}"`;
    assert.ok(warning.includes(dryRun));
    assert.ok(warning.includes(apply));
    assert.ok(warning.includes(curate));
    assert.ok(warning.indexOf(dryRun) < warning.indexOf(apply));
    assert.ok(warning.indexOf(apply) < warning.indexOf(curate));

    const rendered = renderVaultHealthLines(result).join('\n');
    assert.match(rendered, /conflitos: 0/);
    assert.match(rendered, /handoffs reparáveis: 1/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('[req:MEM-BOUND-3] doctor repairs structural memory before suggesting rescope apply', () => {
  const { project, vault } = fixture();
  const brain = join(vault, '.brain');
  try {
    writeFileSync(join(brain, 'SESSION_REGISTRY.json'), `${JSON.stringify({
      version: 2,
      sessions: {
        'session-a': { status: 'done', change_slug: 'change-a' },
        'session-b': { status: 'superseded', change_slug: 'change-b' },
      },
    })}\n`);
    writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), `${JSON.stringify({
      candidate_id: 'historical-blocked', reason: 'conflict', status: 'active',
      memory_key: 'handoff.latest', event_ids: ['event-a', 'event-b'],
      events: [
        { event_id: 'event-a', value: 'old A', canonical_session_id: 'session-a' },
        { event_id: 'event-b', value: 'old B', canonical_session_id: 'session-b' },
      ],
    })}\n`);
    const sharedPath = join(brain, 'SHARED_MEMORY.md');
    writeFileSync(sharedPath, `${readFileSync(sharedPath, 'utf8')}${'oversized\n'.repeat(50)}`);

    const result = runVaultHealth({ vaultBase: vault });
    assert.equal(result.memoryStatus, 'blocked');
    assert.equal(result.metrics.memory.repairableHandoffs, 1);
    const warning = result.warnings.find((item) => /handoff/i.test(item));
    assert.ok(warning.includes(`npx --no-install wendkeep memory repair --vault "${vault}"`));
    assert.ok(warning.includes(`npx --no-install wendkeep memory status --gate --vault "${vault}"`));
    assert.doesNotMatch(warning, /memory rescope --apply/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('[req:DIAG-8] human renderer explicitly names healthy integrity and memory', () => {
  const human = renderVaultHealthLines({
    ok: true,
    session: 'healthy-session.md',
    failures: [],
    warnings: [],
    metrics: {
      registrySessions: 1,
      derivedNotes: 0,
      memory: {
        schemaVersion: 2,
        revision: 7,
        eventCursor: 'mem-safe',
        stateHash: 'hash-safe',
        ledgerEvents: 7,
        pendingOutbox: 0,
        candidates: 0,
        activeConflicts: 0,
      },
    },
    memoryStatus: 'healthy',
  }).join('\n');
  assert.match(human, /\[integridade\] saudável/i);
  assert.match(human, /\[memória\] saudável/i);
  assert.match(human, /sessão e artefatos íntegros/i);
  assert.match(human, /bundle de memória íntegro/i);
});

test('[req:DIAG-11] human renderer and JSON hook agree on ok, failures, warnings and metrics', () => {
  const { project, vault } = fixture();
  try {
    const direct = spawnSync(process.execPath, [HEALTH_HOOK, '--vault', vault], {
      cwd: project,
      encoding: 'utf8',
    });
    assert.equal(direct.status, 1, direct.stderr || direct.stdout);
    const json = JSON.parse(direct.stdout);
    const inProcess = runVaultHealth({ vaultBase: vault });
    assert.deepEqual(json, inProcess, 'standalone JSON and in-process health are identical');

    const human = renderVaultHealthLines(inProcess).join('\n');
    assert.equal(inProcess.ok, inProcess.failures.length === 0);
    for (const failure of inProcess.failures) {
      assert.ok(human.includes(failure.replace(/^Memória:\s*/, '')), `missing failure: ${failure}`);
    }
    for (const warning of inProcess.warnings) {
      assert.ok(human.includes(warning.replace(/^Memória:\s*/, '')), `missing warning: ${warning}`);
    }
    const integrityFailures = inProcess.failures.filter((item) => !item.startsWith('Memória:')).length;
    const integrityWarnings = inProcess.warnings.filter((item) => !item.startsWith('Memória:')).length;
    assert.match(human, new RegExp(`\\[integridade\\].*${integrityFailures} falha\\(s\\), ${integrityWarnings} aviso\\(s\\)`));
    for (const value of [
      inProcess.metrics.registrySessions,
      inProcess.metrics.derivedNotes,
      inProcess.metrics.memory.schemaVersion,
      inProcess.metrics.memory.revision,
      inProcess.metrics.memory.eventCursor,
      inProcess.metrics.memory.stateHash,
      inProcess.metrics.memory.ledgerEvents,
      inProcess.metrics.memory.pendingOutbox,
      inProcess.metrics.memory.candidates,
      inProcess.metrics.memory.activeConflicts,
    ]) {
      assert.ok(human.includes(String(value)), `missing metric value: ${value}`);
    }
    assert.match(human, /\[memória\] degradada/i);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
