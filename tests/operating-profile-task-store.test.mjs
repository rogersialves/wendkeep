import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readSessionRegistry } from '../hooks/obsidian-common.mjs';
import {
  consumeSessionTaskOperatingProfile,
  sessionTaskOperatingProfile,
  setSessionTaskOperatingProfile,
} from '../hooks/operating-profile-task-store.mjs';
import {
  activeContextKey,
  mutateActiveContext,
} from '../hooks/active-context-store.mjs';

function fixture() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-task-profile-store-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  const note = join(vault, 'session.md');
  writeFileSync(note, '# bytes imutáveis\n', 'utf8');
  writeFileSync(join(vault, '.brain', 'SESSION_REGISTRY.json'), `${JSON.stringify({
    version: 2,
    sessions: {
      'session-1': {
        status: 'active',
        provider: 'codex',
        session_file: 'session.md',
        operating_profile: 'OFF',
        operating_profile_source: 'explicit-cli',
        last_prompt_turn_id: 'turn-5',
        last_turn_sequence: 5,
        turn_sequences: { 'turn-5': 5 },
      },
      'session-2': {
        status: 'active',
        provider: 'codex',
        session_file: 'session.md',
        operating_profile: 'OFF',
        operating_profile_source: 'explicit-cli',
        last_prompt_turn_id: 'turn-7',
        last_turn_sequence: 7,
        turn_sequences: { 'turn-7': 7 },
      },
    },
  }, null, 2)}\n`, 'utf8');
  return { vault, note };
}

function identity(worktreeId, workSessionId) {
  return {
    projectId: 'project-task-lease',
    repositoryId: 'repository-task-lease',
    worktreeId,
    workSessionId,
    branch: `wk/${worktreeId}`,
    headSha: 'a'.repeat(40),
  };
}

