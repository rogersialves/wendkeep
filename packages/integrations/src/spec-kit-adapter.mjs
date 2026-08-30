import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

import { assessBridgeAdapter } from './bridge-config.mjs';
import {
  bridgeSha256, canonicalBridgeJson, createBridgeProjection, detectBridgeDrift,
  sealBridgeProjection, validateBridgeProjection, validateBridgeRuntimeEnvelope,
} from './bridge-contract.mjs';
import { bridgeDiagnostic } from './bridge-diagnostics.mjs';

const MAX_SOURCE_FILES = 256;
const MAX_SOURCE_BYTES = 1024 * 1024;

function inside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function findMarkdownFiles(root, fs) {
  const { existsSync, lstatSync, readdirSync } = fs;
  const files = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(path);
        if (files.length > MAX_SOURCE_FILES) throw Object.assign(new Error('Spec Kit source exceeds file limit'), { code: 'BRIDGE_SOURCE_LIMIT' });
      }
    }
  }
  if (existsSync(root)) {
    const stat = lstatSync(root);
    if (stat.isDirectory() && !stat.isSymbolicLink()) visit(root);
  }
  return files.sort();
}

function sourceKind(path) {
  const name = basename(path).toLowerCase();
  if (name === 'constitution.md') return 'constitution';
  if (name === 'tasks.md') return 'task';
  if (name === 'plan.md') return 'plan';
  return 'spec';
}

function idsFor(kind, content, path) {
  const patterns = kind === 'task'
    ? [/\b(T\d{3,})\b/g]
    : kind === 'constitution'
      ? [/\b(CONST-[A-Z0-9-]+)\b/g]
      : kind === 'spec'
        ? [/\b([A-Z][A-Z0-9]*-\d+)\b/g, /\b(US\d+)\b/g]
        : [];
  const ids = [];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) if (!ids.includes(match[1])) ids.push(match[1]);
  }
  if (ids.length) return ids;
  const rel = path.replaceAll('\\', '/');
  return [`${rel.replace(/\.md$/i, '').replace(/[^a-zA-Z0-9_-]+/g, ':')}`];
}

function featureFor(projectRoot, path) {
  const parts = relative(projectRoot, path).replaceAll('\\', '/').split('/');
  const specsIndex = parts.lastIndexOf('specs');
  const change_slug = specsIndex >= 0 ? String(parts[specsIndex + 1] || '') : '';
  return { change_slug, capability: change_slug.replace(/^\d+[-_]?/, '') || change_slug };
}

function linkedTasks(content) {
  const links = new Map();
  for (const line of String(content).split(/\r?\n/)) {
    const taskId = line.match(/\b(T\d{3,})\b/)?.[1];
    if (!taskId) continue;
    for (const match of line.matchAll(/\b([A-Z][A-Z0-9]*-\d+|US\d+)\b/g)) {
      const ids = links.get(match[1]) || [];
      if (!ids.includes(taskId)) ids.push(taskId);
      links.set(match[1], ids);
    }
  }
  return links;
}

