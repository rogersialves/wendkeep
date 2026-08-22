import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  activeContextRegistryInitialized,
  buildCausalSharedHandoff,
  resolveHandoffEvidenceAuthority,
  scopeEvidenceRows,
} from '../hooks/active-context-handoff-evidence.mjs';
import { readMemoryLedger } from '../hooks/memory-store.mjs';
import { readSessionRegistry, writeSessionRegistry } from '../hooks/obsidian-common.mjs';
import { captureProjectScope, scopeForRegistry } from '../hooks/project-scope.mjs';
import { mutateActiveContext, setActiveContextChange } from '../hooks/active-context-store.mjs';
import { resolveRuntimeActiveContext } from '../src/active-context-runtime.mjs';
import {
  discoverWorktreeRepository,
  ensureWorktreeMetadata,
} from '../packages/vault/src/worktree-metadata.mjs';
import {
  SYNTHETIC_MEMORY,
  cleanSyntheticHookEnv,
  seedSyntheticHybridLifecycle,
} from './fixtures/synthetic-memory-lifecycle.mjs';

const STOP = join(process.cwd(), 'hooks', 'session-stop.mjs');
const EVIDENCE_CONTEXT = join(process.cwd(), 'hooks', 'evidence-context.mjs');

const identity = {
  projectId: 'project-a',
  repositoryId: 'repo-a',
  worktreeId: 'tree-a',
  workSessionId: 'work-a',
  branch: 'wk/causal',
  sessionId: 'session-a',
};

const context = {
  project_id: 'project-a',
  repository_id: 'repo-a',
  worktree_id: 'tree-a',
  work_session_id: 'work-a',
  branch: 'wk/causal',
  change_slug: 'causal-change',
  state: 'active',
};

test('[req:ACTX-22] contextual handoff replaces legacy identity with the active context authority', () => {
  const shared = buildCausalSharedHandoff({
    input: { shared: { objective: 'continuar', tasks_hash: 'tasks-a' } },
    entry: { work_session_id: 'legacy-work', change_slug: 'legacy-change' },
    authority: { mode: 'contextual', identity, context },
  });

  assert.deepEqual(shared, {
    objective: 'continuar',
    tasks_hash: 'tasks-a',
    work_session_id: 'work-a',
    repository_id: 'repo-a',
    worktree_id: 'tree-a',
    branch: 'wk/causal',
    change_slug: 'causal-change',
  });
});

test('[req:ACTX-25] contextual handoff rejects a sibling identity instead of publishing it', () => {
  assert.throws(() => buildCausalSharedHandoff({
    input: { shared: { objective: 'continuar', work_session_id: 'work-b' } },
    entry: { work_session_id: 'work-a' },
    authority: { mode: 'contextual', identity, context },
  }), (error) => error?.code === 'WENDKEEP_HANDOFF_CONTEXT_MISMATCH'
    && /work_session_id/.test(error.message));
});

test('[req:ACTX-25] every snake/camel and top-level identity alias must agree', () => {
  assert.throws(() => buildCausalSharedHandoff({
    input: {
      work_session_id: 'work-a',
      shared: { work_session_id: 'work-a', workSessionId: 'work-b' },
    },
    entry: { work_session_id: 'work-a' },
    authority: { mode: 'contextual', identity, context },
  }), (error) => error?.code === 'WENDKEEP_HANDOFF_CONTEXT_MISMATCH');
});

test('[req:ACTX-25] identity aliases in both supported shared envelopes must agree', () => {
  assert.throws(() => buildCausalSharedHandoff({
    input: {
      shared: { objective: 'causal', work_session_id: 'work-a' },
      handoff: { shared: { work_session_id: 'work-b' } },
    },
    entry: { work_session_id: 'work-a' },
    authority: { mode: 'contextual', identity, context },
  }), (error) => error?.code === 'WENDKEEP_HANDOFF_CONTEXT_MISMATCH');
});

