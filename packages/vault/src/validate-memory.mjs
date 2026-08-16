import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { sanitizeMemoryText, validateMemoryEvent, validateSharedMemory } from './memory-schema.mjs';
import { deriveMemoryProjection } from './memory-store.mjs';
import { assertVaultPathSafe } from './vault-path-safety.mjs';
import { validateCore } from './validate-core.mjs';

function failedComponent(errors, extra = {}) {
  return { ok: false, errors: Array.isArray(errors) ? errors : [errors], warnings: [], ...extra };
}

function readRequired(vaultBase, path, label) {
  let checked;
  try {
    checked = assertVaultPathSafe(vaultBase, path, {
      expectedType: 'file', label: `artefato ${label}`,
    });
  } catch (error) {
    return { ok: false, error: `${label} inseguro: ${error?.message || error}` };
  }
  if (!checked.exists) return { ok: false, error: `${label} ausente: ${path}` };
  try {
    // Deliberately adjacent to the open performed by readFileSync.
    checked = assertVaultPathSafe(vaultBase, checked.target, {
      allowMissing: false, expectedType: 'file', label: `artefato ${label}`,
    });
    return { ok: true, content: readFileSync(checked.target, 'utf8') };
  } catch (error) {
    return { ok: false, error: `${label} ilegível: ${error?.message || error}` };
  }
}

export function readProjectForValidation(vaultBase) {
  const path = join(vaultBase, '.brain', 'PROJECT.json');
  const read = readRequired(vaultBase, path, 'PROJECT.json');
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
  const read = readRequired(vaultBase, path, 'MEMORY_EVENTS.jsonl');
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
  const read = readRequired(vaultBase, path, 'CORE.md');
  if (!read.ok) return failedComponent(read.error, { lineCount: 0, path });
  return { ...validateCore(read.content), path, content: read.content };
}

function validateSharedArtifact(vaultBase, eventIds) {
  const path = join(vaultBase, '.brain', 'SHARED_MEMORY.md');
  const read = readRequired(vaultBase, path, 'SHARED_MEMORY.md');
  if (!read.ok) return failedComponent(read.error, { path });
  return { ...validateSharedMemory(read.content, { eventIds }), path, content: read.content };
}

const TERMINAL_CANDIDATE_STATUSES = new Set(['resolved', 'rejected', 'superseded']);
const DECISION_LINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

function readCandidateInventory(vaultBase) {
  const path = join(vaultBase, '.brain', 'MEMORY_CANDIDATES.jsonl');
  let checked;
  try {
    checked = assertVaultPathSafe(vaultBase, path, {
      allowMissing: true, expectedType: 'file', label: 'MEMORY_CANDIDATES.jsonl',
    });
  } catch (error) {
    return failedComponent(`MEMORY_CANDIDATES.jsonl inseguro: ${error?.message || error}`, {
      count: 0, activeCount: 0, path,
    });
  }
  if (!checked.exists) return { ok: true, errors: [], warnings: [], count: 0, activeCount: 0, path };

  try {
    checked = assertVaultPathSafe(vaultBase, checked.target, {
      allowMissing: false, expectedType: 'file', label: 'MEMORY_CANDIDATES.jsonl',
    });
    const lines = readFileSync(checked.target, 'utf8').replace(/\r\n/g, '\n')
      .split('\n').filter((line) => line.trim());
    const errors = [];
    let count = 0;
    let activeCount = 0;
    for (const [index, line] of lines.entries()) {
      try {
        const item = JSON.parse(line);
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          errors.push(`MEMORY_CANDIDATES.jsonl linha ${index + 1} deve conter um objeto.`);
          continue;
        }
        count += 1;
        if (!TERMINAL_CANDIDATE_STATUSES.has(item.status || 'active')) activeCount += 1;
      } catch (error) {
        errors.push(`MEMORY_CANDIDATES.jsonl linha ${index + 1} contém JSON inválido: ${error?.message || error}`);
      }
    }
    return { ok: errors.length === 0, errors, warnings: [], count, activeCount, path };
  } catch (error) {
    return failedComponent(`MEMORY_CANDIDATES.jsonl ilegível: ${error?.message || error}`, {
      count: 0, activeCount: 0, path,
    });
  }
}

function sharedEventIds(content) {
  const ids = new Set();
  for (const line of String(content || '').split('\n')) {
    const match = line.match(/^\s*-\s+\[([^\]]+)\]/);
    if (match?.[1]) ids.add(match[1]);
  }
  return ids;
}

function walkDecisionFiles(root, vaultBase, output = []) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkDecisionFiles(path, vaultBase, output);
    else if (entry.isFile() && /^ADR-\d+.*\.md$/i.test(entry.name)) {
      const rel = relative(vaultBase, path).replace(/\\/g, '/').replace(/\.md$/i, '');
      output.push(rel);
    }
  }
  return output;
}

function decisionInventory(vaultBase) {
  const paths = [];
  for (const folder of ['04-Decisões', '04-Decisions']) {
    walkDecisionFiles(join(vaultBase, folder), vaultBase, paths);
  }
  const byPath = new Set(paths);
  const byBasename = new Set(paths.map((path) => basename(path)));
  return { byPath, byBasename };
}

