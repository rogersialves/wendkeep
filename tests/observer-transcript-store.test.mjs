import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  ensureObserverDatabase,
  ingestObserverEvents,
  readTranscript,
  registerSqlProject,
} from '../src/observer-sql-store.mjs';
import { makeDataDir } from './helpers/observer-fixture.mjs';

test('[req:SQL-OBS-4] transcript completo é comprimido, hashado e lido integralmente', () => {
  const dataDir = makeDataDir();
  const db = ensureObserverDatabase(dataDir);
  try {
    registerSqlProject(db, { projectId: 'project-a', projectName: 'Projeto A' });
    const transcript = JSON.stringify({ type: 'rollout', messages: [{ role: 'user', content: 'Olá' }, { role: 'assistant', content: 'Resposta' }] });
    const result = ingestObserverEvents(db, {
      projectId: 'project-a',
      events: [{
        schema_version: 1,
        event_id: 'transcript-1',
        kind: 'transcript.upsert',
        project_id: 'project-a',
        occurred_at: '2026-08-17T12:00:00.000Z',
        payload: { transcript_id: 'transcript-a', session_id: 'session-a', agent_id: 'agent-main', content: transcript, coverage: 'complete', source: 'test' },
      }],
    });
    assert.equal(result.accepted, 1);
    const restored = readTranscript(db, 'project-a', 'transcript-a');
    assert.equal(restored.coverage, 'complete');
    assert.equal(restored.content, transcript);
    assert.ok(restored.content_sha256);
    assert.ok(restored.compressed_bytes < Buffer.byteLength(transcript) + 100);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