test('[req:ACTX-25] stale active-context branch fails closed', () => {
  assert.throws(() => buildCausalSharedHandoff({
    input: { shared: { objective: 'causal' } },
    entry: { work_session_id: 'work-a' },
    authority: {
      mode: 'contextual',
      identity,
      context: { ...context, branch: 'wk/stale-sibling' },
    },
  }), (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_IDENTITY_MISMATCH'
    && /branch/.test(error.message));
});

test('[req:ACTX-25] registry with an explicit empty active_contexts store is contextual, not legacy', () => {
  assert.equal(activeContextRegistryInitialized({ active_contexts: {} }), true);
  assert.equal(activeContextRegistryInitialized({ active_contexts_schema: 1 }), true);
  assert.equal(activeContextRegistryInitialized({ sessions: {} }), false);
});

test('[req:ACTX-25] legacy registry preserves the previous shared handoff fallback', () => {
  assert.deepEqual(buildCausalSharedHandoff({
    input: { shared: { objective: 'continuar' } },
    entry: { work_session_id: 'legacy-work' },
    authority: { mode: 'legacy', identity: null, context: null },
  }), { objective: 'continuar', work_session_id: 'legacy-work' });
});

test('[req:ACTX-25] initialized registry never reopens legacy when identity is absent', () => {
  assert.throws(
    () => resolveHandoffEvidenceAuthority('unused', {
      registry: { active_contexts_schema: 1, active_contexts: {} },
      resolveCommand: () => null,
      resolveContext: () => {
        throw new Error('legacy context resolution must not run');
      },
    }),
    (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_NOT_FOUND',
  );
});

test('[req:ACTX-25] ambiguous active-context identity is propagated fail-closed', () => {
  const ambiguous = Object.assign(new Error('ambiguous active context'), {
    code: 'WENDKEEP_ACTIVE_CONTEXT_AMBIGUOUS',
  });
  assert.throws(
    () => resolveHandoffEvidenceAuthority('unused', {
      registry: { active_contexts_schema: 1, active_contexts: {} },
      resolveCommand: () => {
        throw ambiguous;
      },
    }),
    (error) => error === ambiguous,
  );
});

test('[req:ACTX-24] automatic evidence excludes active siblings and preserves causal/global history', () => {
  const registry = {
    active_contexts_schema: 1,
    active_contexts: {
      'repo-a:tree-a:work-a': context,
      'repo-a:tree-a:work-b': {
        ...context,
        work_session_id: 'work-b',
        change_slug: 'sibling-change',
      },
    },
    sessions: {
      'session-a': { work_session_id: 'work-a' },
      'session-b': { work_session_id: 'work-b' },
    },
  };
  const rows = [
    { chunk_id: 'causal-session', session_id: 'session-a', change_slug: '' },
    { chunk_id: 'causal-change', session_id: '', change_slug: 'causal-change' },
    { chunk_id: 'sibling-session', session_id: 'session-b', change_slug: '' },
    { chunk_id: 'sibling-change', session_id: '', change_slug: 'sibling-change' },
    { chunk_id: 'unknown-session', session_id: 'session-unknown', change_slug: '' },
    { chunk_id: 'global', session_id: '', work_session_id: '', change_slug: '' },
    { chunk_id: 'historical', session_id: '', change_slug: 'archived-change' },
  ];

  assert.deepEqual(
    scopeEvidenceRows(rows, { activeContext: identity, registry }).map((row) => row.chunk_id),
    ['causal-session', 'causal-change', 'global', 'historical'],
  );
});

test('[req:ACTX-24] initialized registry without a causal caller keeps only global or historical rows', () => {
  const rows = [
    { chunk_id: 'unknown-session', session_id: 'session-unknown', change_slug: '' },
    { chunk_id: 'explicit-work', session_id: '', work_session_id: 'work-a', change_slug: '' },
    { chunk_id: 'active-change', session_id: '', change_slug: 'causal-change' },
    { chunk_id: 'global', session_id: '', work_session_id: '', change_slug: '' },
    { chunk_id: 'historical', session_id: '', change_slug: 'archived-change' },
  ];
  const registry = {
    active_contexts: { 'repo-a:tree-a:work-a': context },
    sessions: {},
  };
  assert.deepEqual(
    scopeEvidenceRows(rows, { activeContext: null, registry }).map((row) => row.chunk_id),
    ['global', 'historical'],
  );
});

test('[req:ACTX-24] legacy evidence selection remains global only before context-store initialization', () => {
  const rows = [{ chunk_id: 'a' }, { chunk_id: 'b', session_id: 'session-b' }];
  assert.equal(scopeEvidenceRows(rows, { activeContext: null, registry: { sessions: {} } }), rows);
});

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

function outboxNames(vault) {
  try { return readdirSync(join(vault, '.brain', 'memory-outbox')).sort(); }
  catch { return []; }
}

function seedContextualStopFixture() {
  const fixture = seedSyntheticHybridLifecycle();
  git(fixture.project, ['init']);
  git(fixture.project, ['config', 'user.email', 'handoff-evidence@example.invalid']);
  git(fixture.project, ['config', 'user.name', 'Handoff Evidence Test']);
  git(fixture.project, ['branch', '-M', 'main']);
  git(fixture.project, ['remote', 'add', 'origin', 'https://example.com/acme/handoff-evidence.git']);
  git(fixture.project, ['add', '-A']);
  git(fixture.project, ['commit', '-m', 'fixture']);
  ensureWorktreeMetadata({
    repository: discoverWorktreeRepository({ startDir: fixture.project }),
    projectId: SYNTHETIC_MEMORY.projectId,
    vaultPath: fixture.vault,
  });

  const scope = (sessionId) => scopeForRegistry(captureProjectScope({
    input: { cwd: fixture.project },
    projectRoot: fixture.project,
    projectId: SYNTHETIC_MEMORY.projectId,
    provider: 'codex',
    sessionId,
  }));
  const registry = readSessionRegistry(fixture.vault);
  const baseEntry = structuredClone(registry.sessions[SYNTHETIC_MEMORY.sessionId]);
  const sibling = {
    sessionId: 'session-b',
    workSessionId: 'work-b',
    activationId: 'activation-b',
    turnId: 'turn-b',
    noteRel: '03-Sessões/session-b.md',
    transcript: join(fixture.project, 'session-b-transcript.jsonl'),
  };
  const siblingNote = join(fixture.vault, ...sibling.noteRel.split('/'));
  writeFileSync(
    siblingNote,
    readFileSync(fixture.sessionPath, 'utf8').replaceAll(SYNTHETIC_MEMORY.sessionId, sibling.sessionId),
  );
  const siblingTranscript = readFileSync(fixture.transcript, 'utf8').trim().split('\n').map((line) => {
    const event = JSON.parse(line);
    if (event.type === 'session_meta') event.payload.id = sibling.sessionId;
    if (event.payload?.turn_id) event.payload.turn_id = sibling.turnId;
    return event;
  });
  writeFileSync(sibling.transcript, `${siblingTranscript.map(JSON.stringify).join('\n')}\n`);
  registry.version = 2;
  registry.sessions[SYNTHETIC_MEMORY.sessionId] = {
    ...registry.sessions[SYNTHETIC_MEMORY.sessionId],
    work_session_id: 'work-a',
    project_scope: scope(SYNTHETIC_MEMORY.sessionId),
    change_slug: SYNTHETIC_MEMORY.changeSlug,
  };
  registry.sessions[sibling.sessionId] = {
    ...baseEntry,
    session_file: sibling.noteRel,
    status: 'active',
    transcript_path: sibling.transcript,
    transcript_id: sibling.sessionId,
    work_session_id: sibling.workSessionId,
    project_scope: scope(sibling.sessionId),
    activation_id: sibling.activationId,
    active_activation_id: sibling.activationId,
    last_turn_sequence: 0,
    activations: {
      [sibling.activationId]: {
        ...Object.values(baseEntry.activations || {})[0],
        activation_id: sibling.activationId,
        status: 'active',
        last_turn_sequence: 0,
        transcript_id: sibling.sessionId,
        transcript_path: sibling.transcript,
      },
    },
  };
  writeSessionRegistry(fixture.vault, registry);

  const a = resolveRuntimeActiveContext({
    vaultBase: fixture.vault,
    projectRoot: fixture.project,
    sessionId: SYNTHETIC_MEMORY.sessionId,
  });
  const b = resolveRuntimeActiveContext({
    vaultBase: fixture.vault,
    projectRoot: fixture.project,
    sessionId: 'session-b',
  });
  mutateActiveContext(fixture.vault, a, (current) => current, { projectLegacy: false });
  mutateActiveContext(fixture.vault, b, (current) => current, { projectLegacy: false });
  setActiveContextChange(fixture.vault, a, 'causal-change', { projectLegacy: false });
  setActiveContextChange(fixture.vault, b, SYNTHETIC_MEMORY.changeSlug, { projectLegacy: false });

  const causalArchive = join(fixture.vault, '08-Mudanças', '_arquivo', 'causal-change');
  mkdirSync(causalArchive, { recursive: true });
  writeFileSync(join(causalArchive, 'verdict.json'), JSON.stringify({
    ok: true,
    coverage: [{ req: 'ACTX-E2E', covered: true }],
  }));
  writeFileSync(join(causalArchive, 'evidencia.json'), JSON.stringify([
    { id: 'causal-sensor', status: 'green' },
  ]));
  writeFileSync(
    join(fixture.vault, '04-Decisões', 'ADR-0002-causal-change.md'),
    '# Causal change\n',
  );
  return { ...fixture, a, b, sibling: { ...sibling, notePath: siblingNote } };
}

function runStop(fixture, shared = undefined, options = {}) {
  const sessionId = options.sessionId || SYNTHETIC_MEMORY.sessionId;
  const transcript = options.transcript || fixture.transcript;
  const turnId = options.turnId || SYNTHETIC_MEMORY.turnOne;
  const activationId = options.activationId || SYNTHETIC_MEMORY.activationOne;
  return spawnSync(process.execPath, [STOP], {
    cwd: fixture.project,
    encoding: 'utf8',
    windowsHide: true,
    env: cleanSyntheticHookEnv(fixture.vault),
    input: JSON.stringify({
      hook_event_name: 'Stop',
      cwd: fixture.project,
      session_id: sessionId,
      transcript_path: transcript,
      turn_id: turnId,
      turn_sequence: 1,
      activation_id: activationId,
      ...(shared ? { shared } : {}),
    }),
  });
}

test('[req:ACTX-22] [req:ACTX-23] [req:ACTX-25] Stop isolates handoff and evidence for two real work sessions', () => {
  const fixture = seedContextualStopFixture();
  try {
    const registryPath = join(fixture.brain, 'SESSION_REGISTRY.json');
    const ledgerPath = join(fixture.brain, 'MEMORY_EVENTS.jsonl');
    const beforeMismatch = {
      registry: readFileSync(registryPath),
      ledger: readFileSync(ledgerPath),
      note: readFileSync(fixture.sessionPath),
      outbox: outboxNames(fixture.vault),
    };
    const mismatch = runStop(fixture, {
      objective: 'sibling payload must fail',
      work_session_id: 'work-b',
    });
    assert.equal(mismatch.status, 0, mismatch.stderr);
    assert.match(JSON.parse(mismatch.stdout || '{}').systemMessage, /active context|handoff/i);
    assert.deepEqual(readFileSync(registryPath), beforeMismatch.registry);
    assert.deepEqual(readFileSync(ledgerPath), beforeMismatch.ledger);
    assert.deepEqual(readFileSync(fixture.sessionPath), beforeMismatch.note);
    assert.deepEqual(outboxNames(fixture.vault), beforeMismatch.outbox);

    const stop = runStop(fixture, { objective: 'causal handoff' });
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(JSON.parse(stop.stdout || '{}').systemMessage, undefined);
    const events = readMemoryLedger(fixture.vault).events;
    const eventsA = events.filter((event) => event.source_turn_id === SYNTHETIC_MEMORY.turnOne);
    assert.ok(eventsA.some((event) => event.memory_key === 'change.causal-change.status'));
    assert.ok(!eventsA.some((event) => event.memory_key === `change.${SYNTHETIC_MEMORY.changeSlug}.status`));
    assert.ok(eventsA.every((event) => event.work_session_id === 'work-a'));
    assert.ok(eventsA.some((event) => event.scope?.type === 'change' && event.scope.id === 'causal-change'));
    const verdict = eventsA.find((event) => event.memory_key === 'quality.latest-verdict');
    assert.deepEqual(verdict?.value, { ok: true, covered: 1, total: 1 });
    assert.equal(verdict?.scope?.id, 'causal-change');
    assert.ok(verdict?.evidence?.some((item) => /causal-change\/verdict\.json/.test(item)));
    const sensors = eventsA.find((event) => event.memory_key === 'quality.latest-sensors');
    assert.deepEqual(sensors?.value, ['causal-sensor']);
    assert.equal(sensors?.scope?.id, 'causal-change');
    assert.deepEqual(sensors?.evidence, ['causal-sensor']);
    assert.ok(!eventsA.some((event) => JSON.stringify(event.value).includes('wk-fixture-example-sensor-alpha')));
    assert.match(readFileSync(fixture.sessionPath, 'utf8'), /causal-change\/proposta/);
    assert.doesNotMatch(readFileSync(fixture.sessionPath, 'utf8'), new RegExp(`${SYNTHETIC_MEMORY.changeSlug}/proposta`));

    const siblingStop = runStop(fixture, undefined, fixture.sibling);
    assert.equal(siblingStop.status, 0, siblingStop.stderr);
    assert.equal(JSON.parse(siblingStop.stdout || '{}').systemMessage, undefined);
    const eventsB = readMemoryLedger(fixture.vault).events
      .filter((event) => event.source_turn_id === fixture.sibling.turnId);
    assert.ok(eventsB.length > 0);
    assert.ok(eventsB.every((event) => event.work_session_id === fixture.sibling.workSessionId));
    assert.ok(eventsB.some((event) => event.memory_key === `change.${SYNTHETIC_MEMORY.changeSlug}.status`));
    assert.ok(eventsB.some((event) => event.scope?.type === 'change'
      && event.scope.id === SYNTHETIC_MEMORY.changeSlug));
    assert.match(readFileSync(fixture.sibling.notePath, 'utf8'), new RegExp(`${SYNTHETIC_MEMORY.changeSlug}/proposta`));
  } finally {
    rmSync(fixture.project, { recursive: true, force: true });
  }
});

test('[req:ACTX-24] executable evidence hook excludes sibling context and keeps causal/global rows', () => {
  const fixture = seedContextualStopFixture();
  try {
    const rows = [
      {
        chunk_id: 'sibling-row', title: 'Context marker', heading: 'Sibling',
        logical_path: '02-Sessões/sibling.md', content: 'context marker sibling secret',
        authority: 'verified', validity: 'active', session_id: 'session-b',
        work_session_id: 'work-b', change_slug: SYNTHETIC_MEMORY.changeSlug,
      },
      {
        chunk_id: 'causal-row', title: 'Context marker', heading: 'Causal',
        logical_path: '02-Sessões/causal.md', content: 'context marker causal visible',
        authority: 'verified', validity: 'active', session_id: SYNTHETIC_MEMORY.sessionId,
        work_session_id: 'work-a', change_slug: 'causal-change',
      },
      {
        chunk_id: 'global-row', title: 'Context marker', heading: 'Global',
        logical_path: '04-Decisões/global.md', content: 'context marker global visible',
        authority: 'verified', validity: 'active', session_id: '',
        work_session_id: '', change_slug: 'archived-change',
      },
    ];
    writeFileSync(
      join(fixture.brain, 'EVIDENCE_INDEX.jsonl'),
      `${rows.map(JSON.stringify).join('\n')}\n`,
    );
    const result = spawnSync(process.execPath, [EVIDENCE_CONTEXT], {
      cwd: fixture.project,
      encoding: 'utf8',
      windowsHide: true,
      env: cleanSyntheticHookEnv(fixture.vault),
      input: JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        cwd: fixture.project,
        session_id: SYNTHETIC_MEMORY.sessionId,
        prompt: 'context marker',
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    const contextOutput = JSON.parse(result.stdout || '{}')
      .hookSpecificOutput?.additionalContext || '';
    assert.match(contextOutput, /causal visible/);
    assert.match(contextOutput, /global visible/);
    assert.doesNotMatch(contextOutput, /sibling secret/);
  } finally {
    rmSync(fixture.project, { recursive: true, force: true });
  }
});

test('[req:ACTX-24] read-only evidence hook never migrates a legacy pointer into an empty contextual store', () => {
  const fixture = seedContextualStopFixture();
  try {
    const registryPath = join(fixture.brain, 'SESSION_REGISTRY.json');
    const registry = readSessionRegistry(fixture.vault);
    registry.active_contexts_schema = 1;
    registry.active_contexts_revision = 0;
    registry.active_contexts = {};
    writeSessionRegistry(fixture.vault, registry);
    writeFileSync(join(fixture.brain, 'CURRENT_CHANGE.md'), 'change: legacy-pointer\n');
    const rows = [
      {
        chunk_id: 'session-row', title: 'Read only marker', heading: 'Session',
        logical_path: '02-Sessões/session.md', content: 'read only marker session owned',
        authority: 'verified', validity: 'active', session_id: SYNTHETIC_MEMORY.sessionId,
        work_session_id: 'work-a', change_slug: 'legacy-pointer',
      },
      {
        chunk_id: 'global-row', title: 'Read only marker', heading: 'Global',
        logical_path: '04-Decisões/global.md', content: 'read only marker global visible',
        authority: 'verified', validity: 'active', session_id: '',
        work_session_id: '', change_slug: 'archived-change',
      },
    ];
    writeFileSync(
      join(fixture.brain, 'EVIDENCE_INDEX.jsonl'),
      `${rows.map(JSON.stringify).join('\n')}\n`,
    );
    const beforeRegistry = readFileSync(registryPath);
    const result = spawnSync(process.execPath, [EVIDENCE_CONTEXT], {
      cwd: fixture.project,
      encoding: 'utf8',
      windowsHide: true,
      env: cleanSyntheticHookEnv(fixture.vault),
      input: JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        cwd: fixture.project,
        session_id: SYNTHETIC_MEMORY.sessionId,
        prompt: 'read only marker',
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    const contextOutput = JSON.parse(result.stdout || '{}')
      .hookSpecificOutput?.additionalContext || '';
    assert.match(contextOutput, /global visible/);
    assert.doesNotMatch(contextOutput, /session owned/);
    assert.deepEqual(readFileSync(registryPath), beforeRegistry);
  } finally {
    rmSync(fixture.project, { recursive: true, force: true });
  }
});
