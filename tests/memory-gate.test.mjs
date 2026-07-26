import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { renderSharedMemory } from '../hooks/memory-schema.mjs';
import { reduceMemoryEvents } from '../hooks/memory-store.mjs';
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
    activation_id: 'activation-gate',
    turn_sequence: 1,
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
