import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { renderSharedMemory } from '../hooks/memory-schema.mjs';
import { reduceMemoryEvents, reprojectMemoryLedger } from '../hooks/memory-store.mjs';
import { checkMemoryBundle } from '../hooks/vault-health.mjs';
import { renderCoreSkeleton } from '../src/validate-core.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');
const PROJECT_ID = 'project-memory-gate';

function event() {
  return {
    v: 1,
    project_id: PROJECT_ID,
    event_id: 'mem-gate-1',
    memory_key: 'next.ui',
    operation: 'assert',
    value: 'review',
    authority: 'verified',
    canonical_session_id: 'session-gate',
    activation_id: 'activation-gate',
    activation_epoch: 1,
    turn_sequence: 1,
    source_turn_id: 'turn-gate-1',
    observed_at: '2026-07-26T05:00:00Z',
    evidence: ['tests/memory-gate.test.mjs'],
  };
}

function seedBundle(vault, { warning = false, corrupt = false } = {}) {
  const brain = join(vault, '.brain');
  mkdirSync(brain, { recursive: true });
  const item = event();
  const reduced = reduceMemoryEvents([item]);
  writeFileSync(join(brain, 'PROJECT.json'), `${JSON.stringify({ schemaVersion: 1, projectId: PROJECT_ID })}\n`);
  writeFileSync(join(brain, 'CORE.md'), renderCoreSkeleton());
  writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), corrupt ? `${JSON.stringify(item)}\n{"v":1` : `${JSON.stringify(item)}\n`);
  writeFileSync(join(brain, 'SHARED_MEMORY.md'), renderSharedMemory({
    revision: reduced.revision,
    eventCursor: reduced.eventCursor,
    stateHash: reduced.stateHash,
    events: reduced.activeEvents,
    updatedAt: '2026-07-26T05:00:00Z',
    reviewAfter: '2026-08-02T05:00:00Z',
  }));
  writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), warning ? `${JSON.stringify({
    candidate_id: 'candidate-gate', reason: 'reported', memory_key: 'next.ui', status: 'pending',
  })}\n` : '');
  if (warning) {
    mkdirSync(join(brain, 'memory-outbox'));
    writeFileSync(join(brain, 'memory-outbox', 'mem-pending.json'), `${JSON.stringify({ ...item, event_id: 'mem-pending' })}\n`);
  }
}

test('[req:OP-10] internal memory health blocks a missing vault instead of downgrading to legacy', () => {
  const missing = join(tmpdir(), `wk-memory-gate-missing-${process.pid}-${Date.now()}`);
  const result = checkMemoryBundle(missing);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.match(result.failures.join('\n'), /not found|não existe|ausente/i);
});

function cli(args, cwd = process.cwd()) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
}

function fillChange(vault, slug) {
  const dir = join(vault, '08-Mudanças', slug);
  writeFileSync(join(dir, 'proposta.md'), `---\nspec_impact: none\nspec_impact_reason: "Fixture de gate"\nspecs: []\n---\n\n# ${slug}\n\n## Por quê\n\nProvar gate.\n\n## O que muda\n\nSomente fixture.\n`);
  writeFileSync(join(dir, 'design.md'), `# ${slug} — design\n\n## Abordagem\n\nFixture completa.\n`);
  writeFileSync(join(dir, 'tarefas.md'), '- [x] 1.1 validar memória [sensor:memory-health]\n');
}

test('[req:DIAG-8] memory status --gate exits 1 only for blocking states', () => {
  const warningVault = mkdtempSync(join(tmpdir(), 'wk-memory-gate-warning-'));
  const corruptVault = mkdtempSync(join(tmpdir(), 'wk-memory-gate-corrupt-'));
  try {
    seedBundle(warningVault, { warning: true });
    seedBundle(corruptVault, { corrupt: true });
    const warning = cli(['memory', 'status', '--gate', '--vault', warningVault]);
    const corrupt = cli(['memory', 'status', '--gate', '--vault', corruptVault]);
    assert.equal(warning.status, 0, warning.stderr || warning.stdout);
    assert.equal(JSON.parse(warning.stdout).status, 'warning');
    assert.equal(corrupt.status, 1, corrupt.stderr || corrupt.stdout);
    assert.equal(JSON.parse(corrupt.stdout).status, 'blocked');
  } finally {
    rmSync(warningVault, { recursive: true, force: true });
    rmSync(corruptVault, { recursive: true, force: true });
  }
});

