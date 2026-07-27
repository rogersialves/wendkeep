import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SHARED_LIMITS,
  SHARED_SECTIONS,
  eventBelongsToVault,
  parseSharedMemory,
  renderSharedMemory,
  sanitizeMemoryText,
  validateMemoryEvent,
  validateSharedMemory,
} from '../hooks/memory-schema.mjs';
import { readLedgerForValidation, validateMemoryBundle } from '../src/validate-memory.mjs';
import { renderCoreSkeleton } from '../src/validate-core.mjs';

const EVENT = Object.freeze({
  v: 1,
  event_id: 'mem-001',
  project_id: 'project-a',
  memory_key: 'next.review-ui',
  operation: 'assert',
  value: 'Criar interface de revisão',
  authority: 'verified',
  canonical_session_id: 'session-1',
  activation_id: 'act-1',
  turn_sequence: 7,
  source_turn_id: 'turn-7',
  observed_at: '2026-07-26T03:20:47Z',
  evidence: ['ADR-0107'],
});

test('[req:MEM-HYB-8] sanitizeMemoryText removes secrets, PII, transcript paths and harness payloads idempotently', () => {
  const cases = [
    ['environment secret', 'PASSWORD=hunter2', /hunter2/],
    ['OpenAI key', `sk-${'a'.repeat(48)}`, /sk-/],
    ['JWT', `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`, /eyJ/],
    ['Bearer token', 'Bearer abc.def.ghi0123456789', /Bearer|abc\.def/],
    ['real email', 'user@gmail.com', /gmail|user@/],
    ['Windows transcript', String.raw`C:\Users\me\.codex\sessions\rollout.jsonl`, /C:\\Users|rollout\.jsonl/i],
    ['Unix transcript', '/home/roger/.codex/sessions/rollout.jsonl', /\/home\/|rollout\.jsonl/i],
    [
      'plugin harness block',
      '<recommended_plugins>private-plugin-payload</recommended_plugins>',
      /recommended_plugins|private-plugin-payload/i,
    ],
  ];

  for (const [name, input, leaked] of cases) {
    const clean = sanitizeMemoryText(input);
    assert.doesNotMatch(clean, leaked, name);
    assert.equal(sanitizeMemoryText(clean), clean, `${name} remains sanitized on reinjection`);
  }
  assert.equal(sanitizeMemoryText('contato user@example.com'), 'contato user@example.com');
});

test('[req:MEM-HYB-8] event validation rejects unsanitized persistence and enforces project isolation', () => {
  assert.equal(validateMemoryEvent(EVENT, { projectId: 'project-a' }).ok, true);
  assert.equal(eventBelongsToVault(EVENT, 'project-a'), true);
  assert.equal(eventBelongsToVault(EVENT, 'project-b'), false);
  assert.equal(eventBelongsToVault({ ...EVENT, project_id: '' }, 'project-a'), false);

  const privateEvent = { ...EVENT, value: 'TOKEN=not-for-the-ledger' };
  const invalid = validateMemoryEvent(privateEvent, { projectId: 'project-a' });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some((error) => /saniti|secret|redact/i.test(error)));

  const wrongVault = validateMemoryEvent(EVENT, { projectId: 'project-b' });
  assert.equal(wrongVault.ok, false);
  assert.ok(wrongVault.errors.some((error) => /project/i.test(error)));
});

test('[req:MEM-HYB-6] [req:MEM-HYB-8] renderSharedMemory emits a sanitized, fixed and bounded projection', () => {
  const privateEvent = {
    ...EVENT,
    event_id: 'mem-002',
    memory_key: 'handoff.latest',
    value: String.raw`Finalizado por user@gmail.com em C:\Users\me\rollout.jsonl TOKEN=hunter2`,
  };
  const shared = renderSharedMemory({
    revision: 2,
    eventCursor: 'mem-002',
    events: [EVENT, privateEvent],
    updatedAt: '2026-07-26T03:20:47Z',
    reviewAfter: '2026-08-02T03:20:47Z',
  });

  const validation = validateSharedMemory(shared, { eventIds: new Set(['mem-001', 'mem-002']) });
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.doesNotMatch(shared, /gmail|C:\\Users|rollout\.jsonl|hunter2/i);
  assert.ok(Buffer.byteLength(shared, 'utf8') <= SHARED_LIMITS.bytes);
  assert.ok(shared.split('\n').filter((_, index, lines) => index < lines.length - 1 || lines[index]).length <= SHARED_LIMITS.lines);
  assert.ok(shared.split('\n').every((line) => line.length <= SHARED_LIMITS.lineChars));

  const parsed = parseSharedMemory(shared);
  assert.equal(parsed.ok, true, parsed.errors.join('\n'));
  assert.equal(parsed.metadata.schema_version, 2);
  assert.equal(parsed.metadata.revision, 2);
  assert.equal(parsed.metadata.event_cursor, 'mem-002');
  assert.deepEqual([...parsed.sections.keys()], SHARED_SECTIONS);
  assert.match(parsed.sections.get('Próximas Ações').join('\n'), /interface de revisão/);
  assert.match(parsed.sections.get('Último Handoff').join('\n'), /REDACTED/);
});

