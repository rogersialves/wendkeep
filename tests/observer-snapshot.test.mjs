import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { buildProjectSnapshot } from '../src/observer-snapshot.mjs';
import { makeObserverFixture } from './helpers/observer-fixture.mjs';

test('[req:OBS-1] [req:OBS-2] snapshot sanitizado resume changes sem copiar memória ou caminhos', () => {
  const first = makeObserverFixture({
    projectId: 'project-a',
    projectName: 'Project A',
    openTasks: ['Implement observer'],
  });
  const second = makeObserverFixture({
    projectId: 'project-b',
    projectName: 'Project B',
    openTasks: [],
    doneTasks: ['Already done'],
  });
  try {
    const snapshot = buildProjectSnapshot({
      vaultBase: first.vaultBase,
      projectRoot: first.projectRoot,
      now: '2026-08-16T12:00:00Z',
    });
    const other = buildProjectSnapshot({
      vaultBase: second.vaultBase,
      projectRoot: second.projectRoot,
      now: '2026-08-16T12:00:00Z',
    });

    assert.equal(snapshot.schema_version, 1);
    assert.equal(snapshot.projectId, 'project-a');
    assert.equal(snapshot.changes[0].openTasks, 1);
    assert.equal(other.changes[0].openTasks, 0);
    assert.equal(snapshot.project_id, 'project-a');
    assert.deepEqual(snapshot.sync, { status: 'disabled', pending: 0, open_conflicts: 0 });
    assert.match(snapshot.event_id, /^obs-/);
    assert.equal(JSON.stringify(snapshot).includes('CORE.md'), false);
    assert.equal(JSON.stringify(snapshot).includes('C:\\GitHub'), false);
    assert.equal(JSON.stringify(snapshot).includes('Implement observer'), false);
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test('[req:OBS-2] snapshot rejeita vault sem PROJECT.json', () => {
  const fixture = makeObserverFixture();
  try {
    rmSync(`${fixture.vaultBase}/.brain/PROJECT.json`);
    assert.throws(
      () => buildProjectSnapshot({ vaultBase: fixture.vaultBase, projectRoot: fixture.projectRoot }),
      /PROJECT\.json|project_id/i,
    );
  } finally {
    fixture.cleanup();
  }
});
