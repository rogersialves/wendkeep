import assert from 'node:assert/strict';
import fs, {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  loadEvidenceSearchState,
  refreshEvidenceIndex,
  refreshEvidenceSearchIndex,
} from '../hooks/evidence-recall.mjs';
import {
  buildProjectSnapshot,
  validateObserverSnapshot,
} from '../src/observer-snapshot.mjs';
import {
  ensureObserverDatabase,
  readSqlProjectOverview,
  registerSqlProject,
  upsertSqlProjectSnapshot,
} from '../src/observer-sql-store.mjs';
import { renderCoreSkeleton } from '../src/validate-core.mjs';
import {
  makeDataDir,
  makeObserverFixture,
} from './helpers/observer-fixture.mjs';

const PROJECT_ID = 'observer-evidence-search';
const MARKER = 'marcador-privado-observer-recall';

function prepareFixture() {
  const fixture = makeObserverFixture({
    projectId: PROJECT_ID,
    projectName: 'Observer Evidence Search',
  });
  writeFileSync(
    join(fixture.vaultBase, '.brain', 'CORE.md'),
    renderCoreSkeleton(),
  );
  mkdirSync(join(fixture.vaultBase, '04-Decisões'), { recursive: true });
  return fixture;
}

function writeDecision(vaultBase, body) {
  const path = join(vaultBase, '04-Decisões', 'ADR-observer-recall.md');
  writeFileSync(path, [
    '---',
    'title: Métrica do Observer',
    'authority: verified',
    'validity: active',
    'date: 2026-08-27',
    '---',
    '# Métrica do Observer',
    '',
    '## Evidência',
    '',
    body,
    '',
  ].join('\n'));
  return path;
}

function buildSearch(vaultBase) {
  const index = refreshEvidenceIndex(vaultBase);
  const search = refreshEvidenceSearchIndex(vaultBase, index.chunks, {
    force: true,
    sqlite: 'off',
  });
  return { index, search };
}

test('[req:RECALL-10] [req:OBS-RECALL-1] Observer persists sanitized recall index health in project snapshots', () => {
  const fixture = prepareFixture();
  const dataDir = makeDataDir();
  let db;
  try {
    writeDecision(fixture.vaultBase, `A evidência contém ${MARKER}.`);
    const built = buildSearch(fixture.vaultBase);
    const authorityPath = resolve(fixture.vaultBase, '.brain', 'EVIDENCE_INDEX.jsonl');
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = function guardedReadFileSync(path, ...args) {
      if (resolve(String(path)) === authorityPath) {
        throw Object.assign(new Error('Observer read the full evidence authority'), {
          code: 'EVIDENCE_AUTHORITY_READ_FORBIDDEN',
        });
      }
      return originalReadFileSync.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    let snapshot;
    try {
      snapshot = buildProjectSnapshot({
        vaultBase: fixture.vaultBase,
        projectRoot: fixture.projectRoot,
        now: '2026-08-27T01:00:00.000Z',
      });
    } finally {
      fs.readFileSync = originalReadFileSync;
      syncBuiltinESMExports();
    }
    const recall = snapshot.health.recall_search;

    assert.equal(recall.schema_version, 1);
    assert.equal(recall.status, 'healthy');
    assert.deepEqual(recall.authority, {
      status: 'present',
      bytes: recall.authority.bytes,
    });
    assert.ok(recall.authority.bytes > 0);
    assert.equal(recall.incremental.status, 'ok');
    assert.ok(recall.incremental.documents >= 3);
    assert.equal(recall.search.status, 'current');
    assert.equal(recall.search.chunks, built.index.chunks.length);
    assert.equal(recall.search.source_index_current, true);
    assert.equal(recall.search.source_state_current, true);
    assert.equal(recall.lexical.status, 'current');
    assert.ok(recall.lexical.bytes > recall.authority.bytes);
    assert.equal(recall.sqlite.status, 'not-built');
    assert.equal(recall.sqlite.bytes, 0);
    assert.equal(recall.backend, 'lexical-sidecar');
    assert.equal(validateObserverSnapshot(snapshot, { projectId: PROJECT_ID }).ok, true);

    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes(fixture.vaultBase), false);
    assert.equal(serialized.includes(MARKER), false);
    assert.equal(serialized.includes('ADR-observer-recall.md'), false);

    db = ensureObserverDatabase(dataDir);
    const registered = registerSqlProject(db, {
      projectId: PROJECT_ID,
      projectName: fixture.projectName,
      wendkeepVersion: snapshot.wendkeep_version,
    });
    assert.equal(registered.registered, true);
    assert.equal(upsertSqlProjectSnapshot(db, snapshot).accepted, true);
    const overview = readSqlProjectOverview(db, PROJECT_ID);
    assert.deepEqual(overview.snapshot.health.recall_search, recall);
  } finally {
    db?.close();
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:RECALL-10] [req:OBS-RECALL-2] stale authority is published as bounded metadata without rebuilding', () => {
  const fixture = prepareFixture();
  try {
    writeDecision(fixture.vaultBase, 'A evidência contém sinal-antigo-observer.');
    buildSearch(fixture.vaultBase);
    const statePath = join(fixture.vaultBase, '.brain', 'EVIDENCE_SEARCH_STATE.json');
    const stateBefore = readFileSync(statePath);

    writeDecision(fixture.vaultBase, 'A evidência agora contém sinal-novo-observer.');
    refreshEvidenceIndex(fixture.vaultBase);
    const snapshot = buildProjectSnapshot({
      vaultBase: fixture.vaultBase,
      projectRoot: fixture.projectRoot,
      now: '2026-08-27T01:10:00.000Z',
    });
    const recall = snapshot.health.recall_search;

    assert.equal(recall.status, 'warning');
    assert.equal(recall.search.status, 'stale');
    assert.equal(recall.search.source_index_current, false);
    assert.equal(recall.backend, 'lexical-ephemeral');
    assert.deepEqual(readFileSync(statePath), stateBefore);
    assert.equal(validateObserverSnapshot(snapshot, { projectId: PROJECT_ID }).ok, true);
  } finally {
    fixture.cleanup();
  }
});

test('[req:RECALL-10] [req:OBS-RECALL-3] unsafe recall artifact publishes only blocked sanitized metadata', (t) => {
  const fixture = prepareFixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-observer-recall-outside-'));
  try {
    writeDecision(fixture.vaultBase, `A evidência contém ${MARKER}.`);
    buildSearch(fixture.vaultBase);
    const state = loadEvidenceSearchState(fixture.vaultBase);
    const artifact = join(fixture.vaultBase, '.brain', ...state.lexical.path.split('/'));
    try {
      linkSync(artifact, join(outside, 'recall-hardlink.json'));
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
        t.skip(`hardlinks indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    const snapshot = buildProjectSnapshot({
      vaultBase: fixture.vaultBase,
      projectRoot: fixture.projectRoot,
      now: '2026-08-27T01:20:00.000Z',
    });
    const recall = snapshot.health.recall_search;
    assert.equal(recall.status, 'blocked');
    assert.equal(recall.error_code, 'VAULT_PATH_UNSAFE');
    assert.equal(validateObserverSnapshot(snapshot, { projectId: PROJECT_ID }).ok, true);

    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes(fixture.vaultBase), false);
    assert.equal(serialized.includes(outside), false);
    assert.equal(serialized.includes(MARKER), false);
    assert.equal(serialized.includes('recall-hardlink.json'), false);
  } finally {
    fixture.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});
