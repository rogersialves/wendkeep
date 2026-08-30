import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeTranscript, encodeTranscript } from './observer-transcript-store.mjs';
import { decryptObserverValue, encryptObserverValue } from '../packages/observer/src/encryption.mjs';
import { protectObserverEvent, readObserverPolicy } from '../packages/observer/src/policy.mjs';
import {
  chunkMarkdownDocument, recallEvidence, recallTerms,
} from '../packages/vault/src/evidence-recall.mjs';
import { planNativeControlPlaneMigration } from '../packages/migrations/src/index.mjs';

export const OBSERVER_SQL_FILE = 'observer.sqlite';
export const OBSERVER_SQL_SCHEMA_VERSION = 6;
export const OBSERVER_EVENT_SCHEMA_VERSION = 1;

const SCHEMA_DIR = fileURLToPath(new URL('../schema/observer/', import.meta.url));
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/;
const EVENT_KINDS = new Set([
  'document.upsert', 'document.delete', 'session.upsert', 'agent.upsert',
  'usage.rollup', 'llm_call', 'transcript.upsert',
]);

const OBSERVER_SQL_MINIMUM_NODE = '22.13.0';
const require = createRequire(import.meta.url);
let DatabaseSync;
const DATABASE_PATHS = new WeakMap();
const DATABASE_SECURITY = new WeakMap();

export function configureObserverDatabaseSecurity(db, { policy = null, encryption = null, enforcePolicy = false } = {}) {
  if (!db) throw new Error('db é obrigatório.');
  DATABASE_SECURITY.set(db, { policy, encryption, enforcePolicy: Boolean(enforcePolicy) });
  return { policy: Boolean(policy) || Boolean(enforcePolicy), encryption: Boolean(encryption) };
}

function databaseSecurity(db) {
  return DATABASE_SECURITY.get(db) || { policy: null, encryption: null, enforcePolicy: false };
}

function encryptedJson(encryption, value, aad) {
  return encryption ? json(encryptObserverValue(encryption, json(value), { aad })) : '';
}

function encryptedText(encryption, value, aad) {
  return encryption ? json(encryptObserverValue(encryption, text(value), { aad })) : '';
}

function decryptedJson(encryption, envelope, fallback, aad) {
  return envelope ? parseJson(decryptObserverValue(encryption, parseJson(envelope), { aad }), fallback) : fallback;
}

export function observerSqlRuntimeSupport(version = process.versions.node) {
  const current = String(version || '0.0.0');
  const [major = 0, minor = 0] = current.split('.').map((part) => Number(part) || 0);
  return {
    supported: major > 22 || (major === 22 && minor >= 13),
    minimum: OBSERVER_SQL_MINIMUM_NODE,
    current,
  };
}

function observerSqlRuntimeError(support = observerSqlRuntimeSupport()) {
  const error = new Error(`Observer SQL requer Node.js >= ${support.minimum}; atual: ${support.current}. O Keep Core continua compatível com Node.js >= 18.`);
  error.code = 'WENDKEEP_OBSERVER_NODE_UNSUPPORTED';
  return error;
}

function observerDatabaseSync() {
  const support = observerSqlRuntimeSupport();
  if (!support.supported) throw observerSqlRuntimeError(support);
  if (!DatabaseSync) {
    try { ({ DatabaseSync } = require('node:sqlite')); }
    catch { throw observerSqlRuntimeError(support); }
  }
  return DatabaseSync;
}

function now() { return new Date().toISOString(); }

function text(value, fallback = '') { return String(value ?? fallback); }

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function integer(value, fallback = 0) {
  return Math.max(0, Math.trunc(number(value, fallback)));
}

function json(value, fallback = {}) {
  try { return JSON.stringify(value ?? fallback); } catch { return JSON.stringify(fallback); }
}

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || JSON.stringify(fallback)); } catch { return fallback; }
}

function hash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : json(value)).digest('hex');
}

function scopedIdentity(projectId, externalId) {
  return `${projectId}\u001f${externalId}`;
}

function validProjectId(value) { return typeof value === 'string' && PROJECT_ID_RE.test(value); }

function requireProject(db, projectId) {
  if (!validProjectId(projectId)) throw new Error('project_id inválido.');
  const project = db.prepare('SELECT project_id FROM projects WHERE project_id = ?').get(projectId);
  if (!project) {
    const error = new Error(`project_id não registrado: ${projectId}`);
    error.code = 'project_not_registered';
    throw error;
  }
  return project;
}

function migrationFiles() {
  return readdirSync(SCHEMA_DIR)
    .filter((name) => /^\d+-.*\.sql$/i.test(name))
    .sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]));
}

