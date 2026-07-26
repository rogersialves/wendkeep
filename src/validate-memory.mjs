import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateMemoryEvent, validateSharedMemory } from '../hooks/memory-schema.mjs';
import { validateCore } from './validate-core.mjs';

function failedComponent(errors, extra = {}) {
  return { ok: false, errors: Array.isArray(errors) ? errors : [errors], warnings: [], ...extra };
}

function readRequired(path, label) {
  if (!existsSync(path)) return { ok: false, error: `${label} ausente: ${path}` };
  try {
    return { ok: true, content: readFileSync(path, 'utf8') };
  } catch (error) {
    return { ok: false, error: `${label} ilegível: ${error?.message || error}` };
  }
}

export function readProjectForValidation(vaultBase) {
  const path = join(vaultBase, '.brain', 'PROJECT.json');
  const read = readRequired(path, 'PROJECT.json');
  if (!read.ok) return failedComponent(read.error, { projectId: '', path });
  try {
    const marker = JSON.parse(read.content);
    if (!marker || typeof marker.projectId !== 'string' || !marker.projectId) {
      return failedComponent('PROJECT.json inválido: projectId ausente.', { projectId: '', path });
    }
    return { ok: true, errors: [], warnings: [], projectId: marker.projectId, marker, path };
  } catch (error) {
    return failedComponent(`PROJECT.json contém JSON inválido: ${error?.message || error}`, { projectId: '', path });
  }
}

/** Read and validate the append-only JSONL authority without repairing or mutating it. */
export function readLedgerForValidation(vaultBase, { projectId } = {}) {
  const path = join(vaultBase, '.brain', 'MEMORY_EVENTS.jsonl');
  const read = readRequired(path, 'MEMORY_EVENTS.jsonl');
  if (!read.ok) return failedComponent(read.error, { events: [], eventIds: new Set(), path });

  const errors = [];
  const warnings = [];
  const events = [];
  const eventIds = new Set();
  const normalized = read.content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const logicalLines = normalized === '' ? [] : (normalized.endsWith('\n') ? lines.slice(0, -1) : lines);
  logicalLines.forEach((line, index) => {
    if (!line.trim()) {
      errors.push(`MEMORY_EVENTS.jsonl linha ${index + 1} está vazia no meio do ledger.`);
      return;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      errors.push(`MEMORY_EVENTS.jsonl linha ${index + 1} contém JSON inválido/parcial: ${error?.message || error}`);
      return;
    }
    const validation = validateMemoryEvent(event, projectId ? { projectId } : {});
    for (const error of validation.errors) errors.push(`MEMORY_EVENTS.jsonl linha ${index + 1}: ${error}`);
    for (const warning of validation.warnings) warnings.push(`MEMORY_EVENTS.jsonl linha ${index + 1}: ${warning}`);
    if (typeof event?.event_id === 'string' && event.event_id) {
      if (eventIds.has(event.event_id)) errors.push(`MEMORY_EVENTS.jsonl event_id duplicado: ${event.event_id}.`);
      eventIds.add(event.event_id);
    }
    events.push(event);
  });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    events,
    eventIds,
    lineCount: logicalLines.length,
    path,
  };
}

function validateCoreArtifact(vaultBase) {
  const path = join(vaultBase, '.brain', 'CORE.md');
  const read = readRequired(path, 'CORE.md');
  if (!read.ok) return failedComponent(read.error, { lineCount: 0, path });
  return { ...validateCore(read.content), path, content: read.content };
}

function validateSharedArtifact(vaultBase, eventIds) {
  const path = join(vaultBase, '.brain', 'SHARED_MEMORY.md');
  const read = readRequired(path, 'SHARED_MEMORY.md');
  if (!read.ok) return failedComponent(read.error, { path });
  return { ...validateSharedMemory(read.content, { eventIds }), path, content: read.content };
}

export function combineMemoryResults({ project, core, ledger, shared }) {
  const components = { project, core, ledger, shared };
  const errors = [];
  const warnings = [];
  for (const [name, result] of Object.entries(components)) {
    for (const error of result?.errors || []) errors.push(`${name}: ${error}`);
    for (const warning of result?.warnings || []) warnings.push(`${name}: ${warning}`);
  }
  return { ok: errors.length === 0, errors, warnings, ...components };
}

/**
 * Validate the v2 local memory bundle as a read-only composition. Missing/corrupt
 * artifacts remain explicit failures; they are never silently treated as empty.
 */
export function validateMemoryBundle(vaultBase) {
  const project = readProjectForValidation(vaultBase);
  const core = validateCoreArtifact(vaultBase);
  const ledger = readLedgerForValidation(vaultBase, { projectId: project.projectId });
  const shared = validateSharedArtifact(vaultBase, ledger.eventIds);
  return combineMemoryResults({ project, core, ledger, shared });
}