function titleFor(content) {
  return String(content).match(/^#\s+(.+)$/m)?.[1]?.trim().slice(0, 300) || '';
}

export function detectSpecKit({ projectRoot, config, fs = null } = {}) {
  if (!fs || ['existsSync', 'lstatSync', 'readFileSync', 'realpathSync'].some((name) => typeof fs[name] !== 'function')) {
    return {
      present: false,
      source: resolve(projectRoot, config?.adapters?.['spec-kit']?.root || '.specify'),
      version: '',
      assessment: { available: false, diagnostics: [bridgeDiagnostic('BRIDGE_SOURCE_INVALID', {
        adapter: 'spec-kit', message: 'bridge filesystem capability is unavailable',
      })] },
    };
  }
  const { existsSync, lstatSync, readFileSync, realpathSync } = fs;
  const adapter = config?.adapters?.['spec-kit'] || { enabled: false };
  const source = resolve(projectRoot, adapter.root || '.specify');
  if (!adapter.enabled) {
    return { present: existsSync(source), source, version: '', assessment: assessBridgeAdapter('spec-kit', { config, present: existsSync(source) }) };
  }
  if (!existsSync(source) || !lstatSync(source).isDirectory()) {
    return { present: false, source, version: '', assessment: assessBridgeAdapter('spec-kit', { config, present: false }) };
  }
  const projectReal = realpathSync(projectRoot);
  const sourceReal = realpathSync(source);
  if (!inside(projectReal, sourceReal)) {
    return {
      present: false,
      source,
      version: '',
      assessment: { available: false, diagnostics: [bridgeDiagnostic('BRIDGE_SOURCE_INVALID', { adapter: 'spec-kit', path: source })] },
    };
  }
  const versionPath = resolve(sourceReal, 'version');
  const version = adapter.version || (existsSync(versionPath) ? readFileSync(versionPath, 'utf8').trim() : '');
  return { present: true, source: sourceReal, version, assessment: assessBridgeAdapter('spec-kit', { config, detectedVersion: version }) };
}

export function importSpecKitProjection({ projectRoot, config, previousProjection = null, fs = null } = {}) {
  const detected = detectSpecKit({ projectRoot: resolve(projectRoot), config, fs });
  if (!detected.assessment.available) {
    const disabled = detected.assessment.diagnostics.every((item) => !item.blocking);
    return {
      schema_version: 1,
      adapter: 'spec-kit',
      authority: 'reported',
      active: false,
      ok: disabled,
      references: [],
      diagnostics: detected.assessment.diagnostics,
    };
  }
  try {
    if (!fs || ['lstatSync', 'readFileSync', 'readdirSync'].some((name) => typeof fs[name] !== 'function')) {
      throw Object.assign(new Error('bridge filesystem capability is unavailable'), { code: 'BRIDGE_SOURCE_INVALID' });
    }
    const { lstatSync, readFileSync } = fs;
    const files = [
      ...findMarkdownFiles(resolve(detected.source, 'memory'), fs),
      ...findMarkdownFiles(resolve(detected.source, 'specs'), fs),
    ];
    const references = [];
    const taskLinks = new Map();
    for (const path of [...new Set(files)]) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) {
        throw Object.assign(new Error(`Spec Kit source exceeds byte limit: ${path}`), { code: 'BRIDGE_SOURCE_LIMIT' });
      }
      const content = readFileSync(path, 'utf8');
      const kind = sourceKind(path);
      const relativePath = relative(projectRoot, path).replaceAll('\\', '/');
      const sha256 = bridgeSha256(content);
      if (kind === 'task') {
        for (const [sourceId, taskIds] of linkedTasks(content)) {
          const current = taskLinks.get(sourceId) || [];
          taskLinks.set(sourceId, [...new Set([...current, ...taskIds])]);
        }
      }
      for (const source_id of idsFor(kind, content, relativePath)) {
        references.push({ kind, source_id, path: relativePath, sha256, title: titleFor(content) });
      }
    }
    const duplicateDiagnostics = [];
    const seenIds = new Map();
    for (const reference of references) {
      const firstPath = seenIds.get(reference.source_id);
      if (firstPath && firstPath !== reference.path) {
        duplicateDiagnostics.push(bridgeDiagnostic('BRIDGE_SOURCE_ID_DUPLICATE', {
          adapter: 'spec-kit', path: reference.path, expected: firstPath, observed: reference.path,
          message: `external source id is duplicated: ${reference.source_id}`,
        }));
      } else seenIds.set(reference.source_id, reference.path);
    }
    const mappings = references.filter((item) => item.kind === 'spec').map((item) => {
      const feature = featureFor(projectRoot, resolve(projectRoot, item.path));
      return {
        source_id: item.source_id,
        source_kind: /^(?:US-?\d+|STORY-\d+)$/.test(item.source_id) ? 'story' : 'requirement',
        capability: feature.capability,
        change_slug: feature.change_slug,
        task_ids: taskLinks.get(item.source_id) || [],
      };
    });
    const adapterClaims = config?.adapters?.['spec-kit']?.ownership_claims || [];
    const projection = createBridgeProjection({
      adapter: 'spec-kit',
      adapterVersion: detected.version,
      sourceRoot: relative(projectRoot, detected.source),
      claims: [
        { concept: 'spec_source', owner: 'wendkeep' },
        { concept: 'plan', owner: 'wendkeep' },
        { concept: 'task', owner: 'wendkeep' },
        ...adapterClaims,
      ],
      references,
      mappings,
    });
    const drift = previousProjection ? detectBridgeDrift(previousProjection, projection) : { ok: true, diagnostics: [] };
    return sealBridgeProjection({
      ...projection,
      active: true,
      ok: projection.ok && drift.ok && duplicateDiagnostics.length === 0,
      diagnostics: [...projection.diagnostics, ...duplicateDiagnostics, ...drift.diagnostics],
    });
  } catch (error) {
    return {
      schema_version: 1,
      adapter: 'spec-kit',
      authority: 'reported',
      active: true,
      ok: false,
      references: [],
      diagnostics: [bridgeDiagnostic(error?.code || 'BRIDGE_SOURCE_INVALID', {
        adapter: 'spec-kit', path: detected.source, message: error?.message || String(error),
      })],
    };
  }
}

export function buildSpecKitStatusProjection({ sourceProjection, taskContracts = [], artifacts = [] } = {}) {
  const sourceValidation = validateBridgeProjection(sourceProjection);
  if (sourceProjection?.adapter !== 'spec-kit' || sourceProjection?.ok !== true || !sourceValidation.valid) {
    throw Object.assign(new Error('a valid Spec Kit source projection is required'), { code: 'BRIDGE_CONTRACT_INVALID' });
  }
  const projection = {
    schema_version: 1,
    contract_kind: 'status-projection',
    adapter: 'spec-kit',
    mode: 'status-projection',
    source_projection_id: String(sourceProjection.projection_id),
    authority: 'reported',
    canonical_owner: 'wendkeep',
    origin: { tool: 'wendkeep', source_projection_id: String(sourceProjection.projection_id) },
    provenance: { state: 'reported', source: 'canonical-status-export' },
    tasks: (Array.isArray(taskContracts) ? taskContracts : []).map((task) => ({
      task_id: String(task?.task_id || ''),
      contract_id: String(task?.contract_id || ''),
      status: String(task?.status || ''),
    })),
    evidence: (Array.isArray(artifacts) ? artifacts : []).map((artifact) => ({
      external_id: String(artifact?.external_id || ''),
      sha256: String(artifact?.sha256 || ''),
      authority: 'reported',
    })),
  };
  projection.status_projection_id = bridgeSha256(canonicalBridgeJson(projection));
  const validation = validateBridgeRuntimeEnvelope(projection);
  if (!validation.valid) {
    throw Object.assign(new Error('generated Spec Kit status projection is invalid'), {
      code: 'BRIDGE_CONTRACT_INVALID', diagnostics: validation.diagnostics,
    });
  }
  return projection;
}
