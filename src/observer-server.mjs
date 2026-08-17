import { createServer } from 'node:http';
import { appendObserverEvent, getObserverProject, readObserverIndex, registerObserverProject } from './observer-store.mjs';
import { MAX_SNAPSHOT_BYTES, validateObserverSnapshot } from './observer-snapshot.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const MAX_BODY_BYTES = MAX_SNAPSHOT_BYTES + 4096;

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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

function authorized(req, token) {
  if (!token) return false;
  const header = String(req.headers.authorization || '');
  return header === `Bearer ${token}`
    || req.headers['x-wendkeep-observer-token'] === token;
}

function pathParts(url) {
  return new URL(url, 'http://127.0.0.1').pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
}

function projectIdFrom(parts) {
  return parts[0] === 'v1' && parts[1] === 'projects' && parts[2] ? parts[2] : '';
}

export async function startObserverServer({
  host = '127.0.0.1',
  port = 8787,
  dataDir,
  token = process.env.WENDKEEP_OBSERVER_TOKEN || '',
  allowNonLoopback = false,
} = {}) {
  if (!loopbackOnly(host) && !allowNonLoopback) {
    throw new Error(`Observer HTTP aceita somente host loopback; recebido: ${host}`);
  }
  if (!dataDir) throw new Error('dataDir é obrigatório.');
  const server = createServer(async (req, res) => {
    try {
      const parts = pathParts(req.url || '/');
      if (req.method === 'GET' && parts.length === 1 && parts[0] === 'healthz') {
        json(res, 200, { ok: true, service: 'wendkeep-observer', schema_version: 1 });
        return;
      }
      if (!authorized(req, token)) {
        errorResponse(res, 401, 'unauthorized', 'token local ausente ou inválido.');
        return;
      }
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