test('[req:ACTX-18] [req:ACTX-20] contextual leases replace and consume only their owning active context', () => {
  const f = fixture();
  try {
    const a = identity('worktree-a', 'work-a');
    const b = identity('worktree-a', 'work-b');
    mutateActiveContext(f.vault, a, (context) => context);
    mutateActiveContext(f.vault, b, (context) => context);

    const firstA = setSessionTaskOperatingProfile(f.vault, 'session-1', 'FLOW', {
      context: a, reason: 'route A', leaseId: 'lease-a-1', now: '2026-08-22T08:00:00.000Z',
    });
    const leaseB = setSessionTaskOperatingProfile(f.vault, 'session-2', 'GOVERN', {
      context: b, reason: 'route B', leaseId: 'lease-b', now: '2026-08-22T08:01:00.000Z',
    });
    let registry = readSessionRegistry(f.vault);
    const keyA = activeContextKey(a);
    const keyB = activeContextKey(b);
    assert.equal(registry.sessions['session-1'].operating_profile_task, undefined);
    assert.equal(registry.sessions['session-2'].operating_profile_task, undefined);
    assert.deepEqual(registry.active_contexts[keyA].operating_profile_task, firstA);
    assert.deepEqual(registry.active_contexts[keyB].operating_profile_task, leaseB);
    const siblingBefore = JSON.stringify(registry.active_contexts[keyB]);

    const secondA = setSessionTaskOperatingProfile(f.vault, 'session-1', 'ASSURE', {
      context: a, reason: 'route A escalated', leaseId: 'lease-a-2', now: '2026-08-22T08:02:00.000Z',
    });
    registry = readSessionRegistry(f.vault);
    assert.equal(registry.active_contexts[keyA].operating_profile_task.lease_id, secondA.lease_id);
    assert.equal(JSON.stringify(registry.active_contexts[keyB]), siblingBefore);

    assert.equal(consumeSessionTaskOperatingProfile(
      f.vault, 'session-1', firstA.lease_id, { context: a, now: '2026-08-22T08:03:00.000Z' },
    ), false);
    assert.equal(consumeSessionTaskOperatingProfile(
      f.vault, 'session-1', secondA.lease_id, { context: a, now: '2026-08-22T08:04:00.000Z' },
    ), true);
    registry = readSessionRegistry(f.vault);
    assert.equal(registry.active_contexts[keyA].operating_profile_task.state, 'consumed');
    assert.equal(registry.active_contexts[keyB].operating_profile_task.state, 'active');
    assert.equal(JSON.stringify(registry.active_contexts[keyB]), siblingBefore);
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:ACTX-21] failed contextual persistence preserves the registry byte-for-byte', () => {
  const f = fixture();
  try {
    const context = identity('worktree-a', 'work-a');
    mutateActiveContext(f.vault, context, (current) => current);
    const registryPath = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
    const before = readFileSync(registryPath);
    assert.throws(
      () => setSessionTaskOperatingProfile(f.vault, 'session-1', 'FLOW', {
        reason: 'missing causal context', leaseId: 'lease-global', now: '2026-08-22T08:00:00.000Z',
      }),
      (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_REQUIRED',
    );
    assert.deepEqual(readFileSync(registryPath), before);
    assert.throws(
      () => setSessionTaskOperatingProfile(f.vault, 'session-1', 'FLOW', {
        context,
        reason: 'must rollback',
        leaseId: 'lease-fails',
        now: '2026-08-22T08:00:00.000Z',
        mutateContext: () => { throw new Error('simulated contextual persistence failure'); },
      }),
      /simulated contextual persistence failure/,
    );
    assert.deepEqual(readFileSync(registryPath), before);
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:ACTX-21] an initialized contextual registry never applies a legacy session lease', () => {
  const f = fixture();
  try {
    const legacy = setSessionTaskOperatingProfile(f.vault, 'session-1', 'FLOW', {
      reason: 'legacy request', leaseId: 'legacy-lease', now: '2026-08-22T08:00:00.000Z',
    });
    assert.deepEqual(sessionTaskOperatingProfile(f.vault, 'session-1'), legacy);
    const context = identity('worktree-a', 'work-a');
    mutateActiveContext(f.vault, context, (current) => current);

    assert.equal(sessionTaskOperatingProfile(f.vault, 'session-1'), null);
    assert.equal(sessionTaskOperatingProfile(f.vault, 'session-1', { context }), null);
    const registry = readSessionRegistry(f.vault);
    assert.deepEqual(registry.sessions['session-1'].operating_profile_task, legacy);
    assert.equal(registry.active_contexts[activeContextKey(context)].operating_profile_task, undefined);
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:ACTX-21] an explicitly empty contextual registry disables legacy task leases', () => {
  const f = fixture();
  try {
    const registryPath = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
    const registry = readSessionRegistry(f.vault);
    registry.active_contexts_schema = 1;
    registry.active_contexts_revision = 0;
    registry.active_contexts = {};
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    const before = readFileSync(registryPath);

    assert.equal(sessionTaskOperatingProfile(f.vault, 'session-1'), null);
    assert.throws(
      () => setSessionTaskOperatingProfile(f.vault, 'session-1', 'FLOW', {
        reason: 'must not revive global fallback', leaseId: 'legacy-after-contexts',
        now: '2026-08-22T08:00:00.000Z',
      }),
      (error) => error?.code === 'WENDKEEP_ACTIVE_CONTEXT_REQUIRED',
    );
    assert.deepEqual(readFileSync(registryPath), before);
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:ACTX-19] a proven caller without a context record ignores a sibling and its legacy lease', () => {
  const f = fixture();
  try {
    setSessionTaskOperatingProfile(f.vault, 'session-1', 'FLOW', {
      reason: 'legacy request', leaseId: 'legacy-lease', now: '2026-08-22T08:00:00.000Z',
    });
    const caller = identity('worktree-a', 'work-a');
    const sibling = identity('worktree-a', 'work-b');
    mutateActiveContext(f.vault, sibling, (current) => current);

    assert.equal(sessionTaskOperatingProfile(f.vault, 'session-1', { context: caller }), null);
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:OP-11] store cria lease no prompt atual sem alterar perfil persistente, identidade ou nota', () => {
  const f = fixture();
  try {
    const noteBefore = readFileSync(f.note);
    const lease = setSessionTaskOperatingProfile(f.vault, 'session-1', 'FLOW', {
      reason: 'ajuste local reversível',
      leaseId: 'lease-flow-1',
      now: '2026-08-01T17:00:00.000Z',
    });
    assert.equal(lease.profile, 'FLOW');
    assert.equal(lease.request_turn_id, 'turn-5');
    assert.equal(lease.request_turn_sequence, 5);

    const entry = readSessionRegistry(f.vault).sessions['session-1'];
    assert.equal(entry.operating_profile, 'OFF');
    assert.equal(entry.operating_profile_source, 'explicit-cli');
    assert.deepEqual(entry.operating_profile_task, lease);
    assert.equal(entry.session_file, 'session.md');
    assert.deepEqual(readFileSync(f.note), noteBefore);
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:OP-11] [req:OP-12] leases reais recebem ids distintos, substituem e usam CAS por lease_id', () => {
  const f = fixture();
  try {
    const first = setSessionTaskOperatingProfile(f.vault, 'session-1', 'FLOW', {
      reason: 'primeira rota', now: '2026-08-01T17:00:00.000Z',
    });
    const second = setSessionTaskOperatingProfile(f.vault, 'session-1', 'GOVERN', {
      reason: 'risco descoberto', now: '2026-08-01T17:01:00.000Z',
    });
    assert.match(first.lease_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.match(second.lease_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.notEqual(first.lease_id, second.lease_id);
    assert.equal(consumeSessionTaskOperatingProfile(
      f.vault, 'session-1', first.lease_id, { now: '2026-08-01T17:02:00.000Z' },
    ), false);
    assert.equal(readSessionRegistry(f.vault).sessions['session-1'].operating_profile_task.state, 'active');
    assert.equal(consumeSessionTaskOperatingProfile(
      f.vault, 'session-1', second.lease_id, { now: '2026-08-01T17:03:00.000Z' },
    ), true);
    const consumed = readSessionRegistry(f.vault).sessions['session-1'].operating_profile_task;
    assert.equal(consumed.state, 'consumed');
    assert.equal(consumed.consumed_at, '2026-08-01T17:03:00.000Z');
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});

test('[req:OP-11] store rejeita sessão sem prompt causal sem criar estado parcial', () => {
  const f = fixture();
  try {
    const path = join(f.vault, '.brain', 'SESSION_REGISTRY.json');
    const registry = JSON.parse(readFileSync(path, 'utf8'));
    delete registry.sessions['session-1'].last_turn_sequence;
    writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    const before = readFileSync(path, 'utf8');
    assert.throws(
      () => setSessionTaskOperatingProfile(f.vault, 'session-1', 'FLOW', {
        reason: 'sem prompt', leaseId: 'lease-invalid', now: '2026-08-01T17:00:00.000Z',
      }),
      (error) => error?.code === 'WENDKEEP_TASK_PROFILE_CONTEXT_INVALID',
    );
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally { rmSync(f.vault, { recursive: true, force: true }); }
});
