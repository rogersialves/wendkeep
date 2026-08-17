import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_SNAPSHOT_BYTES, OBSERVER_SCHEMA_VERSION, validateObserverSnapshot } from './observer-snapshot.mjs';

export const OBSERVER_DATA_SCHEMA_VERSION = 1;
export const OBSERVER_EVENTS_FILE = 'EVENTS.jsonl';
export const OBSERVER_INDEX_FILE = 'INDEX.json';
export const OBSERVER_PROJECTS_FILE = 'PROJECTS.json';

function ensureDataDir(dataDir) {
  if (!dataDir) throw new Error('dataDir é obrigatório.');
  mkdirSync(dataDir, { recursive: true });
}

function atomicJson(path, value) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return fallback; }
}

function projectIdValid(projectId) {
  return typeof projectId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/.test(projectId);
}

function registeredProjects(dataDir) {
  const raw = readJson(join(dataDir, OBSERVER_PROJECTS_FILE), {
    schema_version: OBSERVER_DATA_SCHEMA_VERSION,
    projects: {},
  });
  return raw?.schema_version === OBSERVER_DATA_SCHEMA_VERSION && raw.projects && typeof raw.projects === 'object'
    ? raw.projects
    : {};
}

export function registerObserverProject(dataDir, {
  projectId,
  projectName = projectId,
  wendkeepVersion = '',
  registeredAt = new Date().toISOString(),
} = {}) {
  ensureDataDir(dataDir);
  if (!projectIdValid(projectId)) return { registered: false, errors: ['project_id inválido.'] };
  const projects = registeredProjects(dataDir);
  const project = {
    projectId,
    projectName: String(projectName || projectId).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120),
    wendkeepVersion: String(wendkeepVersion || '').slice(0, 40),
    registeredAt: String(registeredAt),
  };
  projects[projectId] = project;
  atomicJson(join(dataDir, OBSERVER_PROJECTS_FILE), {
    schema_version: OBSERVER_DATA_SCHEMA_VERSION,
    projects,
  });
  return { registered: true, project };
}

export function listRegisteredObserverProjects(dataDir) {
  return Object.values(registeredProjects(dataDir)).sort((a, b) => a.projectId.localeCompare(b.projectId));
}

function readEvents(dataDir) {
  const path = join(dataDir, OBSERVER_EVENTS_FILE);
  if (!existsSync(path)) return [];
  const events = [];
  const lines = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').split('\n').filter((line) => line.trim());
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (validateObserverSnapshot(event).ok) events.push(event);
    } catch { /* corrupt lines never become part of the derived index */ }
  }
  return events;
}

function newer(left, right) {
  const leftTime = Date.parse(left?.captured_at || '') || 0;
  const rightTime = Date.parse(right?.captured_at || '') || 0;
  return leftTime > rightTime || (leftTime === rightTime && String(left?.event_id).localeCompare(String(right?.event_id)) > 0);
}

export function rebuildObserverIndex(dataDir) {
  ensureDataDir(dataDir);
  const byProject = new Map();
  for (const event of readEvents(dataDir)) {
    const current = byProject.get(event.project_id);
    if (!current || newer(event, current.snapshot)) {
      byProject.set(event.project_id, {
        projectId: event.project_id,
        projectName: event.project_name,
        latestEventId: event.event_id,
        capturedAt: event.captured_at,
        snapshot: event,
        eventCount: 0,
      });
    }
  }
  for (const event of readEvents(dataDir)) {
    const item = byProject.get(event.project_id);
    if (item) item.eventCount += 1;
  }
  const index = {
    schema_version: OBSERVER_DATA_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    projects: [...byProject.values()].sort((a, b) => a.projectId.localeCompare(b.projectId)),
  };
  atomicJson(join(dataDir, OBSERVER_INDEX_FILE), index);
  return index;
}

export function readObserverIndex(dataDir) {
  ensureDataDir(dataDir);
  const path = join(dataDir, OBSERVER_INDEX_FILE);
  const index = readJson(path, null);
  if (index?.schema_version === OBSERVER_DATA_SCHEMA_VERSION && Array.isArray(index.projects)) return index;
  return rebuildObserverIndex(dataDir);
}

export function appendObserverEvent(dataDir, event) {
  ensureDataDir(dataDir);
  const validation = validateObserverSnapshot(event);
  if (!validation.ok || validation.size > MAX_SNAPSHOT_BYTES) {
    return { accepted: false, errors: validation.errors || ['snapshot inválido.'] };
  }
  const projects = registeredProjects(dataDir);
  if (!projects[event.project_id]) {
    return { accepted: false, errors: [`project_id não registrado: ${event.project_id}`] };
  }
  const eventsPath = join(dataDir, OBSERVER_EVENTS_FILE);
  const existing = readEvents(dataDir).find((item) => item.event_id === event.event_id);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(event)) {
      return { accepted: false, errors: [`event_id reutilizado com payload diferente: ${event.event_id}`] };
    }
    return { accepted: false, duplicate: true, event_id: event.event_id, index: readObserverIndex(dataDir) };
  }
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
  return {
    accepted: true,
    duplicate: false,
    event_id: event.event_id,
    index: rebuildObserverIndex(dataDir),
  };
}

export function getObserverProject(dataDir, projectId) {
  return readObserverIndex(dataDir).projects.find((project) => project.projectId === projectId) || null;
}
