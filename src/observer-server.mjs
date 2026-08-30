import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  listRegisteredObserverProjects,
  readObserverIndexSource,
} from './observer-store.mjs';
import { MAX_SNAPSHOT_BYTES, validateObserverSnapshot } from './observer-snapshot.mjs';
import { validateMemoryEvent } from './observer-memory.mjs';
import {
  OBSERVER_SQL_FILE,
  OBSERVER_SQL_SCHEMA_VERSION,
  bootstrapObserverDatabase,
  ingestObserverEvents,
  readSqlProject,
  readSqlProjectOverview,
  readSqlProjectSnapshot,
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
  upsertSqlProjectSnapshot,
} from './observer-sql-store.mjs';
import { migrateObserverContainerData } from './observer-sql-migrate.mjs';
import { authorizeObserverPrincipal, recordObserverAudit } from '../packages/observer/src/authz.mjs';
import { ensureObserverBootstrapToken, resolveObserverPrincipal } from '../packages/observer/src/token-registry.mjs';
import { readObserverPolicy, saveObserverPolicy } from '../packages/observer/src/policy.mjs';
import { purgeObserverData } from '../packages/observer/src/purge.mjs';
import { runObserverRetention } from '../packages/observer/src/retention.mjs';

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

function bearerToken(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match?.[1] || '';
}

function requestHostname(value) {
  try { return new URL(`http://${String(value || '')}`).hostname.toLowerCase(); }
  catch { return ''; }
}

