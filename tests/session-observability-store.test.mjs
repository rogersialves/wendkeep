import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  markObservabilityCheckpoint,
  observabilityStorePath,
  readObservabilityStore,
  recordObservabilitySignal,
  releaseObservabilityLease,
  tryAcquireObservabilityLease,
} from '../hooks/session-observability-store.mjs';

function createVault(prefix = 'wk-observability-store-') {
  const vault = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  return vault;
}

function signal(rolloutId) {
  return {
    rollout_id: rolloutId,
    transcript_path: `synthetic/rollouts/${rolloutId}.jsonl`,
    activation_id: 'activation-synthetic',
    activation_epoch: 1,
    turn_sequence: 2,
  };
}

test('[req:OBS-11] duplicate child signals do not advance sequence and new children do', () => {
  const vault = createVault();
  try {
    const first = recordObservabilitySignal(vault, 'session-synthetic', signal('child-c'));
    const duplicate = recordObservabilitySignal(vault, 'session-synthetic', signal('child-c'));
    const second = recordObservabilitySignal(vault, 'session-synthetic', signal('child-d'));

    assert.deepEqual(
      [first.sequence, duplicate.sequence, second.sequence],
      [1, 1, 2],
    );
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(second.state.observability_dirty, true);
    assert.equal(second.state.signals.length, 2);
    assert.deepEqual(
      readObservabilityStore(vault, 'session-synthetic').signals
        .map((entry) => entry.signal_sequence),
      [1, 2],
    );

    const persisted = JSON.parse(readFileSync(observabilityStorePath(
      vault,
      'session-synthetic',
    ), 'utf8'));
    assert.equal(persisted.observability_signal_sequence, 2);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OBS-11] signal metadata survives alias normalization and invalid kinds fail closed', () => {
  const vault = createVault();
  try {
    const recorded = recordObservabilitySignal(vault, 'session-synthetic', {
      rolloutId: 'child-c',
      transcriptPath: 'synthetic/rollouts/child-c.jsonl',
      parentRolloutId: ' root-a ',
      kind: ' STARTED ',
      timestamp: ' 2026-01-02T03:04:05.000Z ',
      agentPath: ' /root/child-c ',
    });

    assert.deepEqual(recorded.state.signals, [{
      rollout_id: 'child-c',
      transcript_path: 'synthetic/rollouts/child-c.jsonl',
      parent_thread_id: 'root-a',
      kind: 'started',
      timestamp: '2026-01-02T03:04:05.000Z',
      agent_path: '/root/child-c',
      signal_sequence: 1,
    }]);
    assert.deepEqual(
      readObservabilityStore(vault, 'session-synthetic').signals,
      recorded.state.signals,
    );
    assert.throws(
      () => recordObservabilitySignal(vault, 'session-synthetic', {
        rollout_id: 'child-d',
        kind: 'spawn-requested',
      }),
      (error) => error?.code === 'OBSERVABILITY_SIGNAL_INVALID',
    );
    assert.equal(
      readObservabilityStore(vault, 'session-synthetic').observability_signal_sequence,
      1,
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OBS-11] lease for signal 1 loses to signal 2 and stale workers cannot release it', () => {
  const vault = createVault();
  try {
    recordObservabilitySignal(vault, 'session-synthetic', signal('child-c'));
    const first = tryAcquireObservabilityLease(vault, 'session-synthetic', {
      signalSequence: 1,
      ownerToken: 'worker-1',
      now: 1_000,
      ttlMs: 10_000,
    });
    assert.equal(first.acquired, true);

    recordObservabilitySignal(vault, 'session-synthetic', signal('child-d'));
    const stale = tryAcquireObservabilityLease(vault, 'session-synthetic', {
      signalSequence: 1,
      ownerToken: 'worker-1',
      now: 1_100,
      ttlMs: 10_000,
    });
    const winner = tryAcquireObservabilityLease(vault, 'session-synthetic', {
      signalSequence: 2,
      ownerToken: 'worker-2',
      now: 1_100,
      ttlMs: 10_000,
    });

    assert.deepEqual({ acquired: stale.acquired, reason: stale.reason }, {
      acquired: false,
      reason: 'stale-signal',
    });
    assert.equal(winner.acquired, true);
    assert.equal(winner.state.lease.owner_token, 'worker-2');
    assert.equal(releaseObservabilityLease(
      vault,
      'session-synthetic',
      { ownerToken: 'worker-1' },
    ).released, false);
    assert.equal(releaseObservabilityLease(
      vault,
      'session-synthetic',
      { ownerToken: 'worker-2' },
    ).released, true);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OBS-12] checkpoint clears dirty only after catching the newest signal', () => {
  const vault = createVault();
  try {
    recordObservabilitySignal(vault, 'session-synthetic', signal('child-c'));
    recordObservabilitySignal(vault, 'session-synthetic', signal('child-d'));

    const behind = markObservabilityCheckpoint(vault, 'session-synthetic', {
      checkpointSequence: 1,
      frontier: { source_manifest_hash: 'manifest-a' },
    });
    const caughtUp = markObservabilityCheckpoint(vault, 'session-synthetic', {
      checkpointSequence: 2,
      frontier: { source_manifest_hash: 'manifest-b' },
    });

    assert.equal(behind.observability_dirty, true);
    assert.equal(caughtUp.observability_dirty, false);
    assert.equal(caughtUp.observability_checkpoint_sequence, 2);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OBS-12] corrupt derived cache is discarded and reconstructed on the next signal', () => {
  const vault = createVault();
  try {
    const path = observabilityStorePath(vault, 'session-synthetic');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{not-json', 'utf8');

    const recovered = readObservabilityStore(vault, 'session-synthetic');
    assert.equal(recovered.reconstructed, true);
    assert.deepEqual(recovered.diagnostics, [{ code: 'CACHE_INVALID', count: 1 }]);
    assert.equal(recovered.observability_signal_sequence, 0);
    assert.equal(recovered.observability_dirty, true);

    const next = recordObservabilitySignal(vault, 'session-synthetic', signal('child-c'));
    assert.equal(next.sequence, 1);
    assert.doesNotThrow(() => JSON.parse(readFileSync(path, 'utf8')));
    assert.deepEqual(readdirSync(dirname(path)).filter((name) => /\.tmp$|\.lock$/.test(name)), []);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OBS-12] store uses a deterministic opaque sha256 filename', () => {
  const vault = createVault();
  try {
    const path = observabilityStorePath(vault, 'session-name-that-must-not-leak');
    assert.match(basename(path), /^[a-f0-9]{64}\.json$/);
    assert.equal(path.includes('session-name-that-must-not-leak'), false);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OBS-12] store rejects a hardlinked target instead of reading or replacing it', () => {
  const vault = createVault();
  try {
    const path = observabilityStorePath(vault, 'session-synthetic');
    mkdirSync(dirname(path), { recursive: true });
    const source = join(dirname(path), 'source.json');
    writeFileSync(source, '{}\n');
    linkSync(source, path);

    assert.throws(
      () => readObservabilityStore(vault, 'session-synthetic'),
      (error) => error?.code === 'OBSERVABILITY_STORE_PATH_UNSAFE',
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OBS-12] store rejects a symlinked runtime directory', (t) => {
  const vault = createVault();
  const outside = mkdtempSync(join(tmpdir(), 'wk-observability-outside-'));
  try {
    const runtime = join(vault, '.brain', 'runtime');
    mkdirSync(runtime, { recursive: true });
    const storeDir = join(runtime, 'session-observability');
    try {
      symlinkSync(outside, storeDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error?.code === 'EPERM') {
        t.skip('symlink/junction creation unavailable');
        return;
      }
      throw error;
    }

    assert.equal(existsSync(storeDir), true);
    assert.throws(
      () => recordObservabilitySignal(vault, 'session-synthetic', signal('child-c')),
      (error) => error?.code === 'OBSERVABILITY_STORE_PATH_UNSAFE',
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