test('[req:MEM-HYB-6] [req:MEM-HYB-7] validateSharedMemory reports structural, budget and cursor failures', () => {
  const shared = renderSharedMemory({
    revision: 1,
    eventCursor: EVENT.event_id,
    events: [EVENT],
    updatedAt: EVENT.observed_at,
  });

  const missingSection = shared.replace('## Bloqueios\n', '');
  assert.equal(validateSharedMemory(missingSection, { eventIds: new Set([EVENT.event_id]) }).ok, false);

  const staleCursor = validateSharedMemory(shared, { eventIds: new Set(['another-event']) });
  assert.equal(staleCursor.ok, false);
  assert.ok(staleCursor.errors.some((error) => /cursor/i.test(error)));

  const longLine = `${shared.trimEnd()}\n${'x'.repeat(SHARED_LIMITS.lineChars + 1)}\n`;
  const oversized = validateSharedMemory(longLine, { eventIds: new Set([EVENT.event_id]) });
  assert.equal(oversized.ok, false);
  assert.ok(oversized.errors.some((error) => /linha|line/i.test(error)));
});

test('[req:MEM-HYB-6] validateMemoryEvent rejects malformed event fields with actionable errors', () => {
  const invalid = validateMemoryEvent({
    ...EVENT,
    event_id: '',
    authority: 'trusted-ish',
    turn_sequence: -1,
    observed_at: 'yesterday',
    evidence: 'ADR-0107',
  });
  assert.equal(invalid.ok, false);
  for (const field of ['event_id', 'authority', 'turn_sequence', 'observed_at', 'evidence']) {
    assert.ok(invalid.errors.some((error) => error.includes(field)), `reports ${field}`);
  }
});

function tempMemoryVault({ event = EVENT, sharedCursor = event.event_id, ledgerLine } = {}) {
  const vault = mkdtempSync(join(tmpdir(), 'wk-memory-bundle-'));
  const brain = join(vault, '.brain');
  mkdirSync(brain);
  writeFileSync(join(brain, 'PROJECT.json'), `${JSON.stringify({ schemaVersion: 1, projectId: 'project-a' })}\n`);
  writeFileSync(join(brain, 'CORE.md'), renderCoreSkeleton());
  writeFileSync(
    join(brain, 'MEMORY_EVENTS.jsonl'),
    ledgerLine === undefined ? `${JSON.stringify(event)}\n` : ledgerLine,
  );
  writeFileSync(brain + '/SHARED_MEMORY.md', renderSharedMemory({
    revision: 1,
    eventCursor: sharedCursor,
    events: [event],
    updatedAt: event.observed_at,
  }));
  return vault;
}

test('[req:MEM-HYB-3] [req:MEM-HYB-7] validateMemoryBundle composes CORE, ledger and SHARED without mutating curated CORE', () => {
  const vault = tempMemoryVault();
  try {
    const corePath = join(vault, '.brain', 'CORE.md');
    const before = readFileSync(corePath);
    const result = validateMemoryBundle(vault);
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.core.ok, true);
    assert.equal(result.ledger.ok, true);
    assert.equal(result.shared.ok, true);
    assert.deepEqual(result.ledger.eventIds, new Set([EVENT.event_id]));
    assert.deepEqual(readFileSync(corePath), before, 'validator is read-only for curated CORE');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OP-10] validateMemoryBundle rejeita CORE por hardlink antes de tratá-lo como autoridade válida', (t) => {
  const vault = tempMemoryVault();
  const outside = mkdtempSync(join(tmpdir(), 'wk-memory-validation-hardlink-outside-'));
  try {
    const core = join(vault, '.brain', 'CORE.md');
    const source = join(outside, 'CORE.md');
    writeFileSync(source, readFileSync(core));
    rmSync(core);
    try {
      linkSync(source, core);
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
        t.skip(`hardlinks indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }
    const before = readFileSync(source);

    const result = validateMemoryBundle(vault);

    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /hardlink|nlink|Vault/i);
    assert.deepEqual(readFileSync(source), before);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:MEM-HYB-7] [req:MEM-HYB-8] validateMemoryBundle surfaces corrupt ledger, foreign-project events and cursor divergence', () => {
  const cases = [
    {
      name: 'partial/corrupt JSONL',
      options: { ledgerLine: `${JSON.stringify(EVENT)}\n{"event_id":` },
      expected: /ledger|JSON|linha/i,
    },
    {
      name: 'foreign project',
      options: { event: { ...EVENT, project_id: 'project-b' } },
      expected: /project/i,
    },
    {
      name: 'cursor not present in ledger',
      options: { sharedCursor: 'mem-missing' },
      expected: /cursor/i,
    },
  ];

  for (const { name, options, expected } of cases) {
    const vault = tempMemoryVault(options);
    try {
      const result = validateMemoryBundle(vault);
      assert.equal(result.ok, false, name);
      assert.match(result.errors.join('\n'), expected, name);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  }
});

test('[req:MEM-HYB-7] validateMemoryBundle reports missing artifacts instead of treating them as empty', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-memory-missing-'));
  try {
    mkdirSync(join(vault, '.brain'));
    writeFileSync(join(vault, '.brain', 'CORE.md'), renderCoreSkeleton());
    const result = validateMemoryBundle(vault);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /PROJECT|MEMORY_EVENTS|SHARED_MEMORY/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:MEM-HYB-3] an existing empty ledger is valid and contains zero logical lines', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-memory-empty-ledger-'));
  try {
    mkdirSync(join(vault, '.brain'));
    writeFileSync(join(vault, '.brain', 'MEMORY_EVENTS.jsonl'), '');
    const ledger = readLedgerForValidation(vault, { projectId: 'project-a' });
    assert.equal(ledger.ok, true, ledger.errors.join('\n'));
    assert.equal(ledger.lineCount, 0);
    assert.deepEqual(ledger.events, []);
    assert.deepEqual(ledger.eventIds, new Set());
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