function validateAuthority(req, { loopback }) {
  const hostname = requestHostname(req.headers.host);
  if (!hostname || (loopback && !LOOPBACK_HOSTS.has(hostname))) {
    return { ok: false, status: 421, code: 'invalid_host', message: 'Host não corresponde ao binding do Observer.' };
  }
  const origin = String(req.headers.origin || '');
  if (origin) {
    let originHostname = '';
    try { originHostname = new URL(origin).hostname.toLowerCase(); } catch { /* invalid below */ }
    if (!originHostname || originHostname !== hostname) {
      return { ok: false, status: 403, code: 'invalid_origin', message: 'Origin não corresponde ao Host do Observer.' };
    }
  }
  return { ok: true };
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

function observerEndpointCapability(method, parts) {
  const action = String(method || 'GET').toUpperCase();
  const resource = parts[3] || '';
  if (parts.length === 2 && action === 'GET') return 'project:read';
  if (parts.length === 3) return action === 'GET' ? 'project:read' : 'project:write';
  if (resource === 'ingest') return 'ingest:write';
  if (resource === 'usage') {
    if (parts[4] === 'calls') return 'usage:calls:read';
    if (parts[4] === 'breakdown') return 'usage:breakdown:read';
    return 'usage:summary:read';
  }
  if (resource === 'transcripts') return 'transcript:read';
  if (resource === 'sync') return action === 'GET' ? 'sync:read' : 'sync:write';
  if (resource === 'memory') {
    if (action !== 'GET') return 'memory:write';
    return parts[4] === 'tree' ? 'memory:metadata:read' : 'memory:content:read';
  }
  if (resource === 'snapshot' || resource === 'snapshots') return 'snapshot:write';
  if (resource === 'security') return 'security:admin';
  return 'project:read';
}

function sensitiveCapability(capability) {
  return ['usage:calls:read', 'transcript:read', 'memory:content:read', 'audit:read', 'security:admin'].includes(capability);
}

function ensureSqlProjectRegistration(dataDir, sqlDb, projectId) {
  try {
    if (readSqlProject(sqlDb, projectId)) return true;
  } catch (error) {
    if (error?.code !== 'project_not_registered') throw error;
  }
  const legacy = listRegisteredObserverProjects(dataDir).find((item) => item.projectId === projectId)
    || readObserverIndexSource(dataDir).projects.find((item) => item.projectId === projectId);
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
  token = '',
  bootstrap = {},
  security = {},
} = {}) {
  if (!loopbackOnly(host) && !allowNonLoopback) {
    throw new Error(`Observer HTTP aceita somente host loopback; recebido: ${host}`);
  }
  if (!loopbackOnly(host) && !token) {
    const error = new Error('Observer non-loopback exige --token ou WENDKEEP_OBSERVER_TOKEN.');
    error.code = 'WENDKEEP_OBSERVER_TOKEN_REQUIRED';
    throw error;
  }
  if (!dataDir) throw new Error('dataDir é obrigatório.');
  const { db: sqlDb, databaseMigration, protectedDataMigration } = bootstrapObserverDatabase(dataDir, { security: {
    policy: security.policy || null,
    encryption: security.encryption || null,
    enforcePolicy: Boolean(security.enabled),
  } });
  const bootstrapToken = token
    ? ensureObserverBootstrapToken(sqlDb, {
      token,
      tokenId: bootstrap.tokenId,
      role: bootstrap.role,
      projectIds: bootstrap.projectIds,
      scopes: bootstrap.scopes,
      expiresAt: bootstrap.expiresAt,
      now: security.clock?.().toISOString?.() || new Date().toISOString(),
    })
    : null;
  const legacyMigration = migrateObserverContainerData(dataDir, {
    database: sqlDb,
    security: {
      policy: security.policy || null,
      encryption: security.encryption || null,
      enforcePolicy: Boolean(security.enabled),
    },
  });
  const registered = [
    ...listRegisteredObserverProjects(dataDir),
    ...readObserverIndexSource(dataDir).projects.map((item) => ({
      projectId: item.projectId,
      projectName: item.projectName,
      wendkeepVersion: item.snapshot?.wendkeep_version || '',
    })),
  ];
  for (const project of registered) registerSqlProject(sqlDb, project);
  for (const project of readObserverIndexSource(dataDir).projects) {
    if (project.snapshot) upsertSqlProjectSnapshot(sqlDb, project.snapshot);
  }
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
      const authority = validateAuthority(req, { loopback: loopbackOnly(host) });
      if (!authority.ok) {
        errorResponse(res, authority.status, authority.code, authority.message);
        return;
      }
      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase());
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
            protected_data_migration: protectedDataMigration,
            legacy_migration: legacyMigration,
            ready: true,
          },
          bootstrap: bootstrapToken ? {
            token_id: bootstrapToken.token_id,
            role: bootstrapToken.role,
            project_ids: bootstrapToken.project_ids,
            expires_at: bootstrapToken.expires_at,
            active: !bootstrapToken.revoked && !bootstrapToken.expired,
          } : null,
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

      let requestPrincipal = null;
      {
        const projectId = projectIdFrom(parts);
        const capability = observerEndpointCapability(req.method, parts);
        const suppliedToken = bearerToken(req);
        const mustAuthenticate = mutating || !loopbackOnly(host) || Boolean(security.requireLoopbackAuth)
          || sensitiveCapability(capability) || Boolean(suppliedToken);
        const authorizationActive = Boolean(security.enabled) || mustAuthenticate;
        const principal = resolveObserverPrincipal(sqlDb, suppliedToken, {
          now: security.clock?.().toISOString?.() || new Date().toISOString(),
        });
        if (!principal.ok && authorizationActive) {
          if (projectId && sensitiveCapability(capability)) recordObserverAudit(sqlDb, {
            projectId,
            tokenId: principal.token_id || '',
            capability,
            outcome: 'denied',
            occurredAt: security.clock?.().toISOString?.() || new Date().toISOString(),
            metadata: { route: pathname, method: req.method || 'GET', reason: principal.code || 'observer_auth_required' },
          });
          const authenticationCode = principal.code === 'observer_token_missing'
            ? 'observer_auth_required'
            : principal.code || 'observer_auth_required';
          errorResponse(res, 401, authenticationCode, 'Bearer token válido é obrigatório para esta operação.');
          return;
        }
        if (principal.ok && authorizationActive) {
          const authorized = authorizeObserverPrincipal(principal, { projectId: projectId || principal.project_ids?.[0] || '*', capability });
          if (!authorized.ok) {
            if (projectId) recordObserverAudit(sqlDb, {
              projectId, tokenId: principal.token_id, capability, outcome: 'denied',
              occurredAt: security.clock?.().toISOString?.() || new Date().toISOString(),
              metadata: { route: pathname, method: req.method || 'GET', reason: authorized.code },
            });
            errorResponse(res, authorized.status, authorized.code, 'Token sem autorização para este projeto/capability.');
            return;
          }
          requestPrincipal = principal;
          if (projectId && sensitiveCapability(capability)) recordObserverAudit(sqlDb, {
            projectId, tokenId: principal.token_id, capability, outcome: 'allowed',
            occurredAt: security.clock?.().toISOString?.() || new Date().toISOString(),
            metadata: { route: pathname, method: req.method || 'GET' },
          });
        }
      }

      if (parts.length === 2 && req.method === 'GET') {
        json(res, 200, {
          schema_version: 1,
          projects: listSqlProjects(sqlDb)
            .filter((project) => !requestPrincipal || requestPrincipal.project_ids?.includes('*') || requestPrincipal.project_ids?.includes(project.project_id))
            .map((project) => readSqlProjectOverview(sqlDb, project.project_id))
            .sort((a, b) => a.projectId.localeCompare(b.projectId)),
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

      if (parts[3] === 'security') {
        if (!ensureSqlProjectRegistration(dataDir, sqlDb, projectId)) {
          errorResponse(res, 404, 'project_not_found', 'projeto não encontrado: ' + projectId);
          return;
        }
        if (parts.length === 4 && req.method === 'GET') {
          const currentTime = security.clock?.().toISOString?.() || new Date().toISOString();
          const tokens = sqlDb.prepare(`SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN revoked_at IS NULL AND expires_at > ? THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked,
            SUM(CASE WHEN revoked_at IS NULL AND expires_at <= ? THEN 1 ELSE 0 END) AS expired
            FROM observer_tokens WHERE project_ids_json LIKE ? OR project_ids_json LIKE '%"*"%'`)
            .get(currentTime, currentTime, `%"${projectId}"%`);
          const recentAudit = sqlDb.prepare(`SELECT audit_id, token_id, capability, outcome, occurred_at, metadata_json
            FROM observer_access_audit WHERE project_id = ? ORDER BY occurred_at DESC LIMIT 50`).all(projectId)
            .map((row) => ({ ...row, metadata: parseJson(row.metadata_json), metadata_json: undefined }));
          json(res, 200, {
            schema_version: 1,
            project_id: projectId,
            policy: readObserverPolicy(sqlDb, projectId),
            tokens: { total: Number(tokens.total) || 0, active: Number(tokens.active) || 0, revoked: Number(tokens.revoked) || 0, expired: Number(tokens.expired) || 0 },
            audit: recentAudit,
            encryption: { configured: Boolean(security.encryption), required: Boolean(security.encryption?.required), key_id: security.encryption?.keyId || '' },
          });
          return;
        }
        if (parts.length === 5 && parts[4] === 'policy' && req.method === 'PUT') {
          const body = parseJson(await readBody(req));
          json(res, 200, { schema_version: 1, project_id: projectId, policy: saveObserverPolicy(sqlDb, projectId, body) });
          return;
        }
        if (parts.length === 5 && parts[4] === 'purge' && req.method === 'POST') {
          const body = parseJson(await readBody(req));
          const result = purgeObserverData(sqlDb, {
            projectId,
            before: body.before,
            classes: body.classes,
            dryRun: body.dry_run === true,
            operationId: body.operation_id || '',
            now: security.clock?.().toISOString?.() || new Date().toISOString(),
          });
          json(res, body.dry_run === true ? 200 : 201, result);
          return;
        }
        if (parts.length === 5 && parts[4] === 'retention' && req.method === 'POST') {
          const body = parseJson(await readBody(req));
          const storedPolicy = readObserverPolicy(sqlDb, projectId);
          const result = runObserverRetention(sqlDb, {
            projectId,
            policy: storedPolicy.retention,
            clock: () => security.clock?.() || new Date(),
            dryRun: body.dry_run === true,
            operationId: body.operation_id || '',
          });
          json(res, body.dry_run === true ? 200 : 201, result);
          return;
        }
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
        if (body.mode && body.mode !== 'container-authority') {
          errorResponse(res, 409, 'sql_authority_fixed', 'O Observer SQL é a autoridade única; modos legados são somente fonte de migração.');
          return;
        }
        json(res, 200, { ...readSqlSync(sqlDb, projectId), mode: 'container-authority', compatibility_noop: true });
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
        let project;
        try { project = readSqlProjectOverview(sqlDb, projectId); } catch { /* handled below */ }
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
        const result = registerSqlProject(sqlDb, {
          projectId,
          projectName: body.project_name,
          wendkeepVersion: body.wendkeep_version,
        });
        if (!result.registered) {
          errorResponse(res, 400, 'invalid_project', result.errors.join(' '));
          return;
        }
        json(res, 201, {
          projectId: result.project.project_id,
          projectName: result.project.project_name,
          wendkeepVersion: result.project.wendkeep_version,
          registeredAt: result.project.registered_at,
        });
        return;
      }

      if (parts.length === 4 && parts[3] === 'changes' && req.method === 'GET') {
        let snapshot;
        try { snapshot = readSqlProjectSnapshot(sqlDb, projectId); } catch (error) {
          if (error?.code !== 'project_not_registered') throw error;
          errorResponse(res, 404, 'project_not_found', `projeto não encontrado: ${projectId}`);
          return;
        }
        json(res, 200, { project_id: projectId, changes: snapshot?.changes || [] });
        return;
      }

      if (parts.length === 4 && ['snapshot', 'snapshots'].includes(parts[3]) && req.method === 'POST') {
        const body = parseJson(await readBody(req));
        const validation = validateObserverSnapshot(body, { projectId });
        if (!validation.ok) {
          errorResponse(res, 400, 'invalid_snapshot', validation.errors.join(' '));
          return;
        }
        const result = upsertSqlProjectSnapshot(sqlDb, body);
        if (!result.accepted && result.duplicate) {
          json(res, 200, { accepted: false, duplicate: true, event_id: body.event_id });
          return;
        }
        if (!result.accepted) {
          if (result.stale) {
            json(res, 200, { accepted: false, stale: true, event_id: body.event_id });
            return;
          }
          errorResponse(res, 400, 'invalid_event', 'snapshot não aceito.');
          return;
        }
        json(res, 201, { accepted: true, duplicate: false, event_id: body.event_id });
        return;
      }

      errorResponse(res, 404, 'not_found', 'rota não encontrada.');
    } catch (error) {
      if (res.headersSent) return;
      const status = error?.code === 'payload_too_large'
        ? 413
        : ['invalid_json', 'invalid_content_encoding', 'observer_policy_invalid', 'observer_purge_invalid', 'observer_retention_invalid'].includes(error?.code)
          ? 400
          : 500;
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
