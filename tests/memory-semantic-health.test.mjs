// [req:DIAG-12] [req:MEM-HYB-7]
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMemoryBundle } from '../src/validate-memory.mjs';
import { renderSharedMemory } from '../hooks/memory-schema.mjs';
import { reduceMemoryEvents } from '../hooks/memory-store.mjs';
import { renderCoreSkeleton } from '../src/validate-core.mjs';

const PROJECT_ID = 'semantic-health-project';
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

function memoryEvent(eventId, memoryKey, value) {
  return {
    v: 1,
    project_id: PROJECT_ID,
    event_id: eventId,
    memory_key: memoryKey,
    operation: 'assert',
    value,
    authority: 'verified',
    canonical_session_id: 'semantic-session',
    activation_id: 'semantic-activation',
    activation_epoch: 1,
    turn_sequence: 1,
    source_turn_id: 'semantic-turn',
    observed_at: '2026-08-16T10:00:00Z',
    evidence: ['tests/memory-semantic-health.test.mjs'],
  };
}

function writeBundle({ events = [], sharedEvents = undefined, candidates = '' } = {}) {
  const vault = mkdtempSync(join(tmpdir(), 'wk-semantic-health-'));
  const brain = join(vault, '.brain');
  mkdirSync(brain, { recursive: true });
  const reduced = reduceMemoryEvents(events);
  writeFileSync(join(brain, 'PROJECT.json'), `${JSON.stringify({ schemaVersion: 1, projectId: PROJECT_ID })}\n`);
  writeFileSync(join(brain, 'CORE.md'), renderCoreSkeleton());
  writeFileSync(
    join(brain, 'MEMORY_EVENTS.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''),
  );
  writeFileSync(join(brain, 'SHARED_MEMORY.md'), renderSharedMemory({
    revision: reduced.revision,
    eventCursor: reduced.eventCursor,
    stateHash: reduced.stateHash,
    events: sharedEvents === undefined ? reduced.activeEvents : sharedEvents,
    updatedAt: '2026-08-16T10:00:00Z',
    reviewAfter: '2026-08-23T10:00:00Z',
  }));
  writeFileSync(join(brain, 'MEMORY_CANDIDATES.jsonl'), candidates);
  return vault;
}

function diagnostics(result) {
  return JSON.stringify({ errors: result.errors, warnings: result.warnings, semantic: result.semantic });
}

function runCli(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

test('v2 sem eventos é semanticamente vazio neutro, não um erro', () => {
  const vault = writeBundle();
  try {
    const result = validateMemoryBundle(vault);
    assert.equal(result.ok, true, result.errors.join('; '));
    assert.equal(result.semantic.status, 'neutral');
    assert.equal(result.semantic.code, 'MEMORY_SEMANTIC_EMPTY_NEUTRAL');
    assert.deepEqual(result.semantic.missingKeys, []);
    const cli = runCli(['validate-memory', '--vault', vault]);
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /MEMORY_SEMANTIC_EMPTY_NEUTRAL/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('v2 reports a conflict-free ledger key missing from SHARED without exposing its value', () => {
  const missing = memoryEvent('mem-semantic-missing', 'next.action', 'PRIVATE_COVERAGE_VALUE');
  const present = memoryEvent('mem-semantic-present', 'objective.current', 'PRIVATE_PRESENT_VALUE');
  const reduced = reduceMemoryEvents([missing, present]);
  const presentEvent = reduced.activeEvents.find((event) => event.memory_key === present.memory_key);
  const vault = writeBundle({ events: [missing, present], sharedEvents: [presentEvent] });
  try {
    const result = validateMemoryBundle(vault);
    assert.equal(result.ok, false);
    assert.equal(result.semantic.code, 'MEMORY_SEMANTIC_COVERAGE_MISSING');
    assert.deepEqual(result.semantic.missingKeys, ['next.action']);
    assert.match(diagnostics(result), /MEMORY_SEMANTIC_COVERAGE_MISSING/);
    assert.doesNotMatch(diagnostics(result), /PRIVATE_(?:COVERAGE|PRESENT)_VALUE/);
    const bundleCli = runCli(['validate-memory', '--vault', vault]);
    assert.equal(bundleCli.status, 1);
    assert.match(bundleCli.stderr, /MEMORY_SEMANTIC_COVERAGE_MISSING/);
    assert.doesNotMatch(bundleCli.stderr, /PRIVATE_(?:COVERAGE|PRESENT)_VALUE/);
    const statusCli = runCli(['memory', 'status', '--gate', '--vault', vault]);
    assert.equal(statusCli.status, 1);
    const status = JSON.parse(statusCli.stdout);
    assert.equal(status.status, 'blocked');
    assert.equal(status.metrics.semanticCode, 'MEMORY_SEMANTIC_COVERAGE_MISSING');
    assert.deepEqual(status.metrics.semanticMissingKeys, ['next.action']);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-HYB-7] v2 accepts only the deterministic bounded omission declared by SHARED', () => {
  const events = Array.from({ length: 64 }, (_, index) => memoryEvent(
    `mem-semantic-bounded-${String(index).padStart(2, '0')}`,
    `${index % 2 ? 'next' : 'blocker'}.bounded-${String(index).padStart(2, '0')}`,
    `PRIVATE_BOUNDED_VALUE_${index}_${'z'.repeat(180)}`,
  ));
  const vault = writeBundle({ events });
  try {
    const result = validateMemoryBundle(vault);
    assert.equal(result.ok, true, result.errors.join('; '));
    assert.equal(result.semantic.status, 'bounded');
    assert.equal(result.semantic.code, 'MEMORY_SEMANTIC_BOUNDED_PROJECTION');
    assert.ok(result.semantic.counts.missingKeys > 0);
    assert.ok(result.semantic.counts.projectedKeys > 0);
    assert.ok(result.warnings.some((warning) => /MEMORY_SEMANTIC_BOUNDED_PROJECTION/.test(warning)));
    assert.doesNotMatch(diagnostics(result), /PRIVATE_BOUNDED_VALUE/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-HYB-7] bounded metadata cannot legitimize an arbitrary projected event set', () => {
  const events = Array.from({ length: 64 }, (_, index) => memoryEvent(
    `mem-semantic-tamper-${String(index).padStart(2, '0')}`,
    `${index % 2 ? 'next' : 'blocker'}.tamper-${String(index).padStart(2, '0')}`,
    `PRIVATE_TAMPER_VALUE_${index}_${'q'.repeat(180)}`,
  ));
  const vault = writeBundle({ events });
  const sharedPath = join(vault, '.brain', 'SHARED_MEMORY.md');
  try {
    const shared = readFileSync(sharedPath, 'utf8');
    const projectedIds = [...shared.matchAll(/^\s*-\s+\[([^\]]+)\]/gm)].map((match) => match[1]);
    const omittedId = events.map((event) => event.event_id).find((id) => !projectedIds.includes(id));
    writeFileSync(sharedPath, shared.replace(`[${projectedIds[0]}]`, `[${omittedId}]`));

    const result = validateMemoryBundle(vault);
    assert.equal(result.ok, false);
    assert.equal(result.semantic.code, 'MEMORY_SEMANTIC_COVERAGE_MISSING');
    assert.doesNotMatch(diagnostics(result), /PRIVATE_TAMPER_VALUE/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('[req:MEM-HYB-7] bounded metadata with divergent counts is blocking', () => {
  const events = Array.from({ length: 64 }, (_, index) => memoryEvent(
    `mem-semantic-count-${String(index).padStart(2, '0')}`,
    `${index % 2 ? 'next' : 'blocker'}.count-${String(index).padStart(2, '0')}`,
    `PRIVATE_COUNT_VALUE_${index}_${'r'.repeat(180)}`,
  ));
  const vault = writeBundle({ events });
  const sharedPath = join(vault, '.brain', 'SHARED_MEMORY.md');
  try {
    const shared = readFileSync(sharedPath, 'utf8');
    writeFileSync(sharedPath, shared.replace(
      /^omitted_events: (\d+)$/m,
      (_, count) => `omitted_events: ${Number(count) + 1}`,
    ));

    const result = validateMemoryBundle(vault);
    assert.equal(result.ok, false);
    assert.equal(result.semantic.code, 'MEMORY_SEMANTIC_COVERAGE_MISSING');
    assert.doesNotMatch(diagnostics(result), /PRIVATE_COUNT_VALUE/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('v2 with only placeholders is degraded and reports counts without values', () => {
  const event = memoryEvent('mem-semantic-placeholder', 'objective.current', 'PRIVATE_PLACEHOLDER_VALUE');
  const vault = writeBundle({ events: [event], sharedEvents: [] });
  try {
    const result = validateMemoryBundle(vault);
    assert.equal(result.ok, false);
    assert.equal(result.semantic.code, 'MEMORY_SEMANTIC_PLACEHOLDER_ONLY');
    assert.equal(result.semantic.placeholderOnly, true);
    assert.equal(result.semantic.counts.activeKeys, 1);
    assert.doesNotMatch(diagnostics(result), /PRIVATE_PLACEHOLDER_VALUE/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('semantic health rejects an unresolved decision link without printing event values', () => {
  const event = memoryEvent('mem-semantic-decision', 'decision.active', 'PRIVATE_DECISION_VALUE [[ADR-9999-missing]]');
  const vault = writeBundle({ events: [event] });
  try {
    const result = validateMemoryBundle(vault);
    assert.equal(result.ok, false);
    assert.equal(result.semantic.code, 'MEMORY_SEMANTIC_DECISION_LINK_UNRESOLVED');
    assert.deepEqual(result.semantic.unresolvedDecisionLinks, ['ADR-9999-missing']);
    assert.doesNotMatch(diagnostics(result), /PRIVATE_DECISION_VALUE/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
