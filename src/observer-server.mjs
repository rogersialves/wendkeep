import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  appendObserverEvent,
  getObserverProject,
  listRegisteredObserverProjects,
  readObserverIndex,
  registerObserverProject,
} from './observer-store.mjs';
import { MAX_SNAPSHOT_BYTES, validateObserverSnapshot } from './observer-snapshot.mjs';
import {
  setMemoryMode,
  validateMemoryEvent,
} from './observer-memory.mjs';
import {
  OBSERVER_SQL_FILE,
  OBSERVER_SQL_SCHEMA_VERSION,
  ensureObserverDatabase,
  ingestObserverEvents,
  migrateObserverDatabase,
  readSqlProject,
  listSqlProjects,
  readSqlDocument,
  readSqlSync,
  readSqlTree,
  searchSqlDocuments,
  exportSqlMemoryBundle,
  readTranscript,
  readUsageBreakdown,
  readUsageCalls,
  readUsageSummary,
  registerSqlProject,
} from './observer-sql-store.mjs';
import { migrateObserverContainerData } from './observer-sql-migrate.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const MAX_BODY_BYTES = MAX_SNAPSHOT_BYTES + 4096;
const MAX_MEMORY_BODY_BYTES = 8 * 1024 * 1024;
const MAX_SQL_BODY_BYTES = 64 * 1024 * 1024;
const MAX_SQL_EXPANDED_BODY_BYTES = 256 * 1024 * 1024;
const STATIC_ROOT = fileURLToPath(new URL('../web/observer/', import.meta.url));
const STATIC_ASSETS = new Map([
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/app.mjs', { file: 'app.mjs', type: 'text/javascript; charset=utf-8' }],
  ['/favicon.svg', { file: 'favicon.svg', type: 'image/svg+xml' }],
]);

function loopbackOnly(host) {
  return LOOPBACK_HOSTS.has(String(host || '').toLowerCase());
}

function json(res, status, body) {
  const content = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(content),
  });
  res.end(content);
}

function errorResponse(res, status, code, message) {
  json(res, status, { error: { code, message } });
}

function serveStatic(res, pathname) {
  const asset = STATIC_ASSETS.get(pathname === '/' ? '/index.html' : pathname);
  if (!asset) return false;
  try {
    const body = readFileSync(new URL(asset.file, `file://${STATIC_ROOT.replace(/\\/g, '/')}/`));
    res.writeHead(200, {
      'content-type': asset.type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-length': body.byteLength,
    });
    res.end(body);
  } catch {
    errorResponse(res, 500, 'dashboard_asset_error', 'asset do dashboard indisponível.');
  }
  return true;
}

function readBody(req, maxBytes = MAX_BODY_BYTES, { gunzip = false, expandedMaxBytes = maxBytes } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        const error = new Error('corpo acima do limite.');
        error.code = 'payload_too_large';
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      let body = Buffer.concat(chunks);
      if (gunzip && String(req.headers['content-encoding'] || '').toLowerCase() === 'gzip') {
        try { body = gunzipSync(body); }
        catch {
          const error = new Error('corpo gzip inválido.');
          error.code = 'invalid_content_encoding';
          reject(error);
          return;
        }
        if (body.length > expandedMaxBytes) {
          const error = new Error('corpo expandido acima do limite.');
          error.code = 'payload_too_large';
          reject(error);
          return;
        }
      }
      resolve(body.toString('utf8'));
    });
    req.on('error', reject);
  });
}

function parseJson(text) {
  try { return JSON.parse(text || '{}'); }
  catch {
    const error = new Error('JSON inválido.');
    error.code = 'invalid_json';
    throw error;
  }
}

function pathParts(url) {
  return new URL(url, 'http://127.0.0.1').pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
}

function projectIdFrom(parts) {
  return parts[0] === 'v1' && parts[1] === 'projects' && parts[2] ? parts[2] : '';
}

function ensureSqlProjectRegistration(dataDir, sqlDb, projectId) {
  try {
    if (readSqlProject(sqlDb, projectId)) return true;
  } catch (error) {
    if (error?.code !== 'project_not_registered') throw error;
  }
  const legacy = getObserverProject(dataDir, projectId)
    || listRegisteredObserverProjects(dataDir).find((item) => item.projectId === projectId);
  if (!legacy) return false;
  registerSqlProject(sqlDb, {
    projectId: legacy.projectId,
    projectName: legacy.projectName,
    wendkeepVersion: legacy.snapshot?.wendkeep_version || legacy.wendkeepVersion || '',
  });
  return true;
}

