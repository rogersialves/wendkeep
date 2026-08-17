import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  appendObserverEvent,
  getObserverProject,
  listRegisteredObserverProjects,
  readObserverIndex,
  registerObserverProject,
} from './observer-store.mjs';
import { MAX_SNAPSHOT_BYTES, validateObserverSnapshot } from './observer-snapshot.mjs';
import {
  applyMemoryEvent,
  exportMemoryBundle,
  readMemoryDocument,
  readMemorySync,
  readMemoryTree,
  setMemoryMode,
  searchMemory,
  validateMemoryEvent,
} from './observer-memory.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const MAX_BODY_BYTES = MAX_SNAPSHOT_BYTES + 4096;
const MAX_MEMORY_BODY_BYTES = 8 * 1024 * 1024;
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

function readBody(req, maxBytes = MAX_BODY_BYTES) {
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
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'));
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

function projectKnown(dataDir, projectId) {
  return Boolean(
    getObserverProject(dataDir, projectId)
    || listRegisteredObserverProjects(dataDir).some((item) => item.projectId === projectId),
  );
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
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
      if (req.method === 'GET' && pathname === '/healthz') {
        json(res, 200, { ok: true, service: 'wendkeep-observer', schema_version: 1 });
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
        json(res, 200, {
          schema_version: index.schema_version,
          projects: index.projects.map(({ snapshot, ...summary }) => summary),
        });
        return;
      }

      const projectId = projectIdFrom(parts);
      if (!projectId) {
        errorResponse(res, 404, 'not_found', 'projeto não informado.');
        return;
      }

      if (parts.length === 4 && parts[3] === 'sync' && req.method === 'GET') {
        if (!projectKnown(dataDir, projectId)) {
          errorResponse(res, 404, 'project_not_found', 'projeto não encontrado: ' + projectId);
          return;
        }
        json(res, 200, readMemorySync(dataDir, projectId));
        return;
      }

      if (parts.length === 4 && parts[3] === 'sync' && req.method === 'PUT') {
        if (!projectKnown(dataDir, projectId)) {
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
        if (!projectKnown(dataDir, projectId)) {
          errorResponse(res, 404, 'project_not_found', 'projeto não encontrado: ' + projectId);
          return;
        }
        const memoryAction = parts[4] || '';
        if (memoryAction === 'tree' && req.method === 'GET') {
          const query = new URL(req.url || '/', 'http://127.0.0.1').searchParams;
          json(res, 200, readMemoryTree(dataDir, projectId, query.get('prefix') || ''));
          return;
        }
        if (memoryAction === 'document' && req.method === 'GET') {
          const query = new URL(req.url || '/', 'http://127.0.0.1').searchParams;
          try {
            json(res, 200, readMemoryDocument(dataDir, projectId, query.get('path') || ''));
          } catch (error) {
            const status = error?.code === 'memory_not_found' ? 404 : 400;
            errorResponse(res, status, error?.code || 'invalid_memory_path', error?.message || 'documento inválido.');
          }
          return;
        }
        if (memoryAction === 'search' && req.method === 'GET') {
          const query = new URL(req.url || '/', 'http://127.0.0.1').searchParams;
          json(res, 200, { project_id: projectId, query: query.get('q') || '', results: searchMemory(dataDir, projectId, query.get('q') || '') });
          return;
        }
        if (memoryAction === 'export' && req.method === 'GET') {
          json(res, 200, exportMemoryBundle(dataDir, projectId));
          return;
        }
        if (memoryAction === 'events' && req.method === 'POST') {
          const body = parseJson(await readBody(req, MAX_MEMORY_BODY_BYTES));
          const events = Array.isArray(body.events) ? body.events : [];
          if (events.length === 0) {
            errorResponse(res, 400, 'invalid_memory_batch', 'events deve conter pelo menos um evento.');
            return;
          }
          const results = [];
          for (const event of events) {
            if (event?.project_id !== projectId) {
              results.push({ accepted: false, errors: ['project_id do evento não corresponde à rota.'] });
              continue;
            }
            const validation = validateMemoryEvent(event);
            results.push(validation.ok ? applyMemoryEvent(dataDir, event) : { accepted: false, errors: validation.errors });
          }
          const accepted = results.filter((item) => item.accepted).length;
          const duplicates = results.filter((item) => item.duplicate).length;
          const conflicts = results.filter((item) => item.conflict).length;
          const rejected = results.length - accepted - duplicates - conflicts;
          if (conflicts > 0 || rejected > 0) {
            json(res, conflicts > 0 ? 409 : 400, { accepted, duplicates, conflicts, rejected, results });
            return;
          }
          json(res, accepted > 0 ? 201 : 200, { accepted, duplicates, conflicts, rejected, results });
          return;
        }
      }

      if (parts.length === 3 && req.method === 'GET') {
        const project = getObserverProject(dataDir, projectId);
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
        json(res, 201, result.project);
        return;
      }

      if (parts.length === 4 && parts[3] === 'changes' && req.method === 'GET') {
        const project = getObserverProject(dataDir, projectId);
        if (!project) {
          errorResponse(res, 404, 'project_not_found', `projeto não encontrado: ${projectId}`);
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
      const status = error?.code === 'payload_too_large' ? 413 : error?.code === 'invalid_json' ? 400 : 500;
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
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