function unresolvedDecisionLinks(vaultBase, content) {
  const inventory = decisionInventory(vaultBase);
  const unresolved = new Set();
  DECISION_LINK_RE.lastIndex = 0;
  let match;
  while ((match = DECISION_LINK_RE.exec(String(content || '')))) {
    const target = String(match[1] || '').trim().replace(/\\/g, '/').replace(/\.md$/i, '');
    const targetBase = basename(target);
    const isDecision = /^ADR-\d+/i.test(targetBase)
      || /(^|\/)(?:04-Decis(?:õ|o)es|04-Decisions)(?:\/|$)/i.test(target);
    if (!isDecision) continue;
    if (!target || target.includes('...') || target.includes('…')
        || (!inventory.byPath.has(target) && !inventory.byBasename.has(targetBase))) {
      unresolved.add(sanitizeMemoryText(target).slice(0, 180));
    }
  }
  return [...unresolved].sort();
}

function semanticMemoryHealth(vaultBase, { ledger, shared, candidates }) {
  const base = {
    ok: true,
    status: 'unavailable',
    code: 'MEMORY_SEMANTIC_STRUCTURAL_UNAVAILABLE',
    errors: [],
    warnings: [],
    activeKeys: [],
    projectedKeys: [],
    missingKeys: [],
    unresolvedDecisionLinks: [],
    placeholderOnly: false,
    counts: { activeKeys: 0, projectedKeys: 0, missingKeys: 0, candidates: candidates?.activeCount || 0, placeholderSections: 0, unresolvedDecisionLinks: 0 },
  };
  if (!ledger?.ok || !shared?.ok) return base;

  let replay;
  try { replay = deriveMemoryProjection(vaultBase, ledger.events); }
  catch (error) {
    return {
      ...base,
      ok: false,
      status: 'degraded',
      code: 'MEMORY_SEMANTIC_REPLAY_UNAVAILABLE',
      errors: ['[MEMORY_SEMANTIC_REPLAY_UNAVAILABLE] não foi possível rederivar as chaves ativas do ledger.'],
    };
  }

  const active = Object.entries(replay.records || {}).map(([memoryKey, record]) => ({
    memoryKey: sanitizeMemoryText(memoryKey),
    eventId: record?.source?.event_id,
  }));
  const activeKeys = active.map(({ memoryKey }) => memoryKey).sort();
  const projectedIds = sharedEventIds(shared.content);
  const projectedKeys = active
    .filter(({ eventId }) => projectedIds.has(eventId))
    .map(({ memoryKey }) => memoryKey)
    .sort();
  const missingKeys = active
    .filter(({ eventId }) => !projectedIds.has(eventId))
    .map(({ memoryKey }) => memoryKey)
    .sort();
  const sectionValues = [...(shared.sections?.values?.() || [])].flat();
  const placeholderSections = sectionValues.filter((line) => /^-\s*\(vazio\)\s*$/i.test(line)).length;
  const nonPlaceholderLines = sectionValues.filter((line) => !/^-\s*\(vazio\)\s*$/i.test(line));
  const placeholderOnly = sectionValues.length > 0 && nonPlaceholderLines.length === 0;
  const unresolvedLinks = unresolvedDecisionLinks(vaultBase, shared.content);
  const candidateCount = Math.max(candidates?.activeCount || 0, replay.candidates?.length || 0);
  const errors = [];
  const warnings = [];
  const codes = [];

  if (missingKeys.length && placeholderOnly) {
    codes.push('MEMORY_SEMANTIC_PLACEHOLDER_ONLY');
    errors.push(`[MEMORY_SEMANTIC_PLACEHOLDER_ONLY] SHARED contém somente placeholders para ${activeKeys.length} chave(s) ativa(s); candidates=${candidateCount}.`);
  } else if (missingKeys.length) {
    codes.push('MEMORY_SEMANTIC_COVERAGE_MISSING');
    errors.push(`[MEMORY_SEMANTIC_COVERAGE_MISSING] SHARED não cobre ${missingKeys.length} chave(s) ativa(s): ${missingKeys.join(', ')}.`);
  }
  if (unresolvedLinks.length) {
    codes.push('MEMORY_SEMANTIC_DECISION_LINK_UNRESOLVED');
    errors.push(`[MEMORY_SEMANTIC_DECISION_LINK_UNRESOLVED] ${unresolvedLinks.length} link(s) de decisão não resolvido(s).`);
  }

  let status = 'healthy';
  let code = 'MEMORY_SEMANTIC_COVERAGE_OK';
  if (!ledger.events.length && !candidateCount) {
    status = 'neutral';
    code = 'MEMORY_SEMANTIC_EMPTY_NEUTRAL';
  } else if (!activeKeys.length && candidateCount) {
    status = 'degraded';
    code = 'MEMORY_SEMANTIC_CANDIDATES_PENDING';
    warnings.push(`[MEMORY_SEMANTIC_CANDIDATES_PENDING] ${candidateCount} candidate(s) preservado(s); o estado não é memória vazia.`);
  } else if (codes.length) {
    status = 'degraded';
    code = codes[0];
  }

  return {
    ok: errors.length === 0,
    status,
    code,
    codes,
    errors,
    warnings,
    activeKeys,
    projectedKeys,
    missingKeys,
    unresolvedDecisionLinks: unresolvedLinks,
    placeholderOnly,
    counts: {
      activeKeys: activeKeys.length,
      projectedKeys: projectedKeys.length,
      missingKeys: missingKeys.length,
      candidates: candidateCount,
      placeholderSections,
      unresolvedDecisionLinks: unresolvedLinks.length,
    },
  };
}

export function combineMemoryResults({ project, core, ledger, shared, candidates, semantic }) {
  const components = { project, core, ledger, shared, candidates, semantic };
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
  const candidates = readCandidateInventory(vaultBase);
  const semantic = semanticMemoryHealth(vaultBase, { ledger, shared, candidates });
  return combineMemoryResults({ project, core, ledger, shared, candidates, semantic });
}