function sqlMemoryEvent(projectId, event) {
  return {
    schema_version: 1,
    event_id: event.event_id,
    kind: event.operation === 'delete' ? 'document.delete' : 'document.upsert',
    project_id: projectId,
    occurred_at: event.captured_at || new Date().toISOString(),
    payload: {
      logical_path: event.logical_path,
      entity_type: event.entity_type,
      content: event.content || '',
      content_hash: event.content_hash || '',
      revision: event.revision || 1,
      source_session_id: event.source_session_id || '',
      source_turn_id: event.source_turn_id || '',
      metadata: event.metadata || {},
    },
  };
}

export async function startObserverServer({
  host = '127.0.0.1',
  port = 8787,
  dataDir,
  allowNonLoopback = false,
} = {}) {
  if (!loopbackOnly(host) && !allowNonLoopback) {
    throw new Error(`Observer HTTP aceita somente host loopback; recebido: ${host}`);
  }
  if (!dataDir) throw new Error('dataDir é obrigatório.');
  const sqlDb = ensureObserverDatabase(dataDir);
  const databaseMigration = migrateObserverDatabase(sqlDb);
  const legacyMigration = migrateObserverContainerData(dataDir, { database: sqlDb });
  const registered = [
    ...listRegisteredObserverProjects(dataDir),
    ...readObserverIndex(dataDir).projects.map((item) => ({
      projectId: item.projectId,
      projectName: item.projectName,
      wendkeepVersion: item.snapshot?.wendkeep_version || '',
    })),
  ];
  for (const project of registered) registerSqlProject(sqlDb, project);
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
      if (req.method === 'GET' && pathname === '/healthz') {
        json(res, 200, {
          ok: true,
          service: 'wendkeep-observer',
          schema_version: 1,
          database: {
            engine: 'sqlite',
            file: OBSERVER_SQL_FILE,
            schema_version: OBSERVER_SQL_SCHEMA_VERSION,
            migrations: databaseMigration.applied.length,
            legacy_migration: legacyMigration,
            ready: true,
          },
        });
        return;
      }
      if (req.method === 'GET' && (pathname === '/' || STATIC_ASSETS.has(pathname))) {
        serveStatic(res, pathname);
        return;
      }
      if (req.method === 'GET' && !pathname.startsWith('/v1/')) {
        errorResponse(res, 404, 'not_found', 'rota não encontrada.');
        return;
      }
      const parts = pathParts(req.url || '/');
      if (parts[0] !== 'v1' || parts[1] !== 'projects') {
        errorResponse(res, 404, 'not_found', 'rota não encontrada.');
        return;
      }

      if (parts.length === 2 && req.method === 'GET') {
        const index = readObserverIndex(dataDir);
        const legacy = new Map(index.projects.map(({ snapshot, ...summary }) => [summary.projectId, summary]));
        for (const project of listSqlProjects(sqlDb)) {
          const current = legacy.get(project.project_id) || {};
          legacy.set(project.project_id, {
            ...current,
            projectId: project.project_id,
            projectName: current.projectName || project.project_name,
            wendkeepVersion: current.wendkeepVersion || project.wendkeep_version,
            registeredAt: current.registeredAt || project.registered_at,
          });
        }
        json(res, 200, {
          schema_version: index.schema_version,
          projects: [...legacy.values()].sort((a, b) => a.projectId.localeCompare(b.projectId)),
        });
        return;
      }

      const projectId = projectIdFrom(parts);
      if (!projectId) {
        errorResponse(res, 404, 'not_found', 'projeto não informado.');
        return;
      }
      ensureSqlProjectRegistration(dataDir, sqlDb, projectId);

      if (parts.length === 4 && parts[3] === 'ingest' && req.method === 'POST') {
        if (!ensureSqlProjectRegistration(dataDir, sqlDb, projectId)) {
          errorResponse(res, 404, 'project_not_found', 'projeto não encontrado: ' + projectId);
          return;
        }
        const body = parseJson(await readBody(req, MAX_SQL_BODY_BYTES, {
          gunzip: true,
          expandedMaxBytes: MAX_SQL_EXPANDED_BODY_BYTES,
        }));
        const events = Array.isArray(body.events) ? body.events : [];
        if (events.length === 0) {
          errorResponse(res, 400, 'invalid_ingest_batch', 'events deve conter pelo menos um evento.');
          return;
        }
        const result = ingestObserverEvents(sqlDb, { projectId, events });
        const status = result.conflicts > 0 ? 409 : result.rejected > 0 ? 400 : result.accepted > 0 ? 201 : 200;
        json(res, status, result);
        return;
      }

      if (parts.length >= 4 && parts[3] === 'usage' && req.method === 'GET') {
        if (!ensureSqlProjectRegistration(dataDir, sqlDb, projectId)) {
          errorResponse(res, 404, 'project_not_found', 'projeto não encontrado: ' + projectId);
          return;
        }
        const query = new URL(req.url || '/', 'http://127.0.0.1').searchParams;
        const filters = {
          from: query.get('from') || '', to: query.get('to') || '', agentId: query.get('agent_id') || '', subagentId: query.get('subagent_id') || '',
          sessionId: query.get('session_id') || '', changeSlug: query.get('change') || query.get('change_slug') || '', role: query.get('role') || '',
          model: query.get('model') || '', provider: query.get('provider') || '', modelProvider: query.get('model_provider') || '',
          limit: query.get('limit') || 100, offset: query.get('offset') || 0,
        };
        if (parts[4] === 'summary') {
          json(res, 200, readUsageSummary(sqlDb, projectId, filters));
          return;
        }
        if (parts[4] === 'breakdown') {
          json(res, 200, readUsageBreakdown(sqlDb, projectId, filters));
          return;
        }
        if (parts[4] === 'calls') {
          json(res, 200, readUsageCalls(sqlDb, projectId, filters));
          return;
        }
      }

      if (parts.length === 5 && parts[3] === 'transcripts' && req.method === 'GET') {
        if (!ensureSqlProjectRegistration(dataDir, sqlDb, projectId)) {
          errorResponse(res, 404, 'project_not_found', 'projeto não encontrado: ' + projectId);
          return;
        }
        try {
          json(res, 200, readTranscript(sqlDb, projectId, parts[4]));
        } catch (error) {
          errorResponse(res, error?.code === 'transcript_not_found' ? 404 : 400, error?.code || 'transcript_error', error?.message || 'transcript indisponível.');
        }
        return;
      }

      if (parts.length === 4 && parts[3] === 'sync' && req.method === 'GET') {
        if (!ensureSqlProjectRegistration(dataDir, sqlDb, projectId)) {
          errorResponse(res, 404, 'project_not_found', 'projeto não encontrado: ' + projectId);
          return;
        }
        json(res, 200, { ...readSqlSync(sqlDb, projectId), mode: 'container-authority' });
        return;
      }

      if (parts.length === 4 && parts[3] === 'sync' && req.method === 'PUT') {
        if (!ensureSqlProjectRegistration(dataDir, sqlDb, projectId)) {
          errorResponse(res, 404, 'project_not_found', 'projeto não encontrado: ' + projectId);
          return;
        }
        const body = parseJson(await readBody(req));
        try {
          json(res, 200, setMemoryMode(dataDir, projectId, body.mode));
        } catch (error) {
          errorResponse(res, 400, error?.code || 'invalid_memory_mode', error?.message || 'modo inválido.');
        }
        return;
      }

      if (parts.length >= 4 && parts[3] === 'memory') {
        if (!ensureSqlProjectRegistration(dataDir, sqlDb, projectId)) {
          errorResponse(res, 404, 'project_not_found', 'projeto não encontrado: ' + projectId);
          return;
        }
        const memoryAction = parts[4] || '';
        if (memoryAction === 'tree' && req.method === 'GET') {
          const query = new URL(req.url || '/', 'http://127.0.0.1').searchParams;
          const tree = readSqlTree(sqlDb, projectId, query.get('prefix') || '');
          json(res, 200, { ...tree, document_count: tree.documents.length });
          return;
        }
        if (memoryAction === 'document' && req.method === 'GET') {
          const query = new URL(req.url || '/', 'http://127.0.0.1').searchParams;
          try {
            json(res, 200, readSqlDocument(sqlDb, projectId, query.get('path') || ''));
          } catch (error) {
            const status = error?.code === 'memory_not_found' ? 404 : 400;
            errorResponse(res, status, error?.code || 'invalid_memory_path', error?.message || 'documento inválido.');
          }
          return;
        }
        if (memoryAction === 'search' && req.method === 'GET') {
          const query = new URL(req.url || '/', 'http://127.0.0.1').searchParams;
          json(res, 200, { project_id: projectId, query: query.get('q') || '', results: searchSqlDocuments(sqlDb, projectId, query.get('q') || '') });
          return;
        }
        if (memoryAction === 'export' && req.method === 'GET') {
          json(res, 200, { ...exportSqlMemoryBundle(sqlDb, projectId), mode: 'container-authority' });
          return;
        }
        if (memoryAction === 'events' && req.method === 'POST') {
          const body = parseJson(await readBody(req, MAX_MEMORY_BODY_BYTES));
          const events = Array.isArray(body.events) ? body.events : [];
          if (events.length === 0) {
            errorResponse(res, 400, 'invalid_memory_batch', 'events deve conter pelo menos um evento.');
            return;
          }
          const validationErrors = [];
          for (const event of events) {
            const validation = validateMemoryEvent(event);
            if (!validation.ok) validationErrors.push(...validation.errors);
          }
          if (validationErrors.length) {
            errorResponse(res, 400, 'invalid_memory_batch', validationErrors.join(' '));
            return;
          }
          const result = ingestObserverEvents(sqlDb, { projectId, events: events.map((event) => sqlMemoryEvent(projectId, event)) });
          const status = result.conflicts > 0 ? 409 : result.rejected > 0 ? 400 : result.accepted > 0 ? 201 : 200;
          json(res, status, result);
          return;
        }
      }

      if (parts.length === 3 && req.method === 'GET') {
        let project = getObserverProject(dataDir, projectId);
        if (!project) {
          try {
            const sqlProject = readSqlProject(sqlDb, projectId);
            project = {
              projectId: sqlProject.project_id,
              projectName: sqlProject.project_name,
              wendkeepVersion: sqlProject.wendkeep_version,
              registeredAt: sqlProject.registered_at,
              eventCount: 0,
            };
          } catch { /* handled as not found below */ }
        }
        if (!project) {
          errorResponse(res, 404, 'project_not_found', `projeto não encontrado: ${projectId}`);
          return;
        }
        json(res, 200, project);
        return;
      }

      if (parts.length === 3 && req.method === 'PUT') {
        const body = parseJson(await readBody(req));
        if (body.project_id !== projectId) {
          errorResponse(res, 400, 'project_mismatch', 'project_id do corpo não corresponde à rota.');
          return;
        }
        const result = registerObserverProject(dataDir, {
          projectId,
          projectName: body.project_name,
          wendkeepVersion: body.wendkeep_version,
        });
        if (!result.registered) {
          errorResponse(res, 400, 'invalid_project', result.errors.join(' '));
          return;
        }
        registerSqlProject(sqlDb, {
          projectId,
          projectName: body.project_name,
          wendkeepVersion: body.wendkeep_version,
        });
        json(res, 201, result.project);
        return;
      }

      if (parts.length === 4 && parts[3] === 'changes' && req.method === 'GET') {
        const project = getObserverProject(dataDir, projectId);
        if (!project) {
          let sqlProject;
          try { sqlProject = readSqlProject(sqlDb, projectId); } catch (error) {
            if (error?.code !== 'project_not_registered') throw error;
          }
          if (!sqlProject) {
            errorResponse(res, 404, 'project_not_found', `projeto não encontrado: ${projectId}`);
            return;
          }
          json(res, 200, { project_id: projectId, changes: [] });
          return;
        }
        json(res, 200, { project_id: projectId, changes: project.snapshot?.changes || [] });
        return;
      }

      if (parts.length === 4 && ['snapshot', 'snapshots'].includes(parts[3]) && req.method === 'POST') {
        const body = parseJson(await readBody(req));
        const validation = validateObserverSnapshot(body, { projectId });
        if (!validation.ok) {
          errorResponse(res, 400, 'invalid_snapshot', validation.errors.join(' '));
          return;
        }
        const result = appendObserverEvent(dataDir, body);
        if (!result.accepted && result.duplicate) {
          json(res, 200, { accepted: false, duplicate: true, event_id: body.event_id });
          return;
        }
        if (!result.accepted) {
          const unregistered = result.errors.some((item) => /não registrado/.test(item));
          errorResponse(res, unregistered ? 409 : 400, unregistered ? 'project_not_registered' : 'invalid_event', result.errors.join(' '));
          return;
        }
        json(res, 201, { accepted: true, duplicate: false, event_id: body.event_id });
        return;
      }

      errorResponse(res, 404, 'not_found', 'rota não encontrada.');
    } catch (error) {
      if (res.headersSent) return;
      const status = error?.code === 'payload_too_large' ? 413 : ['invalid_json', 'invalid_content_encoding'].includes(error?.code) ? 400 : 500;
      errorResponse(res, status, error?.code || 'observer_error', error?.message || 'erro interno do Observer.');
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(Number(port), host);
  });

  return {
    server,
    address: () => server.address(),
    close: () => new Promise((resolve, reject) => server.close((error) => {
      try { sqlDb.close(); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve();
    })),
  };
}
