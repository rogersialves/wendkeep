import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  appendObserverEvent,
  readObserverIndex,
  rebuildObserverIndex,
  registerObserverProject,
} from '../src/observer-store.mjs';
import { buildProjectSnapshot } from '../src/observer-snapshot.mjs';
import { makeDataDir, makeObserverFixture } from './helpers/observer-fixture.mjs';

test('[req:OBS-3] [req:OBS-4] store deduplica eventos e mantém isolamento por projeto', () => {
  const dataDir = makeDataDir();
  const first = makeObserverFixture({ projectId: 'project-a' });
  const second = makeObserverFixture({ projectId: 'project-b', slug: 'change-b' });
  try {
    registerObserverProject(dataDir, { projectId: first.projectId, projectName: first.projectName });
    registerObserverProject(dataDir, { projectId: second.projectId, projectName: second.projectName });
    const event = buildProjectSnapshot({ vaultBase: first.vaultBase, projectRoot: first.projectRoot, now: '2026-08-16T12:00:00Z' });

    const accepted = appendObserverEvent(dataDir, event);
    const duplicate = appendObserverEvent(dataDir, event);
    assert.equal(accepted.accepted, true);
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(readObserverIndex(dataDir).projects.map((p) => p.projectId), ['project-a']);

    const unknown = appendObserverEvent(dataDir, { ...event, event_id: 'obs-unknown', project_id: 'project-c' });
    assert.equal(unknown.accepted, false);
    assert.match(unknown.errors.join(' '), /registr|project/i);

    const newer = { ...event, event_id: 'obs-newer', captured_at: '2026-08-16T13:00:00Z' };
    appendObserverEvent(dataDir, newer);
    const older = { ...event, event_id: 'obs-older', captured_at: '2026-08-16T11:00:00Z' };
    appendObserverEvent(dataDir, older);
    const current = readObserverIndex(dataDir).projects.find((p) => p.projectId === 'project-a');
    assert.equal(current.latestEventId, 'obs-newer');
    assert.equal(current.capturedAt, '2026-08-16T13:00:00Z');

    const future = appendObserverEvent(dataDir, { ...event, event_id: 'obs-future', schema_version: 999 });
    assert.equal(future.accepted, false);
    rmSync(`${dataDir}/INDEX.json`);
    const rebuilt = rebuildObserverIndex(dataDir);
    assert.equal(rebuilt.projects[0].latestEventId, 'obs-newer');
    assert.deepEqual(readObserverIndex(dataDir).projects.map((p) => p.projectId), ['project-a']);
  } finally {
    first.cleanup();
    second.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