test('[req:OP-10] memory health rederives physical checkpoints with the same CORE-aware contract', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-memory-gate-causal-'));
  const brain = join(vault, '.brain');
  try {
    mkdirSync(brain, { recursive: true });
    const older = {
      ...event(),
      event_id: 'mem-physical-last',
      memory_key: 'handoff.previous',
      value: 'resumo antigo',
      canonical_session_id: 'session-gate',
      turn_sequence: 3,
      source_turn_id: 'turn-gate-3',
      observed_at: '2026-07-26T05:00:00Z',
    };
    const newer = {
      ...older,
      event_id: 'mem-causal-last',
      memory_key: 'handoff.latest',
      value: 'resumo atual',
      turn_sequence: 3,
      observed_at: '2026-07-26T05:01:00Z',
    };
    const blockedByCore = {
      ...event(),
      event_id: 'mem-core-conflict',
      memory_key: 'release.push',
      value: 'automatic',
      turn_sequence: 3,
      source_turn_id: 'turn-gate-3',
      observed_at: '2026-07-26T05:02:00Z',
    };
    writeFileSync(join(brain, 'PROJECT.json'), `${JSON.stringify({ schemaVersion: 1, projectId: PROJECT_ID })}\n`);
    writeFileSync(join(brain, 'CORE.md'), `${renderCoreSkeleton().trimEnd()}\n<!-- wk-memory: release.push="manual-only" -->\n`);
    writeFileSync(join(brain, 'MEMORY_EVENTS.jsonl'), [newer, blockedByCore, older]
      .map((item) => JSON.stringify(item)).join('\n') + '\n');

    const projection = reprojectMemoryLedger(vault);
    const health = checkMemoryBundle(vault, { registry: {
      version: 2,
      sessions: {
        'session-gate': {
          last_memory_attempt: {
            memory_mode: 'v2',
            canonical_session_id: 'session-gate',
            activation_id: 'activation-gate',
            activation_epoch: 1,
            turn_id: 'turn-gate-3',
            turn_sequence: 3,
            state: 'projected',
            disposition: 'applied',
            event_ids: [newer.event_id, blockedByCore.event_id, older.event_id],
            checkpoint: projection.checkpoint,
          },
        },
      },
    } });

    assert.equal(projection.eventCursor, blockedByCore.event_id, 'causal cursor remains independent of physical order');
    assert.equal(projection.ledgerCursor, older.event_id);
    assert.equal(projection.checkpoint.event_cursor, older.event_id);
    assert.equal(projection.revision, 2, 'CORE-blocked event does not advance operational revision');
    assert.equal(health.ok, true, health.failures.join('\n'));
    assert.equal(health.failures.some((item) => /stale|checkpoint|prefixo/i.test(item)), false);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OP-10] memory health vincula registry key e identidade causal completa aos eventos', async (t) => {
  const cases = [
    {
      name: 'registry session key divergente',
      sessionId: 'borrowed-session',
      attempt: { canonical_session_id: 'session-gate' },
      error: /canonical_session_id|identidade causal/i,
    },
    {
      name: 'activation do evento divergente',
      sessionId: 'session-gate',
      attempt: { canonical_session_id: 'session-gate', activation_id: 'activation-other' },
      error: /activation_id|identidade causal/i,
    },
    {
      name: 'epoch do evento divergente',
      sessionId: 'session-gate',
      attempt: { canonical_session_id: 'session-gate', activation_epoch: 2 },
      error: /activation_epoch|identidade causal/i,
    },
    {
      name: 'turn do evento divergente',
      sessionId: 'session-gate',
      attempt: { canonical_session_id: 'session-gate', turn_id: 'turn-other' },
      error: /source_turn_id|identidade causal/i,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const vault = mkdtempSync(join(tmpdir(), 'wk-memory-gate-identity-'));
      try {
        seedBundle(vault);
        const projection = reprojectMemoryLedger(vault);
        const attempt = {
          memory_mode: 'v2',
          canonical_session_id: 'session-gate',
          activation_id: 'activation-gate',
          activation_epoch: 1,
          turn_id: 'turn-gate-1',
          turn_sequence: 1,
          state: 'projected',
          disposition: 'applied',
          event_ids: ['mem-gate-1'],
          checkpoint: projection.checkpoint,
          ...scenario.attempt,
        };
        const health = checkMemoryBundle(vault, { registry: {
          version: 2,
          sessions: { [scenario.sessionId]: { last_memory_attempt: attempt } },
        } });
        assert.equal(health.status, 'blocked');
        assert.match(health.failures.join('\n'), scenario.error);
      } finally {
        rmSync(vault, { recursive: true, force: true });
      }
    });
  }
});

test('[req:DIAG-8] critical memory-health evidence blocks verify/archive on corruption', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-memory-gate-vault-'));
  const project = mkdtempSync(join(tmpdir(), 'wk-memory-gate-project-'));
  try {
    assert.equal(cli(['change', 'new', 'memory-broken', '--vault', vault, '--project', project]).status, 0);
    fillChange(vault, 'memory-broken');
    seedBundle(vault, { corrupt: true });
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} memory status --gate --vault ${JSON.stringify(vault)}`;
    writeFileSync(join(project, 'wendkeep.sensors.json'), JSON.stringify({
      version: 1,
      sensors: [{ id: 'memory-health', severity: 'critical', command }],
    }));
    const verify = cli(['verify', '--change', 'memory-broken', '--vault', vault, '--project', project], project);
    assert.equal(verify.status, 1, verify.stderr || verify.stdout);
    const archive = cli(['change', 'archive', 'memory-broken', '--vault', vault, '--project', project], project);
    assert.equal(archive.status, 1, archive.stderr || archive.stdout);
    assert.match(archive.stderr, /memory-health|BLOCKED/i);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('[req:DIAG-8] outbox/candidate warnings keep verify and archive open', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-memory-gate-vault-'));
  const project = mkdtempSync(join(tmpdir(), 'wk-memory-gate-project-'));
  try {
    assert.equal(cli(['change', 'new', 'memory-warning', '--vault', vault, '--project', project]).status, 0);
    fillChange(vault, 'memory-warning');
    seedBundle(vault, { warning: true });
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} memory status --gate --vault ${JSON.stringify(vault)}`;
    writeFileSync(join(project, 'wendkeep.sensors.json'), JSON.stringify({
      version: 1,
      sensors: [{ id: 'memory-health', severity: 'critical', command }],
    }));
    assert.equal(cli(['verify', '--deep', '--change', 'memory-warning', '--vault', vault, '--project', project], project).status, 0);
    const archive = cli(['change', 'archive', 'memory-warning', '--vault', vault, '--project', project], project);
    assert.equal(archive.status, 0, archive.stderr || archive.stdout);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
