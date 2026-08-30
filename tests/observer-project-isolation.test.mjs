import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensureObserverDatabase,
  ingestObserverEvents,
  migrateObserverDatabase,
  openObserverDatabase,
  registerSqlProject,
} from '../src/observer-sql-store.mjs';
import { makeDataDir } from './helpers/observer-fixture.mjs';

const SCHEMA = new URL('../schema/observer/', import.meta.url);

function event(kind, eventId, projectId, payload) {
  return {
    schema_version: 1,
    event_id: eventId,
    kind,
    project_id: projectId,
    occurred_at: '2026-08-20T12:00:00.000Z',
    payload,
  };
}

function projectEvents(projectId, suffix) {
  const session = { session_id: 'shared-session', provider: suffix, status: 'done' };
  const agent = { ...session, agent_id: 'shared-agent', role: 'main', model: `model-${suffix}` };
  return [
    event('session.upsert', `${projectId}-session`, projectId, session),
    event('agent.upsert', `${projectId}-agent`, projectId, agent),
    event('usage.rollup', `${projectId}-usage`, projectId, {
      ...agent,
      rollup_key: 'shared-rollup',
      revision: 1,
      calls: 1,
      tokens: { total: suffix === 'a' ? 10 : 20 },
    }),
    event('llm_call', `${projectId}-call-event`, projectId, {
      ...agent,
      call_id: 'shared-call',
      transcript_id: 'shared-transcript',
      prompt_text: `prompt-${suffix}`,
    }),
    event('transcript.upsert', `${projectId}-transcript-event`, projectId, {
      ...agent,
      transcript_id: 'shared-transcript',
      content: `transcript-${suffix}`,
    }),
  ];
}

test('[req:SQL-ISO-1] external identities may repeat across projects without sharing rows', () => {
  const dataDir = makeDataDir();
  const db = ensureObserverDatabase(dataDir);
  try {
    registerSqlProject(db, { projectId: 'project-a' });
    registerSqlProject(db, { projectId: 'project-b' });
    assert.equal(ingestObserverEvents(db, { projectId: 'project-a', events: projectEvents('project-a', 'a') }).accepted, 5);
    assert.equal(ingestObserverEvents(db, { projectId: 'project-b', events: projectEvents('project-b', 'b') }).accepted, 5);

    for (const table of ['sessions', 'agent_runs', 'usage_rollups', 'llm_calls', 'transcripts']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 2, table);
    }
    assert.equal(db.prepare('SELECT provider FROM sessions WHERE project_id = ? AND session_id = ?').get('project-a', 'shared-session').provider, 'a');
    assert.equal(db.prepare('SELECT provider FROM sessions WHERE project_id = ? AND session_id = ?').get('project-b', 'shared-session').provider, 'b');
    assert.equal(db.prepare('SELECT prompt_text FROM llm_calls WHERE project_id = ? AND call_id = ?').get('project-a', 'shared-call').prompt_text, 'prompt-a');
    assert.equal(db.prepare('SELECT prompt_text FROM llm_calls WHERE project_id = ? AND call_id = ?').get('project-b', 'shared-call').prompt_text, 'prompt-b');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:SQL-ATOMIC-1] a failed event rolls back every projection and remains retryable', () => {
  const dataDir = makeDataDir();
  const db = ensureObserverDatabase(dataDir);
  try {
    registerSqlProject(db, { projectId: 'project-a' });
    db.exec(`CREATE TRIGGER synthetic_ingest_failure
      BEFORE INSERT ON memory_events
      WHEN NEW.event_id = 'partial-event'
      BEGIN SELECT RAISE(ABORT, 'synthetic mid-event failure'); END`);
    const payload = { logical_path: '04-Decisões/atomic.md', content: '# Atomic', revision: 1 };
    const failed = ingestObserverEvents(db, {
      projectId: 'project-a',
      events: [event('document.upsert', 'partial-event', 'project-a', payload)],
    });
    assert.equal(failed.rejected, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ingest_events').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memory_events').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM document_chunks').get().count, 0);

    db.exec('DROP TRIGGER synthetic_ingest_failure');
    const retry = ingestObserverEvents(db, {
      projectId: 'project-a',
      events: [event('document.upsert', 'partial-event', 'project-a', payload)],
    });
    assert.equal(retry.accepted, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 1);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:SQL-MIGRATE-1] structural migration is backed up, checksummed and resumable', () => {
  const dataDir = makeDataDir();
  const db = openObserverDatabase(dataDir);
  try {
    for (let version = 1; version <= 5; version += 1) {
      const name = readdirSync(SCHEMA).find((file) => file.startsWith(`${String(version).padStart(3, '0')}-`));
      db.exec(readFileSync(new URL(name, SCHEMA), 'utf8'));
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
        .run(version, name, '2026-08-20T00:00:00.000Z');
    }
    db.prepare(`INSERT INTO projects(project_id, project_name, registered_at, updated_at)
      VALUES ('project-a', 'Project A', '2026-08-20', '2026-08-20')`).run();
    db.prepare(`INSERT INTO sessions(session_id, project_id, updated_at)
      VALUES ('session-a', 'project-a', '2026-08-20')`).run();

    const migrated = migrateObserverDatabase(db);
    assert.equal(migrated.version, 6);
    assert.equal(migrated.backups.length, 1);
    assert.equal(readdirSync(dataDir).some((name) => /observer\.sqlite\.pre-006-\d+\.bak/.test(name)), true);
    assert.equal(migrated.applied.every((item) => /^[a-f0-9]{64}$/.test(item.checksum)), true);
    assert.equal(db.prepare('SELECT session_id FROM sessions WHERE project_id = ?').get('project-a').session_id, 'session-a');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

    const replay = migrateObserverDatabase(db);
    assert.equal(replay.version, 6);
    assert.equal(replay.backups.length, 0);
    db.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1").run();
    assert.throws(
      () => migrateObserverDatabase(db),
      (error) => error.code === 'WENDKEEP_OBSERVER_MIGRATION_CHECKSUM_MISMATCH',
    );
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