export function openObserverDatabase(dataDir) {
  if (!dataDir) throw new Error('dataDir é obrigatório.');
  mkdirSync(dataDir, { recursive: true });
  const SqliteDatabase = observerDatabaseSync();
  const databasePath = join(dataDir, OBSERVER_SQL_FILE);
  const db = new SqliteDatabase(databasePath);
  DATABASE_PATHS.set(db, databasePath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  return db;
}

function encryptedStructuralBackup(db, databasePath, version, encryption) {
  if (!encryption) throw Object.assign(new Error('Migração estrutural exige chave para backup protegido.'), { code: 'observer_encryption_required' });
  const prefix = `${databasePath}.pre-${String(version).padStart(3, '0')}-${Date.now()}.bak`;
  const temporaryPath = `${prefix}.tmp`;
  const encryptedPath = `${prefix}.enc`;
  const manifestPath = `${encryptedPath}.manifest.json`;
  const aad = `observer-backup:${basename(databasePath)}:${version}`;
  try {
    db.exec(`VACUUM INTO '${temporaryPath.replaceAll("'", "''")}'`);
    try { chmodSync(temporaryPath, 0o600); } catch { /* best effort on Windows */ }
    const plaintext = readFileSync(temporaryPath);
    const envelope = encryptObserverValue(encryption, plaintext.toString('base64'), { aad });
    writeFileSync(encryptedPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    writeFileSync(manifestPath, `${JSON.stringify({
      schema_version: 1,
      encrypted_file: basename(encryptedPath),
      algorithm: envelope.algorithm,
      key_id: envelope.key_id,
      aad,
      plaintext_sha256: createHash('sha256').update(plaintext).digest('hex'),
      source_database: basename(databasePath),
      target_schema_version: version,
      created_at: now(),
    }, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(encryptedPath, 0o600); chmodSync(manifestPath, 0o600); } catch { /* best effort on Windows */ }
    return encryptedPath;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function restoreObserverEncryptedBackup({ backupPath, destinationPath, encryption } = {}) {
  if (!backupPath || !destinationPath || !encryption) throw new Error('backupPath, destinationPath e encryption são obrigatórios.');
  const manifest = parseJson(readFileSync(`${backupPath}.manifest.json`, 'utf8'), null);
  if (!manifest || manifest.encrypted_file !== basename(backupPath)) throw Object.assign(new Error('Manifest do backup inválido.'), { code: 'observer_backup_manifest_invalid' });
  const envelope = parseJson(readFileSync(backupPath, 'utf8'), null);
  const plaintext = Buffer.from(decryptObserverValue(encryption, envelope, { aad: manifest.aad }), 'base64');
  if (createHash('sha256').update(plaintext).digest('hex') !== manifest.plaintext_sha256) throw Object.assign(new Error('Integridade do backup inválida.'), { code: 'observer_backup_integrity_invalid' });
  writeFileSync(destinationPath, plaintext, { mode: 0o600 });
  try { chmodSync(destinationPath, 0o600); } catch { /* best effort on Windows */ }
  return { restored: true, destination_path: destinationPath, sha256: manifest.plaintext_sha256 };
}

export function migrateObserverDatabase(db, { backupEncryption = null, requireEncryptedBackup = false } = {}) {
  if (!db) throw new Error('db é obrigatório.');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const migrationColumns = db.prepare('PRAGMA table_info(schema_migrations)').all().map((row) => row.name);
  if (!migrationColumns.includes('checksum')) db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT NOT NULL DEFAULT ''");
  const appliedRows = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
  const applied = new Map(appliedRows.map((row) => [Number(row.version), row]));
  const sourceVersion = appliedRows.length ? Number(appliedRows.at(-1).version) : 0;
  for (let version = 1; version <= sourceVersion; version += 1) {
    if (!applied.has(version)) {
      throw Object.assign(
        new Error(`Observer migration history has a gap before version ${version}.`),
        { code: 'WENDKEEP_MIGRATION_STATE_DIVERGED' },
      );
    }
  }
  const migrationPlan = planNativeControlPlaneMigration('observer', sourceVersion);
  const plannedVersions = new Set(migrationPlan.steps.map((version) => version + 1));
  const backups = [];
  for (const file of migrationFiles()) {
    const version = Number(file.split('-')[0]);
    const sql = readFileSync(join(SCHEMA_DIR, file), 'utf8');
    const checksum = hash(sql);
    const previous = applied.get(version);
    if (previous) {
      if (previous.name !== file || (previous.checksum && previous.checksum !== checksum)) {
        const error = new Error(`Checksum da migração ${version} não corresponde ao arquivo ${file}.`);
        error.code = 'WENDKEEP_OBSERVER_MIGRATION_CHECKSUM_MISMATCH';
        throw error;
      }
      if (!previous.checksum) {
        db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run(checksum, version);
      }
      continue;
    }
    if (!plannedVersions.has(version)) {
      throw Object.assign(
        new Error(`Observer migration ${version} is outside the canonical migration plan.`),
        { code: 'WENDKEEP_MIGRATION_STATE_DIVERGED' },
      );
    }
    if (/^\s*--\s*wendkeep:structural\b/m.test(sql) && applied.size > 0) {
      const databasePath = DATABASE_PATHS.get(db);
      if (!databasePath) throw new Error('Caminho do Observer desconhecido para backup estrutural.');
      const backupPath = requireEncryptedBackup
        ? encryptedStructuralBackup(db, databasePath, version, backupEncryption)
        : `${databasePath}.pre-${String(version).padStart(3, '0')}-${Date.now()}.bak`;
      if (!requireEncryptedBackup) {
        const escaped = backupPath.replaceAll("'", "''");
        db.exec(`VACUUM INTO '${escaped}'`);
      }
      backups.push(backupPath);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at, checksum) VALUES (?, ?, ?, ?)').run(version, file, now(), checksum);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  rebuildSqlEvidenceIndex(db, { missingOnly: true });
  return {
    version: Number(db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version || 0),
    applied: db.prepare('SELECT version, name, applied_at, checksum FROM schema_migrations ORDER BY version').all(),
    backups,
    migration_plan: migrationPlan,
  };
}

export function observerFts5Support(db) {
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS evidence_chunks_fts USING fts5(
      chunk_id UNINDEXED,
      project_id UNINDEXED,
      logical_path,
      title,
      heading,
      content,
      tokenize = 'unicode61 remove_diacritics 2'
    )`);
    return { supported: true, engine: 'fts5' };
  } catch (error) {
    return { supported: false, engine: 'lexical-fallback', reason: text(error?.message || error) };
  }
}

function synchronizeSqlFts(db) {
  const support = observerFts5Support(db);
  if (!support.supported) return support;
  const chunks = Number(db.prepare('SELECT COUNT(*) AS count FROM document_chunks').get().count || 0);
  const indexed = Number(db.prepare('SELECT COUNT(*) AS count FROM evidence_chunks_fts').get().count || 0);
  if (chunks === indexed) return support;
  db.exec(`DELETE FROM evidence_chunks_fts;
    INSERT INTO evidence_chunks_fts(chunk_id, project_id, logical_path, title, heading, content)
    SELECT chunk_id, project_id, logical_path, title, heading, content
    FROM document_chunks;`);
  return { ...support, rebuilt: true, chunks };
}

function writeSqlDocumentChunks(db, {
  projectId, logicalPath, content, metadata = {}, entityType = 'document', capturedAt = '',
} = {}) {
  const chunks = chunkMarkdownDocument({
    projectId,
    logicalPath,
    content,
    metadata: { ...metadata, observed_at: metadata.observed_at || capturedAt },
    entityType,
  });
  db.prepare('DELETE FROM document_chunks WHERE project_id = ? AND logical_path = ?').run(projectId, logicalPath);
  const fts = observerFts5Support(db);
  if (fts.supported) {
    db.prepare('DELETE FROM evidence_chunks_fts WHERE project_id = ? AND logical_path = ?').run(projectId, logicalPath);
  }
  const insert = db.prepare(`INSERT INTO document_chunks(
    chunk_id, project_id, logical_path, title, heading, entity_type, change_slug,
    session_id, work_session_id, authority, observed_at, validity, content_hash, ordinal, content
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertFts = fts.supported
    ? db.prepare('INSERT INTO evidence_chunks_fts(chunk_id, project_id, logical_path, title, heading, content) VALUES (?, ?, ?, ?, ?, ?)')
    : null;
  for (const chunk of chunks) {
    insert.run(
      chunk.chunk_id, chunk.project_id, chunk.logical_path, chunk.title, chunk.heading,
      chunk.entity_type, chunk.change_slug, chunk.session_id, chunk.work_session_id,
      chunk.authority, chunk.observed_at, chunk.validity, chunk.content_hash,
      chunk.ordinal, chunk.content,
    );
    insertFts?.run(chunk.chunk_id, chunk.project_id, chunk.logical_path, chunk.title, chunk.heading, chunk.content);
  }
  return { chunks: chunks.length, fts };
}

export function rebuildSqlEvidenceIndex(db, { missingOnly = false } = {}) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_chunks'").get();
  if (!table) return { documents: 0, chunks: 0, fts: { supported: false, engine: 'unavailable' } };
  const documents = db.prepare(`SELECT d.project_id, d.logical_path, d.content, d.metadata_json, d.entity_type, d.captured_at
    FROM documents d
    WHERE d.deleted_at IS NULL
      AND COALESCE(d.content_envelope, '') = ''
      AND (? = 0 OR NOT EXISTS (
        SELECT 1 FROM document_chunks c
        WHERE c.project_id = d.project_id AND c.logical_path = d.logical_path
      ))
    ORDER BY d.project_id, d.logical_path`).all(missingOnly ? 1 : 0);
  let chunks = 0;
  let fts = observerFts5Support(db);
  for (const document of documents) {
    const result = writeSqlDocumentChunks(db, {
      projectId: document.project_id,
      logicalPath: document.logical_path,
      content: document.content,
      metadata: parseJson(document.metadata_json),
      entityType: document.entity_type,
      capturedAt: document.captured_at,
    });
    chunks += result.chunks;
    fts = result.fts;
  }
  fts = synchronizeSqlFts(db);
  return { documents: documents.length, chunks, fts };
}

export function bootstrapObserverDatabase(dataDir, { security = {} } = {}) {
  const db = openObserverDatabase(dataDir);
  try {
    configureObserverDatabaseSecurity(db, security);
    const databaseMigration = migrateObserverDatabase(db, {
      backupEncryption: security?.encryption || null,
      requireEncryptedBackup: Boolean(security?.encryption?.required),
    });
    const protectedDataMigration = security.encryption
      ? migrateObserverProtectedData(db, { encryption: security.encryption })
      : { protected_rows: 0, projects: 0 };
    return { db, databaseMigration, protectedDataMigration };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function ensureObserverDatabase(dataDir, { security = null } = {}) {
  return bootstrapObserverDatabase(dataDir, { security: security || {} }).db;
}

export function migrateObserverProtectedData(db, { projectId = '', encryption } = {}) {
  if (!encryption) return { protected_rows: 0, projects: 0 };
  const projects = projectId
    ? [requireProject(db, projectId)]
    : db.prepare('SELECT project_id FROM projects ORDER BY project_id').all();
  let protectedRows = 0;
  for (const project of projects) {
    const id = project.project_id;
    db.exec('BEGIN IMMEDIATE');
    try {
      const documents = db.prepare("SELECT logical_path, content, metadata_json, content_envelope, metadata_envelope FROM documents WHERE project_id = ? AND (content <> '' OR metadata_json <> '{}' OR content_envelope = '' OR metadata_envelope = '')").all(id);
      for (const row of documents) {
        const contentEnvelope = row.content_envelope || encryptedText(encryption, row.content, `${id}:document:${row.logical_path}`);
        const metadataEnvelope = row.metadata_envelope || encryptedJson(encryption, parseJson(row.metadata_json), `${id}:document:${row.logical_path}:metadata`);
        db.prepare("UPDATE documents SET content = '', content_envelope = ?, metadata_json = '{}', metadata_envelope = ? WHERE project_id = ? AND logical_path = ?")
          .run(contentEnvelope, metadataEnvelope, id, row.logical_path);
        db.prepare('DELETE FROM document_chunks WHERE project_id = ? AND logical_path = ?').run(id, row.logical_path);
        if (observerFts5Support(db).supported) db.prepare('DELETE FROM evidence_chunks_fts WHERE project_id = ? AND logical_path = ?').run(id, row.logical_path);
        protectedRows += 1;
      }
      const calls = db.prepare("SELECT call_id, prompt_text, response_text, metadata_json, prompt_envelope, response_envelope, metadata_envelope FROM llm_calls WHERE project_id = ? AND (prompt_text <> '' OR response_text <> '' OR metadata_json <> '{}')").all(id);
      for (const row of calls) {
        db.prepare("UPDATE llm_calls SET prompt_text = '', response_text = '', metadata_json = '{}', prompt_envelope = ?, response_envelope = ?, metadata_envelope = ? WHERE project_id = ? AND call_id = ?").run(
          row.prompt_envelope || encryptedText(encryption, row.prompt_text, `${id}:call:${row.call_id}:prompt`),
          row.response_envelope || encryptedText(encryption, row.response_text, `${id}:call:${row.call_id}:response`),
          row.metadata_envelope || encryptedJson(encryption, parseJson(row.metadata_json), `${id}:call:${row.call_id}:metadata`), id, row.call_id,
        );
        protectedRows += 1;
      }
      const transcripts = db.prepare("SELECT * FROM transcripts WHERE project_id = ? AND codec <> 'aes-256-gcm+gzip'").all(id);
      for (const row of transcripts) {
        const decoded = decodeTranscript(row);
        const encoded = encodeTranscript(decoded.content, { encryption, aad: `${id}:transcript:${row.transcript_id}` });
        db.prepare("UPDATE transcripts SET codec = ?, content_gzip = ?, compressed_bytes = ?, metadata_json = '{}', metadata_envelope = ? WHERE project_id = ? AND transcript_id = ?").run(
          encoded.codec, encoded.content_gzip, encoded.compressed_bytes,
          encryptedJson(encryption, parseJson(row.metadata_json), `${id}:transcript:${row.transcript_id}:metadata`), id, row.transcript_id,
        );
        protectedRows += 1;
      }
      const snapshots = db.prepare("SELECT project_id, snapshot_json, snapshot_envelope FROM project_snapshots WHERE project_id = ? AND snapshot_json <> '{}'").all(id);
      for (const row of snapshots) {
        db.prepare("UPDATE project_snapshots SET snapshot_json = '{}', snapshot_envelope = ? WHERE project_id = ?").run(
          row.snapshot_envelope || encryptedJson(encryption, parseJson(row.snapshot_json), `${id}:snapshot`), id,
        );
        protectedRows += 1;
      }
      for (const table of ['ingest_events', 'memory_events']) {
        const rows = db.prepare(`SELECT event_id, payload_json FROM ${table} WHERE project_id = ?`).all(id);
        for (const row of rows) {
          const source = parseJson(row.payload_json);
          const protectedPayload = { ...source };
          for (const field of ['content', 'prompt', 'promptText', 'prompt_text', 'response', 'responseText', 'response_text']) {
            if (Object.hasOwn(protectedPayload, field)) protectedPayload[field] = '[PROTECTED]';
          }
          if (Object.hasOwn(protectedPayload, 'metadata')) protectedPayload.metadata = '[PROTECTED]';
          db.prepare(`UPDATE ${table} SET payload_json = ? WHERE event_id = ?`).run(json(protectedPayload), row.event_id);
        }
      }
      db.prepare(`INSERT INTO observer_security_backfill(project_id, status, protected_rows, updated_at)
        VALUES (?, 'complete', ?, ?) ON CONFLICT(project_id) DO UPDATE SET status = 'complete', protected_rows = excluded.protected_rows, updated_at = excluded.updated_at`)
        .run(id, protectedRows, now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return { protected_rows: protectedRows, projects: projects.length };
}

export function registerSqlProject(db, { projectId, projectName = projectId, wendkeepVersion = '', registeredAt = now() } = {}) {
  if (!validProjectId(projectId)) return { registered: false, errors: ['project_id inválido.'] };
  const timestamp = now();
  db.prepare(`
    INSERT INTO projects(project_id, project_name, wendkeep_version, registered_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET
      project_name = excluded.project_name,
      wendkeep_version = excluded.wendkeep_version,
      updated_at = excluded.updated_at
  `).run(projectId, text(projectName || projectId).slice(0, 200), text(wendkeepVersion).slice(0, 40), text(registeredAt), timestamp);
  return { registered: true, project: db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) };
}

function validateEvent(event, projectId) {
  const errors = [];
  if (!event || typeof event !== 'object' || Array.isArray(event)) errors.push('evento deve ser um objeto.');
  if (event?.schema_version !== OBSERVER_EVENT_SCHEMA_VERSION) errors.push('schema_version incompatível.');
  if (!event?.event_id || typeof event.event_id !== 'string') errors.push('event_id ausente.');
  if (event?.project_id !== projectId) errors.push('project_id do evento não corresponde à rota.');
  if (!EVENT_KINDS.has(event?.kind)) errors.push('kind de evento inválido.');
  if (!event?.occurred_at || Number.isNaN(Date.parse(event.occurred_at))) errors.push('occurred_at inválido.');
  if (!event?.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) errors.push('payload inválido.');
  return { ok: errors.length === 0, errors };
}

function tokenFields(tokens = {}) {
  return [
    integer(tokens.input), integer(tokens.cache_write ?? tokens.cacheWrite), integer(tokens.cache_read ?? tokens.cached),
    integer(tokens.output), integer(tokens.reasoning), integer(tokens.total),
  ];
}

function ensureSession(db, projectId, payload) {
  const sessionId = text(payload.session_id || payload.sessionId);
  if (!sessionId) throw new Error('session_id ausente.');
  db.prepare(`
    INSERT INTO sessions(session_pk, session_id, project_id, provider, status, summary, change_slug, started_at, ended_at, updated_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, session_id) DO UPDATE SET
      provider = CASE WHEN excluded.provider <> '' THEN excluded.provider ELSE sessions.provider END,
      status = CASE WHEN excluded.status <> '' THEN excluded.status ELSE sessions.status END,
      summary = CASE WHEN excluded.summary <> '' THEN excluded.summary ELSE sessions.summary END,
      change_slug = CASE WHEN excluded.change_slug <> '' THEN excluded.change_slug ELSE sessions.change_slug END,
      started_at = COALESCE(excluded.started_at, sessions.started_at),
      ended_at = COALESCE(excluded.ended_at, sessions.ended_at),
      updated_at = excluded.updated_at,
      metadata_json = CASE WHEN excluded.metadata_json <> '{}' THEN excluded.metadata_json ELSE sessions.metadata_json END
  `).run(
    scopedIdentity(projectId, sessionId), sessionId, projectId, text(payload.provider), text(payload.status, 'unknown'), text(payload.summary), text(payload.change_slug || payload.changeSlug),
    payload.started_at || payload.startedAt || null, payload.ended_at || payload.endedAt || null, now(), json(payload.metadata),
  );
  return sessionId;
}

function ensureAgent(db, projectId, payload) {
  const agentId = text(payload.agent_id || payload.agentId);
  if (!agentId) throw new Error('agent_id ausente.');
  const sessionId = ensureSession(db, projectId, payload);
  db.prepare(`
    INSERT INTO agent_runs(agent_pk, agent_id, project_id, session_id, parent_agent_id, role, agent_name, agent_type, workflow, status, model, effort, started_at, ended_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, agent_id) DO UPDATE SET
      parent_agent_id = COALESCE(excluded.parent_agent_id, agent_runs.parent_agent_id),
      role = excluded.role,
      agent_name = CASE WHEN excluded.agent_name <> '' THEN excluded.agent_name ELSE agent_runs.agent_name END,
      agent_type = CASE WHEN excluded.agent_type <> '' THEN excluded.agent_type ELSE agent_runs.agent_type END,
      workflow = CASE WHEN excluded.workflow <> '' THEN excluded.workflow ELSE agent_runs.workflow END,
      status = CASE WHEN excluded.status <> '' THEN excluded.status ELSE agent_runs.status END,
      model = CASE WHEN excluded.model <> '' THEN excluded.model ELSE agent_runs.model END,
      effort = CASE WHEN excluded.effort <> '' THEN excluded.effort ELSE agent_runs.effort END,
      started_at = COALESCE(excluded.started_at, agent_runs.started_at),
      ended_at = COALESCE(excluded.ended_at, agent_runs.ended_at),
      metadata_json = CASE WHEN excluded.metadata_json <> '{}' THEN excluded.metadata_json ELSE agent_runs.metadata_json END
  `).run(
    scopedIdentity(projectId, agentId), agentId, projectId, sessionId, payload.parent_agent_id || payload.parentAgentId || null, text(payload.role, 'main'),
    text(payload.agent_name || payload.agentName), text(payload.agent_type || payload.agentType), text(payload.workflow),
    text(payload.status, 'unknown'), text(payload.model), text(payload.effort), payload.started_at || null, payload.ended_at || null, json(payload.metadata),
  );
  return agentId;
}

function applyDocument(db, event) {
  const p = event.payload;
  const content = text(p.content);
  const { encryption } = databaseSecurity(db);
  const logicalPath = text(p.logical_path || p.logicalPath);
  if (!logicalPath || logicalPath.includes('..') || /^[A-Za-z]:[\\/]/.test(logicalPath)) throw new Error('logical_path inválido.');
  const current = db.prepare('SELECT revision FROM documents WHERE project_id = ? AND logical_path = ?').get(event.project_id, logicalPath);
  const revision = integer(p.revision, 1);
  const contentHash = text(p.content_hash || p.contentHash) || hash(content);
  if (current && revision < Number(current.revision)) return { stale: true };
  if (current && revision === Number(current.revision)) {
    const currentHash = db.prepare('SELECT content_hash FROM documents WHERE project_id = ? AND logical_path = ?').get(event.project_id, logicalPath)?.content_hash;
    if (currentHash === contentHash) return { stale: true };
    const error = new Error(`revisão ${revision} já existe para ${logicalPath} com conteúdo diferente.`);
    error.code = 'document_conflict';
    throw error;
  }
  const memoryEvent = db.prepare('SELECT content_hash FROM memory_events WHERE project_id = ? AND logical_path = ? AND revision = ?')
    .get(event.project_id, logicalPath, revision);
  if (memoryEvent) {
    if (memoryEvent.content_hash === contentHash) return { stale: true };
    const error = new Error(`revisão ${revision} já existe para ${logicalPath} com conteúdo diferente.`);
    error.code = 'document_conflict';
    throw error;
  }
  const title = text(p.title || basename(logicalPath).replace(/\.md$/i, ''));
  const documentId = text(p.document_id || p.documentId) || `${event.project_id}:${logicalPath}`;
  const contentEnvelope = encryption
    ? encryptObserverValue(encryption, content, { aad: `${event.project_id}:document:${logicalPath}` })
    : null;
  const metadataEnvelope = encryption
    ? encryptedJson(encryption, p.metadata || {}, `${event.project_id}:document:${logicalPath}:metadata`)
    : '';
  const storedContent = contentEnvelope ? '' : content;
  db.prepare(`
    INSERT INTO documents(document_id, project_id, logical_path, entity_type, title, content, content_envelope, metadata_json, metadata_envelope, content_hash, revision, source_session_id, source_turn_id, captured_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(project_id, logical_path) DO UPDATE SET
      document_id = excluded.document_id,
      entity_type = excluded.entity_type,
      title = excluded.title,
      content = excluded.content,
      content_envelope = excluded.content_envelope,
      metadata_json = excluded.metadata_json,
      metadata_envelope = excluded.metadata_envelope,
      content_hash = excluded.content_hash,
      revision = excluded.revision,
      source_session_id = excluded.source_session_id,
      source_turn_id = excluded.source_turn_id,
      captured_at = excluded.captured_at,
      deleted_at = NULL
  `).run(
    documentId, event.project_id, logicalPath, text(p.entity_type || p.entityType, 'memory'), title, storedContent, contentEnvelope ? json(contentEnvelope) : '', encryption ? '{}' : json(p.metadata), metadataEnvelope, contentHash,
    revision, text(p.source_session_id || p.sourceSessionId), text(p.source_turn_id || p.sourceTurnId), text(p.captured_at || p.capturedAt || event.occurred_at),
  );
  db.prepare(`
    INSERT INTO memory_events(event_id, project_id, entity_type, logical_path, operation, revision, content_hash, source_session_id, source_turn_id, occurred_at, payload_json)
    VALUES (?, ?, ?, ?, 'upsert', ?, ?, ?, ?, ?, ?)
  `).run(event.event_id, event.project_id, text(p.entity_type || p.entityType, 'memory'), logicalPath, revision, contentHash,
    text(p.source_session_id || p.sourceSessionId), text(p.source_turn_id || p.sourceTurnId), event.occurred_at,
    json(ledgerPayload(event, encryption)));
  if (contentEnvelope) {
    db.prepare('DELETE FROM document_chunks WHERE project_id = ? AND logical_path = ?').run(event.project_id, logicalPath);
  } else {
    writeSqlDocumentChunks(db, {
      projectId: event.project_id,
      logicalPath,
      content,
      metadata: p.metadata,
      entityType: text(p.entity_type || p.entityType, 'memory'),
      capturedAt: text(p.captured_at || p.capturedAt || event.occurred_at),
    });
  }
  return { stale: false };
}

function applyDocumentDelete(db, event) {
  const logicalPath = text(event.payload.logical_path || event.payload.logicalPath);
  if (!logicalPath) throw new Error('logical_path ausente.');
  db.prepare('UPDATE documents SET deleted_at = ?, revision = MAX(revision, ?) WHERE project_id = ? AND logical_path = ?')
    .run(event.occurred_at, integer(event.payload.revision, 1), event.project_id, logicalPath);
  db.prepare(`
    INSERT INTO memory_events(event_id, project_id, entity_type, logical_path, operation, revision, content_hash, source_session_id, source_turn_id, occurred_at, payload_json)
    VALUES (?, ?, ?, ?, 'delete', ?, '', ?, ?, ?, ?)
  `).run(event.event_id, event.project_id, text(event.payload.entity_type || event.payload.entityType, 'memory'), logicalPath,
    integer(event.payload.revision, 1), text(event.payload.source_session_id || event.payload.sourceSessionId), text(event.payload.source_turn_id || event.payload.sourceTurnId), event.occurred_at, json(event.payload));
  db.prepare('DELETE FROM document_chunks WHERE project_id = ? AND logical_path = ?').run(event.project_id, logicalPath);
  if (observerFts5Support(db).supported) {
    db.prepare('DELETE FROM evidence_chunks_fts WHERE project_id = ? AND logical_path = ?').run(event.project_id, logicalPath);
  }
  return { stale: false };
}

function applyUsageRollup(db, event) {
  const p = event.payload;
  const sessionId = ensureSession(db, event.project_id, p);
  const agentId = ensureAgent(db, event.project_id, p);
  const [input, cacheWrite, cacheRead, output, reasoning, total] = tokenFields(p.tokens);
  const rollupKey = text(p.rollup_key || p.rollupKey) || [event.project_id, sessionId, agentId, p.model_provider || p.modelProvider || '', p.model || '', p.effort || ''].join(':');
  const revision = integer(p.revision, 1);
  const current = db.prepare('SELECT revision FROM usage_rollups WHERE project_id = ? AND rollup_key = ?').get(event.project_id, rollupKey);
  if (current && revision < Number(current.revision)) return { stale: true };
  db.prepare(`
    INSERT INTO usage_rollups(rollup_pk, rollup_key, project_id, session_id, agent_id, role, provider, model_provider, model, effort, calls, tokens_input, tokens_cache_write, tokens_cache_read, tokens_output, tokens_reasoning, tokens_total, cost_usd, cost_status, pricing_source, pricing_version, wasted_usd, revision, occurred_at, source_event_id, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, rollup_key) DO UPDATE SET
      calls = excluded.calls, tokens_input = excluded.tokens_input, tokens_cache_write = excluded.tokens_cache_write,
      tokens_cache_read = excluded.tokens_cache_read, tokens_output = excluded.tokens_output, tokens_reasoning = excluded.tokens_reasoning,
      tokens_total = excluded.tokens_total, cost_usd = excluded.cost_usd, cost_status = excluded.cost_status,
      pricing_source = excluded.pricing_source, pricing_version = excluded.pricing_version, wasted_usd = excluded.wasted_usd,
      revision = excluded.revision, occurred_at = excluded.occurred_at, source_event_id = excluded.source_event_id, metadata_json = excluded.metadata_json
  `).run(
    scopedIdentity(event.project_id, rollupKey), rollupKey, event.project_id, sessionId, agentId, text(p.role, 'main'), text(p.provider), text(p.model_provider || p.modelProvider), text(p.model), text(p.effort),
    integer(p.calls), input, cacheWrite, cacheRead, output, reasoning, total, number(p.cost_usd ?? p.costUsd), text(p.cost_status || p.costStatus, 'unknown'),
    text(p.pricing_source || p.pricingSource), text(p.pricing_version || p.pricingVersion), number(p.wasted_usd ?? p.wastedUsd), revision, event.occurred_at, event.event_id, json(p.metadata),
  );
  return { stale: false };
}

function applyCall(db, event) {
  const p = event.payload;
  const sessionId = ensureSession(db, event.project_id, p);
  const agentId = ensureAgent(db, event.project_id, p);
  const callId = text(p.call_id || p.callId);
  if (!callId) throw new Error('call_id ausente.');
  if (db.prepare('SELECT call_id FROM llm_calls WHERE project_id = ? AND call_id = ?').get(event.project_id, callId)) {
    const error = new Error(`call_id já existe: ${callId}`);
    error.code = 'call_conflict';
    throw error;
  }
  const [input, cacheWrite, cacheRead, output, reasoning, total] = tokenFields(p.tokens);
  const { encryption } = databaseSecurity(db);
  const prompt = text(p.prompt_text || p.promptText || p.prompt);
  const response = text(p.response_text || p.responseText || p.response);
  const promptEnvelope = encryption
    ? encryptObserverValue(encryption, prompt, { aad: `${event.project_id}:call:${callId}:prompt` })
    : null;
  const responseEnvelope = encryption
    ? encryptObserverValue(encryption, response, { aad: `${event.project_id}:call:${callId}:response` })
    : null;
  const metadataEnvelope = encryption
    ? encryptedJson(encryption, p.metadata || {}, `${event.project_id}:call:${callId}:metadata`)
    : '';
  db.prepare(`
    INSERT INTO llm_calls(call_pk, call_id, project_id, session_id, agent_id, role, provider, model_provider, model, effort, sequence, occurred_at, tokens_input, tokens_cache_write, tokens_cache_read, tokens_output, tokens_reasoning, tokens_total, cost_usd, cost_status, transcript_id, prompt_text, response_text, prompt_envelope, response_envelope, status, metadata_json, metadata_envelope)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    scopedIdentity(event.project_id, callId), callId, event.project_id, sessionId, agentId, text(p.role, 'main'), text(p.provider), text(p.model_provider || p.modelProvider), text(p.model), text(p.effort), integer(p.sequence),
    text(p.occurred_at || event.occurred_at), input, cacheWrite, cacheRead, output, reasoning, total, number(p.cost_usd ?? p.costUsd), text(p.cost_status || p.costStatus, 'unknown'),
    p.transcript_id || p.transcriptId || null, promptEnvelope ? '' : prompt, responseEnvelope ? '' : response,
    promptEnvelope ? json(promptEnvelope) : '', responseEnvelope ? json(responseEnvelope) : '', text(p.status, 'complete'), encryption ? '{}' : json(p.metadata), metadataEnvelope,
  );
  return { stale: false };
}

function applyTranscript(db, event) {
  const p = event.payload;
  const sessionId = ensureSession(db, event.project_id, p);
  const agentId = ensureAgent(db, event.project_id, p);
  const transcriptId = text(p.transcript_id || p.transcriptId);
  if (!transcriptId) throw new Error('transcript_id ausente.');
  const { encryption } = databaseSecurity(db);
  const encoded = encodeTranscript(p.content, { encryption, aad: `${event.project_id}:transcript:${transcriptId}` });
  const metadataEnvelope = encryption
    ? encryptedJson(encryption, p.metadata || {}, `${event.project_id}:transcript:${transcriptId}:metadata`)
    : '';
  db.prepare(`
    INSERT INTO transcripts(transcript_pk, transcript_id, project_id, session_id, agent_id, coverage, codec, content_gzip, content_sha256, original_bytes, compressed_bytes, source, occurred_at, metadata_json, metadata_envelope)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, transcript_id) DO UPDATE SET
      coverage = excluded.coverage, codec = excluded.codec, content_gzip = excluded.content_gzip,
      content_sha256 = excluded.content_sha256, original_bytes = excluded.original_bytes, compressed_bytes = excluded.compressed_bytes,
      source = excluded.source, occurred_at = excluded.occurred_at, metadata_json = excluded.metadata_json,
      metadata_envelope = excluded.metadata_envelope
  `).run(
    scopedIdentity(event.project_id, transcriptId), transcriptId, event.project_id, sessionId, agentId, text(p.coverage, 'complete'), encoded.codec, encoded.content_gzip, encoded.content_sha256,
    encoded.original_bytes, encoded.compressed_bytes, text(p.source), event.occurred_at, encryption ? '{}' : json(p.metadata), metadataEnvelope,
  );
  return { stale: false };
}

function applyEvent(db, event) {
  if (event.kind === 'document.upsert') return applyDocument(db, event);
  if (event.kind === 'document.delete') return applyDocumentDelete(db, event);
  if (event.kind === 'session.upsert') { ensureSession(db, event.project_id, event.payload); return { stale: false }; }
  if (event.kind === 'agent.upsert') { ensureAgent(db, event.project_id, event.payload); return { stale: false }; }
  if (event.kind === 'usage.rollup') return applyUsageRollup(db, event);
  if (event.kind === 'llm_call') return applyCall(db, event);
  if (event.kind === 'transcript.upsert') return applyTranscript(db, event);
  throw new Error('kind não implementado.');
}

function ledgerPayload(event, encryption) {
  if (!encryption) return event.payload;
  const payload = structuredClone(event.payload || {});
  if (event.kind === 'document.upsert' || event.kind === 'transcript.upsert') payload.content = '[PROTECTED]';
  if (event.kind === 'llm_call') {
    for (const key of ['prompt', 'promptText', 'prompt_text', 'response', 'responseText', 'response_text']) {
      if (Object.hasOwn(payload, key)) payload[key] = '[PROTECTED]';
    }
  }
  if (['document.upsert', 'transcript.upsert', 'llm_call'].includes(event.kind)
    && Object.hasOwn(payload, 'metadata')) payload.metadata = '[PROTECTED]';
  return payload;
}

export function ingestObserverEvents(db, { projectId, events = [] } = {}) {
  requireProject(db, projectId);
  const security = databaseSecurity(db);
  const storedPolicy = readObserverPolicy(db, projectId);
  const effectivePolicy = security.policy || (security.enforcePolicy ? storedPolicy : null);
  if ((security.policy?.encryption_required || storedPolicy.encryption_required) && !security.encryption) {
    throw Object.assign(new Error('A policy exige criptografia antes da ingestão.'), { code: 'observer_encryption_required' });
  }
  const result = { accepted: 0, duplicates: 0, conflicts: 0, stale: 0, rejected: 0, dropped: 0, results: [] };
  for (const incoming of events) {
    const event = effectivePolicy ? protectObserverEvent(incoming, { policy: effectivePolicy }) : incoming;
    if (!event) {
      result.dropped += 1;
      result.results.push({ accepted: false, dropped: true, event_id: incoming?.event_id || '' });
      continue;
    }
    const validation = validateEvent(event, projectId);
    if (!validation.ok) {
      result.rejected += 1;
      result.results.push({ accepted: false, errors: validation.errors, event_id: event?.event_id || '' });
      continue;
    }
    // The event ID is the stable identity.  Capture time is transport metadata:
    // retries must remain idempotent when the same event is reconstructed later.
    // The payload itself still detects a real content/semantic conflict.
    const payloadHash = hash({ kind: event.kind, project_id: event.project_id, payload: event.payload });
    const existing = db.prepare('SELECT payload_hash, payload_json, kind, project_id FROM ingest_events WHERE event_id = ?').get(event.event_id);
    if (existing) {
      const existingCanonicalHash = hash({ kind: existing.kind, project_id: existing.project_id, payload: parseJson(existing.payload_json) });
      if (existing.payload_hash === payloadHash || existingCanonicalHash === payloadHash) {
        if (existing.payload_hash !== payloadHash) {
          db.prepare('UPDATE ingest_events SET payload_hash = ? WHERE event_id = ?').run(payloadHash, event.event_id);
        }
        result.duplicates += 1;
        result.results.push({ accepted: false, duplicate: true, event_id: event.event_id });
      } else {
        result.conflicts += 1;
        result.results.push({ accepted: false, conflict: true, event_id: event.event_id });
      }
      continue;
    }
    db.exec('SAVEPOINT ingest_one');
    let savepointOpen = true;
    try {
      db.prepare('INSERT INTO ingest_events(event_id, project_id, kind, payload_hash, payload_json, occurred_at, ingested_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(event.event_id, projectId, event.kind, payloadHash, json(ledgerPayload(event, security.encryption)), event.occurred_at, now(), 'accepted');
      const applied = applyEvent(db, event);
      if (applied.stale) {
        db.prepare('UPDATE ingest_events SET status = ? WHERE event_id = ?').run('stale', event.event_id);
        result.stale += 1;
        result.results.push({ accepted: false, stale: true, event_id: event.event_id });
      } else {
        result.accepted += 1;
        result.results.push({ accepted: true, event_id: event.event_id });
      }
      db.exec('RELEASE ingest_one');
      savepointOpen = false;
    } catch (error) {
      if (savepointOpen) {
        try { db.exec('ROLLBACK TO ingest_one'); } finally { db.exec('RELEASE ingest_one'); }
      }
      if (error?.code === 'call_conflict' || error?.code === 'document_conflict') {
        result.conflicts += 1;
        result.results.push({ accepted: false, conflict: true, event_id: event.event_id, errors: [error.message] });
      } else {
        result.rejected += 1;
        result.results.push({ accepted: false, event_id: event.event_id, errors: [error.message] });
      }
    }
  }
  return result;
}

function usageFilter(filters = {}, alias = 'u') {
  const where = [`${alias}.project_id = ?`];
  const params = [filters.projectId];
  if (filters.from) { where.push(`${alias}.occurred_at >= ?`); params.push(filters.from); }
  if (filters.to) { where.push(`${alias}.occurred_at <= ?`); params.push(filters.to); }
  if (filters.agentId) { where.push(`${alias}.agent_id = ?`); params.push(filters.agentId); }
  if (filters.subagentId) { where.push(`${alias}.agent_id = ?`); params.push(filters.subagentId); where.push(`${alias}.role = 'subagent'`); }
  if (filters.sessionId) { where.push(`${alias}.session_id = ?`); params.push(filters.sessionId); }
  if (filters.changeSlug) {
    where.push(`${alias}.session_id IN (SELECT session_id FROM sessions WHERE project_id = ? AND change_slug = ?)`);
    params.push(filters.projectId, filters.changeSlug);
  }
  if (filters.role) { where.push(`${alias}.role = ?`); params.push(filters.role); }
  if (filters.model) { where.push(`${alias}.model = ?`); params.push(filters.model); }
  if (filters.provider) { where.push(`${alias}.provider = ?`); params.push(filters.provider); }
  if (filters.modelProvider) { where.push(`${alias}.model_provider = ?`); params.push(filters.modelProvider); }
  return { sql: where.join(' AND '), params };
}

function tokenObject(row, prefix = '') {
  return {
    input: integer(row?.[`${prefix}tokens_input`]), cache_write: integer(row?.[`${prefix}tokens_cache_write`]), cache_read: integer(row?.[`${prefix}tokens_cache_read`]),
    output: integer(row?.[`${prefix}tokens_output`]), reasoning: integer(row?.[`${prefix}tokens_reasoning`]), total: integer(row?.[`${prefix}tokens_total`]),
  };
}

export function readUsageSummary(db, projectId, filters = {}) {
  const f = usageFilter({ ...filters, projectId });
  const aggregate = db.prepare(`SELECT COUNT(*) AS rollups, COALESCE(SUM(u.calls), 0) AS calls, COUNT(DISTINCT u.session_id) AS sessions, COUNT(DISTINCT u.agent_id) AS agents, COUNT(DISTINCT CASE WHEN u.role = 'subagent' THEN u.agent_id END) AS subagents, COUNT(DISTINCT u.model_provider || ':' || u.model) AS models, COALESCE(SUM(u.cost_usd), 0) AS cost_usd, COALESCE(SUM(CASE WHEN u.role = 'main' THEN u.cost_usd ELSE 0 END), 0) AS main_cost_usd, COALESCE(SUM(CASE WHEN u.role = 'subagent' THEN u.cost_usd ELSE 0 END), 0) AS subagent_cost_usd, COALESCE(SUM(u.wasted_usd), 0) AS wasted_usd, COALESCE(SUM(u.tokens_input), 0) AS tokens_input, COALESCE(SUM(u.tokens_cache_write), 0) AS tokens_cache_write, COALESCE(SUM(u.tokens_cache_read), 0) AS tokens_cache_read, COALESCE(SUM(u.tokens_output), 0) AS tokens_output, COALESCE(SUM(u.tokens_reasoning), 0) AS tokens_reasoning, COALESCE(SUM(u.tokens_total), 0) AS tokens_total, COALESCE(SUM(CASE WHEN u.cost_status = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_priced_rollups FROM usage_rollups u WHERE ${f.sql}`).get(...f.params);
  const callsFilter = usageFilter({ ...filters, projectId }, 'c');
  const raw = db.prepare(`SELECT COUNT(*) AS raw_calls FROM llm_calls c WHERE ${callsFilter.sql}`).get(...callsFilter.params);
  const coverage = db.prepare(`SELECT COUNT(*) AS transcripts, COALESCE(SUM(CASE WHEN coverage = 'complete' THEN 1 ELSE 0 END), 0) AS complete, COALESCE(SUM(CASE WHEN coverage <> 'complete' THEN 1 ELSE 0 END), 0) AS summary_only FROM transcripts WHERE project_id = ?`).get(projectId);
  const byDay = db.prepare(`SELECT substr(u.occurred_at, 1, 10) AS date, ROUND(COALESCE(SUM(u.cost_usd), 0), 4) AS cost_usd, COALESCE(SUM(u.tokens_total), 0) AS tokens_total, COALESCE(SUM(u.calls), 0) AS calls FROM usage_rollups u WHERE ${f.sql} GROUP BY substr(u.occurred_at, 1, 10) ORDER BY date`).all(...f.params);
  return {
    project_id: projectId,
    sessions: integer(aggregate.sessions), agents: integer(aggregate.agents), subagents: integer(aggregate.subagents), models: integer(aggregate.models),
    rollups: integer(aggregate.rollups), calls: integer(aggregate.calls), raw_calls: integer(raw.raw_calls),
    cost_usd: Number(number(aggregate.cost_usd).toFixed(4)), main_cost_usd: Number(number(aggregate.main_cost_usd).toFixed(4)),
    subagent_cost_usd: Number(number(aggregate.subagent_cost_usd).toFixed(4)), wasted_usd: Number(number(aggregate.wasted_usd).toFixed(4)),
    tokens: tokenObject(aggregate), unknown_priced_rollups: integer(aggregate.unknown_priced_rollups), coverage: { transcripts: integer(coverage.transcripts), complete: integer(coverage.complete), summary_only: integer(coverage.summary_only) },
    by_day: byDay.map((row) => ({ date: row.date, cost_usd: Number(number(row.cost_usd).toFixed(4)), tokens_total: integer(row.tokens_total), calls: integer(row.calls) })),
  };
}

export function readUsageBreakdown(db, projectId, filters = {}) {
  const f = usageFilter({ ...filters, projectId });
  const modelStatement = db.prepare(`SELECT u.agent_id, u.model_provider, u.model, u.effort, u.role, COALESCE(SUM(u.calls), 0) AS calls, COALESCE(SUM(u.cost_usd), 0) AS cost_usd, COALESCE(SUM(u.tokens_total), 0) AS tokens_total FROM usage_rollups u WHERE ${f.sql} GROUP BY u.agent_id, u.model_provider, u.model, u.effort ORDER BY cost_usd DESC`);
  const modelRows = modelStatement.all(...f.params);
  const allAgents = db.prepare(`SELECT a.agent_id, a.parent_agent_id, a.role, a.agent_name, a.agent_type, a.workflow, a.status, COALESCE(SUM(u.calls), 0) AS calls, COALESCE(SUM(u.cost_usd), 0) AS cost_usd, COALESCE(SUM(u.tokens_total), 0) AS tokens_total FROM agent_runs a LEFT JOIN usage_rollups u ON u.agent_id = a.agent_id AND ${f.sql.replace(/^u\./g, 'u.')} WHERE a.project_id = ? GROUP BY a.agent_id ORDER BY cost_usd DESC, a.agent_id`).all(...f.params, projectId);
  const allById = new Map(allAgents.map((agent) => [agent.agent_id, agent]));
  const visibleIds = new Set(modelRows.map((row) => row.agent_id));
  for (const agentId of [...visibleIds]) {
    let parentId = allById.get(agentId)?.parent_agent_id;
    while (parentId && allById.has(parentId) && !visibleIds.has(parentId)) {
      visibleIds.add(parentId);
      parentId = allById.get(parentId).parent_agent_id;
    }
  }
  const agents = allAgents.filter((agent) => visibleIds.has(agent.agent_id));
  return {
    project_id: projectId,
    agents: agents.map((agent) => ({
      ...agent,
      calls: integer(agent.calls), tokens_total: integer(agent.tokens_total), cost_usd: Number(number(agent.cost_usd).toFixed(4)),
      models: modelRows.filter((row) => row.agent_id === agent.agent_id).map((row) => ({
        model_provider: row.model_provider, model: row.model, effort: row.effort, role: row.role,
        calls: integer(row.calls), tokens_total: integer(row.tokens_total), cost_usd: Number(number(row.cost_usd).toFixed(4)),
      })),
    })),
  };
}

export function readUsageCalls(db, projectId, filters = {}) {
  const f = usageFilter({ ...filters, projectId }, 'c');
  const limit = Math.min(500, Math.max(1, integer(filters.limit, 100)));
  const offset = Math.max(0, integer(filters.offset));
  const rows = db.prepare(`SELECT c.*, COUNT(*) OVER() AS total_count FROM llm_calls c WHERE ${f.sql} ORDER BY c.occurred_at DESC, c.sequence DESC, c.call_id LIMIT ? OFFSET ?`).all(...f.params, limit, offset);
  return {
    project_id: projectId,
    offset,
    limit,
    total: integer(rows[0]?.total_count),
    calls: rows.map((row) => {
      const { encryption } = databaseSecurity(db);
      const prompt = row.prompt_envelope
        ? decryptObserverValue(encryption, parseJson(row.prompt_envelope), { aad: `${projectId}:call:${row.call_id}:prompt` })
        : row.prompt_text;
      const response = row.response_envelope
        ? decryptObserverValue(encryption, parseJson(row.response_envelope), { aad: `${projectId}:call:${row.call_id}:response` })
        : row.response_text;
      return ({
      call_id: row.call_id, session_id: row.session_id, agent_id: row.agent_id, role: row.role, provider: row.provider,
      model_provider: row.model_provider, model: row.model, effort: row.effort, sequence: integer(row.sequence), occurred_at: row.occurred_at,
      tokens: tokenObject(row), cost_usd: Number(number(row.cost_usd).toFixed(4)), cost_status: row.cost_status,
      transcript_id: row.transcript_id, prompt, response, status: row.status,
      metadata: row.metadata_envelope
        ? decryptedJson(encryption, row.metadata_envelope, {}, `${projectId}:call:${row.call_id}:metadata`)
        : parseJson(row.metadata_json),
    }); }),
  };
}

export function readTranscript(db, projectId, transcriptId) {
  requireProject(db, projectId);
  const row = db.prepare('SELECT * FROM transcripts WHERE project_id = ? AND transcript_id = ?').get(projectId, transcriptId);
  if (!row) {
    const error = new Error('transcript não encontrado.');
    error.code = 'transcript_not_found';
    throw error;
  }
  const decoded = decodeTranscript(row, {
    encryption: databaseSecurity(db).encryption,
    aad: `${projectId}:transcript:${transcriptId}`,
  });
  decoded.metadata = row.metadata_envelope
    ? decryptedJson(databaseSecurity(db).encryption, row.metadata_envelope, {}, `${projectId}:transcript:${transcriptId}:metadata`)
    : parseJson(row.metadata_json);
  return decoded;
}

export function readSqlDocument(db, projectId, logicalPath) {
  requireProject(db, projectId);
  if (!logicalPath || logicalPath.includes('..') || /^[A-Za-z]:[\\/]/.test(logicalPath) || logicalPath.startsWith('/')) {
    const error = new Error('logical_path inválido.');
    error.code = 'invalid_memory_path';
    throw error;
  }
  const row = db.prepare('SELECT * FROM documents WHERE project_id = ? AND logical_path = ? AND deleted_at IS NULL').get(projectId, logicalPath);
  if (!row) {
    const error = new Error('documento não encontrado.');
    error.code = 'memory_not_found';
    throw error;
  }
  const content = row.content_envelope
    ? decryptObserverValue(databaseSecurity(db).encryption, parseJson(row.content_envelope), { aad: `${projectId}:document:${logicalPath}` })
    : row.content;
  const metadata = row.metadata_envelope
    ? decryptedJson(databaseSecurity(db).encryption, row.metadata_envelope, {}, `${projectId}:document:${logicalPath}:metadata`)
    : parseJson(row.metadata_json);
  return { ...row, content, metadata };
}

export function readSqlTree(db, projectId, prefix = '') {
  requireProject(db, projectId);
  const rows = db.prepare('SELECT logical_path, entity_type, title, content_hash, revision, captured_at, source_session_id FROM documents WHERE project_id = ? AND deleted_at IS NULL AND logical_path LIKE ? ORDER BY logical_path').all(projectId, `${prefix}%`);
  return { schema_version: OBSERVER_SQL_SCHEMA_VERSION, project_id: projectId, prefix, documents: rows };
}

export function searchSqlDocuments(db, projectId, query = '', { forceLexical = false } = {}) {
  requireProject(db, projectId);
  const terms = recallTerms(query);
  if (!terms.length) return [];
  const fts = forceLexical
    ? { supported: false, engine: 'lexical-fallback' }
    : observerFts5Support(db);
  const columns = `c.chunk_id, c.project_id, c.logical_path, c.title, c.heading,
    c.entity_type, c.change_slug, c.session_id, c.work_session_id, c.authority,
    c.observed_at, c.validity, c.content_hash AS chunk_content_hash, c.ordinal, c.content,
    d.content_hash, d.revision, d.captured_at, d.source_session_id`;
  let rows;
  if (fts.supported) {
    const expression = [...new Set(terms)]
      .map((term) => `"${term.replaceAll('"', '""')}"`)
      .join(' OR ');
    rows = db.prepare(`SELECT ${columns} FROM evidence_chunks_fts f
      JOIN document_chunks c ON c.chunk_id = f.chunk_id
      JOIN documents d ON d.project_id = c.project_id AND d.logical_path = c.logical_path
      WHERE evidence_chunks_fts MATCH ? AND c.project_id = ? AND d.deleted_at IS NULL
      ORDER BY bm25(evidence_chunks_fts, 0, 0, 1.5, 3.0, 2.5, 1.0), c.observed_at DESC
      LIMIT 200`).all(expression, projectId);
  } else {
    // FTS5 may be unavailable in a valid Observer runtime. Rank the complete project corpus
    // instead of truncating by recency before matching, which would make old exact evidence
    // permanently unreachable.
    rows = db.prepare(`SELECT ${columns} FROM document_chunks c
      JOIN documents d ON d.project_id = c.project_id AND d.logical_path = c.logical_path
      WHERE c.project_id = ? AND d.deleted_at IS NULL
      ORDER BY c.observed_at DESC, c.logical_path, c.ordinal`).all(projectId);
  }
  return recallEvidence(rows, query, { topK: 5 });
}

export function readSqlSync(db, projectId) {
  requireProject(db, projectId);
  const documents = db.prepare('SELECT COUNT(*) AS count FROM documents WHERE project_id = ? AND deleted_at IS NULL').get(projectId);
  const events = db.prepare('SELECT COUNT(*) AS count FROM memory_events WHERE project_id = ?').get(projectId);
  const pending = db.prepare("SELECT COUNT(*) AS count FROM ingest_events WHERE project_id = ? AND status <> 'accepted'").get(projectId);
  return { mode: 'container-authority', project_id: projectId, document_count: integer(documents.count), event_count: integer(events.count), pending_count: integer(pending.count), database: OBSERVER_SQL_FILE, schema_version: OBSERVER_SQL_SCHEMA_VERSION };
}

export function exportSqlMemoryBundle(db, projectId, { includeContent = false } = {}) {
  requireProject(db, projectId);
  const rows = db.prepare('SELECT logical_path, entity_type, content, content_hash, revision, captured_at FROM documents WHERE project_id = ? AND deleted_at IS NULL ORDER BY logical_path').all(projectId);
  return {
    schema_version: OBSERVER_SQL_SCHEMA_VERSION,
    project_id: projectId,
    generated_at: now(),
    sanitized: !includeContent,
    documents: rows.map((row) => ({ ...row, content: includeContent ? row.content : '' })),
  };
}

export function readSqlProject(db, projectId) {
  requireProject(db, projectId);
  return db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId);
}

export function upsertSqlProjectSnapshot(db, snapshot) {
  const projectId = text(snapshot?.project_id || snapshot?.projectId);
  requireProject(db, projectId);
  const security = databaseSecurity(db);
  const storedPolicy = readObserverPolicy(db, projectId);
  if ((security.policy?.encryption_required || storedPolicy.encryption_required) && !security.encryption) {
    throw Object.assign(new Error('A policy exige criptografia antes de persistir snapshots.'), { code: 'observer_encryption_required' });
  }
  const eventId = text(snapshot?.event_id);
  const capturedAt = text(snapshot?.captured_at);
  if (!eventId || !capturedAt || Number.isNaN(Date.parse(capturedAt))) throw new Error('snapshot SQL inválido.');
  const current = db.prepare('SELECT event_id, captured_at FROM project_snapshots WHERE project_id = ?').get(projectId);
  if (current?.event_id === eventId) return { accepted: false, duplicate: true, event_id: eventId };
  if (current && (current.captured_at > capturedAt
    || (current.captured_at === capturedAt && current.event_id >= eventId))) {
    return { accepted: false, stale: true, event_id: eventId };
  }
  const { encryption } = security;
  const snapshotEnvelope = encryption ? encryptedJson(encryption, snapshot, `${projectId}:snapshot`) : '';
  db.prepare(`INSERT INTO project_snapshots(project_id, event_id, captured_at, snapshot_json, snapshot_envelope)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET
      event_id = excluded.event_id,
      captured_at = excluded.captured_at,
      snapshot_json = excluded.snapshot_json,
      snapshot_envelope = excluded.snapshot_envelope`).run(projectId, eventId, capturedAt, encryption ? '{}' : json(snapshot), snapshotEnvelope);
  return { accepted: true, duplicate: false, event_id: eventId };
}

export function readSqlProjectSnapshot(db, projectId) {
  requireProject(db, projectId);
  const row = db.prepare('SELECT snapshot_json, snapshot_envelope FROM project_snapshots WHERE project_id = ?').get(projectId);
  if (!row) return null;
  return row.snapshot_envelope
    ? decryptedJson(databaseSecurity(db).encryption, row.snapshot_envelope, null, `${projectId}:snapshot`)
    : parseJson(row.snapshot_json, null);
}

export function readSqlProjectOverview(db, projectId) {
  const project = readSqlProject(db, projectId);
  const snapshot = readSqlProjectSnapshot(db, projectId);
  const events = db.prepare('SELECT COUNT(*) AS count FROM ingest_events WHERE project_id = ?').get(projectId);
  return {
    projectId: project.project_id,
    projectName: project.project_name,
    wendkeepVersion: project.wendkeep_version,
    registeredAt: project.registered_at,
    updatedAt: project.updated_at,
    eventCount: integer(events.count),
    snapshot,
  };
}

export function listSqlProjects(db) {
  return db.prepare('SELECT * FROM projects ORDER BY project_name, project_id').all();
}
