import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSessionCost } from './cost.mjs';
import {
  configureObserverDatabaseSecurity,
  ensureObserverDatabase,
  ingestObserverEvents,
  registerSqlProject,
} from './observer-sql-store.mjs';

const ROOT_FILES = new Set(['CORE.md', 'DIGEST.md', 'SHARED_MEMORY.md']);
const ROOTS = ['02-Sessões', '04-Decisões', '05-Bugs', '06-Aprendizados', '07-Specs', '08-Mudanças', '.brain'];

function hash(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function text(value, fallback = '') { return String(value ?? fallback); }
function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function parseScalar(raw) {
  const value = text(raw).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1).replaceAll("''", "'");
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

export function parseFrontmatter(content) {
  const match = String(content).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (field) fields[field[1]] = parseScalar(field[2]);
  }
  return fields;
}

function walk(root, relativeRoot, out) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const logicalPath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    if (entry.name.endsWith('.tmp') || entry.name.endsWith('.lock')
      || ['observer-memory-outbox', 'observer-outbox', 'observer-sql-outbox', 'observer-sql-state.json', 'observer-sql-publisher.lock', 'observer-memory-state.json'].includes(entry.name)) continue;
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) walk(absolute, logicalPath, out);
    else if (entry.isFile()) out.push({ absolute, logicalPath });
  }
}

export function listMigrationDocuments(vaultBase) {
  const files = [];
  for (const root of ROOTS) walk(join(vaultBase, root), root, files);
  for (const rootFile of ROOT_FILES) {
    const absolute = join(vaultBase, rootFile);
    if (existsSync(absolute) && statSync(absolute).isFile()) files.push({ absolute, logicalPath: rootFile });
  }
  return files.sort((a, b) => a.logicalPath.localeCompare(b.logicalPath));
}

function entityType(logicalPath) {
  if (logicalPath.startsWith('02-Sessões/')) return 'session';
  if (logicalPath.startsWith('04-Decisões/')) return 'decision';
  if (logicalPath.startsWith('05-Bugs/')) return 'bug';
  if (logicalPath.startsWith('06-Aprendizados/')) return 'learning';
  if (logicalPath.startsWith('07-Specs/')) return 'spec';
  if (logicalPath.startsWith('08-Mudanças/')) return 'change';
  return 'memory';
}

function eventId(kind, projectId, seed) { return `migration-${kind}-${hash(`${projectId}:${seed}`).slice(0, 24)}`; }

function oldMemoryEvent(event) {
  return {
    schema_version: 1,
    event_id: event.event_id,
    kind: event.operation === 'delete' ? 'document.delete' : 'document.upsert',
    project_id: event.project_id,
    occurred_at: event.captured_at || new Date().toISOString(),
    payload: {
      logical_path: event.logical_path,
      entity_type: event.entity_type || entityType(event.logical_path || ''),
      content: event.content || '',
      content_hash: event.content_hash || '',
      revision: event.revision || 1,
      source_session_id: event.source_session_id || '',
      source_turn_id: event.source_turn_id || '',
      metadata: event.metadata || {},
    },
  };
}

function readMemoryEvents(dataDir, projectId) {
  const path = join(dataDir, 'MEMORY_EVENTS.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const event = JSON.parse(line);
      return event.project_id === projectId && event.logical_path ? [event] : [];
    } catch { return []; }
  });
}

export function buildSessionIdentityMap({ projectId, sessionFiles = [] } = {}) {
  const counts = new Map();
  for (const source of sessionFiles) {
    const fm = source.fm || parseFrontmatter(source.content || '');
    const declared = text(fm.session_id) || `historical:${hash(`${projectId}:${source.file.logicalPath}`).slice(0, 20)}`;
    counts.set(declared, (counts.get(declared) || 0) + 1);
  }
  const occurrences = new Map();
  return new Map(sessionFiles.map((source) => {
    const fm = source.fm || parseFrontmatter(source.content || '');
    const declared = text(fm.session_id) || `historical:${hash(`${projectId}:${source.file.logicalPath}`).slice(0, 20)}`;
    const occurrence = occurrences.get(declared) || 0;
    occurrences.set(declared, occurrence + 1);
    const canonical = counts.get(declared) > 1 && occurrence > 0
      ? `${declared}:duplicate:${hash(`${projectId}:${source.file.logicalPath}`).slice(0, 16)}`
      : declared;
    return [source.file.logicalPath, canonical];
  }));
}

function readRegistry(vaultBase) {
  const path = join(vaultBase, '.brain', 'SESSION_REGISTRY.json');
  if (!existsSync(path)) return { sessions: {} };
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return { sessions: {} }; }
}

function transcriptSourceFor(vaultBase, logicalPath, fields) {
  const direct = text(fields.transcript_path || fields.transcriptPath);
  if (direct && existsSync(direct)) return direct;
  const sessionId = text(fields.session_id);
  const entry = Object.entries(readRegistry(vaultBase).sessions || {})
    .find(([id, item]) => id === sessionId || String(item?.session_file || '').replaceAll('\\', '/') === logicalPath)?.[1];
  const candidate = text(entry?.transcript_path || entry?.transcript_paths?.[0]);
  return candidate && existsSync(candidate) ? candidate : '';
}

function ledgerRows(content, cost) {
  const rows = cost.ledger?.length
    ? [...cost.ledger]
    : [{ provider: '', model: cost.model, source: 'main', calls: 0, total: cost.tokens, cost: cost.mainCost }];
  if (!cost.ledger?.length && cost.subCost) rows.push({ provider: '', model: 'subagents (histórico)', source: 'subagent', calls: 0, total: cost.subTokens, cost: cost.subCost });
  const hasField = (key) => new RegExp(`^${key}:\\s*.+$`, 'm').test(content);
  for (const [source, expectedCost, expectedTokens, hasCost, hasTokens] of [
    ['main', Number(cost.mainCost) || 0, Number(cost.tokens) || 0, hasField('custo_modelo_usd'), hasField('tokens_total')],
    ['subagent', Number(cost.subCost) || 0, Number(cost.subTokens) || 0, hasField('subagents_custo_usd'), hasField('subagents_tokens_total')],
  ]) {
    const actual = rows.filter((row) => (text(row.source, 'main') === 'subagent' ? 'subagent' : 'main') === source);
    const actualCost = actual.reduce((sum, row) => sum + (Number(row.cost) || 0), 0);
    const actualTokens = actual.reduce((sum, row) => sum + (Number(row.total) || 0), 0);
    const costDelta = hasCost ? Number((expectedCost - actualCost).toFixed(8)) : 0;
    const tokenDelta = hasTokens ? Math.trunc(expectedTokens - actualTokens) : 0;
    if (Math.abs(costDelta) > 0.00000001 || tokenDelta !== 0) {
      rows.push({
        provider: '', model: 'historical-frontmatter-adjustment', source, calls: 0,
        input: 0, cacheWrite: 0, cached: 0, output: 0, reasoning: 0,
        total: Math.max(0, tokenDelta), cost: costDelta,
        metadata: { source: 'frontmatter-reconciliation', expected_cost: expectedCost, ledger_cost: actualCost },
      });
    }
  }
  return rows;
}

function usageEvent({ projectId, sessionId, agentId, row, index, occurredAt, provider, revision = 1, fingerprint = '' }) {
  const source = text(row.source, 'main');
  const role = source === 'subagent' ? 'subagent' : 'main';
  return {
    schema_version: 1,
    event_id: eventId('usage', projectId, `${sessionId}:${source}:${row.provider || ''}:${row.model || ''}:${index}:${revision}:${fingerprint}`),
    kind: 'usage.rollup',
    project_id: projectId,
    occurred_at: occurredAt,
    payload: {
      rollup_key: `${projectId}:${sessionId}:${agentId}:${row.provider || ''}:${row.model || ''}`,
      revision,
      session_id: sessionId,
      agent_id: agentId,
      role,
      provider,
      model_provider: row.provider || '',
      model: row.model || '?',
      effort: row.effort || '',
      calls: Number(row.calls) || 0,
      tokens: {
        input: Number(row.input) || 0,
        cache_write: Number(row.cacheWrite) || 0,
        cache_read: Number(row.cached ?? row.cacheRead) || 0,
        output: Number(row.output) || 0,
        reasoning: Number(row.reasoning) || 0,
        total: Number(row.total) || 0,
      },
      cost_usd: Number(row.cost) || 0,
      cost_status: row.cost ? 'known' : 'unknown',
      pricing_source: 'historical-frontmatter',
      pricing_version: 'historical',
      metadata: { migrated: true, source: 'custo_por_modelo_json', ...(row.metadata || {}) },
    },
  };
}

export function sessionEvents({ projectId, logicalPath, content, cost, revision = 1, sessionId: sessionIdOverride = '' }) {
  const fm = parseFrontmatter(content);
  const sessionId = text(sessionIdOverride) || text(fm.session_id) || `historical:${hash(`${projectId}:${logicalPath}`).slice(0, 20)}`;
  const fingerprint = hash(content).slice(0, 24);
  const provider = text(fm.provider);
  const occurredAt = text(fm.ended_at || fm.updated_at || fm.date, new Date().toISOString());
  const mainAgentId = `${projectId}:${sessionId}:main`;
  const events = [
    {
      schema_version: 1, event_id: eventId('session', projectId, `${logicalPath}:${fingerprint}`), kind: 'session.upsert', project_id: projectId, occurred_at: occurredAt,
      payload: { session_id: sessionId, provider, status: text(fm.status, 'unknown'), summary: text(fm.summary), change_slug: text(fm.change_slug), started_at: fm.started_at || null, ended_at: fm.ended_at || null, metadata: { migrated: true, logical_path: logicalPath } },
    },
    {
      schema_version: 1, event_id: eventId('agent', projectId, `${logicalPath}:main:${fingerprint}`), kind: 'agent.upsert', project_id: projectId, occurred_at: occurredAt,
      payload: { agent_id: mainAgentId, session_id: sessionId, role: 'main', agent_name: provider, agent_type: provider, status: text(fm.status, 'unknown'), model: text(fm.modelo), effort: text(fm.nivel_pensamento), started_at: fm.started_at || null, ended_at: fm.ended_at || null },
    },
  ];
  for (const [index, row] of ledgerRows(content, cost).entries()) {
    const role = text(row.source, 'main') === 'subagent' ? 'subagent' : 'main';
    const agentId = role === 'main' ? mainAgentId : `${projectId}:${sessionId}:subagent:${index}`;
    if (role === 'subagent') {
      events.push({
        schema_version: 1, event_id: eventId('agent', projectId, `${logicalPath}:subagent:${index}:${fingerprint}`), kind: 'agent.upsert', project_id: projectId, occurred_at: occurredAt,
        payload: { agent_id: agentId, session_id: sessionId, parent_agent_id: mainAgentId, role, agent_name: text(row.agent_nickname || row.agentType, 'historical-subagent'), agent_type: 'historical-subagent', status: 'done', model: text(row.model) },
      });
    }
    events.push(usageEvent({ projectId, sessionId, agentId, row, index, occurredAt, provider, revision, fingerprint }));
  }
  const transcriptId = text(fm.observability_transcript_id || fm.observability_transcript_id);
  if (transcriptId) events.push({
    schema_version: 1, event_id: eventId('transcript', projectId, `${logicalPath}:${transcriptId}:${fingerprint}`), kind: 'transcript.upsert', project_id: projectId, occurred_at: occurredAt,
    payload: { transcript_id: transcriptId, session_id: sessionId, agent_id: mainAgentId, coverage: 'summary_only', content: '', source: 'historical-frontmatter', metadata: { migrated: true } },
  });
  return { events, sessionId, rollups: events.filter((event) => event.kind === 'usage.rollup').length, summaryOnly: transcriptId ? 1 : 0 };
}

export function migrateObserverData({ dataDir, vaultBase, projectId, projectName = projectId, transcriptSources = {}, database = null, security = null } = {}) {
  if (!dataDir || !vaultBase || !projectId) throw new Error('dataDir, vaultBase e projectId são obrigatórios.');
  const db = database || ensureObserverDatabase(dataDir);
  const ownsDatabase = !database;
  try {
    if (security) configureObserverDatabaseSecurity(db, security);
    registerSqlProject(db, { projectId, projectName });
    const stats = { project_id: projectId, documents: 0, sessions: 0, rollups: 0, summary_only_transcripts: 0, accepted: 0, duplicates: 0, conflicts: 0, rejected: 0 };
    const sourceEvents = readMemoryEvents(dataDir, projectId);
    const seen = new Set(sourceEvents.map((event) => `${event.logical_path}:${event.revision || 1}`));
    if (sourceEvents.length) {
      const result = ingestObserverEvents(db, { projectId, events: sourceEvents.map(oldMemoryEvent) });
      stats.accepted += result.accepted; stats.duplicates += result.duplicates; stats.conflicts += result.conflicts; stats.rejected += result.rejected;
    }
    const files = listMigrationDocuments(vaultBase);
    const sessionSources = [];
    for (const file of files) {
      const content = readFileSync(file.absolute, 'utf8');
      const fm = parseFrontmatter(content);
      const revision = Number(fm.revision) || 1;
      if (!seen.has(`${file.logicalPath}:${revision}`)) {
        const event = {
          schema_version: 1,
          event_id: eventId('document', projectId, `${file.logicalPath}:${revision}:${hash(content)}`),
          kind: 'document.upsert', project_id: projectId, occurred_at: text(fm.updated_at || fm.ended_at || fm.date, new Date(statSync(file.absolute).mtimeMs).toISOString()),
          payload: { logical_path: file.logicalPath, entity_type: entityType(file.logicalPath), title: file.logicalPath.split('/').pop().replace(/\.md$/i, ''), content, content_hash: hash(content), revision, metadata: fm, source_session_id: text(fm.session_id) },
        };
        const result = ingestObserverEvents(db, { projectId, events: [event] });
        stats.accepted += result.accepted; stats.duplicates += result.duplicates; stats.conflicts += result.conflicts; stats.rejected += result.rejected;
      }
      stats.documents += 1;
      if (fm.type === 'session') sessionSources.push({ file, content });
    }
    const sessionIdentity = buildSessionIdentityMap({ projectId, sessionFiles: sessionSources });
    for (const source of sessionSources) {
      const cost = parseSessionCost(source.content);
      const built = sessionEvents({ projectId, logicalPath: source.file.logicalPath, content: source.content, cost: cost || { model: '?', mainCost: 0, subCost: 0, tokens: 0, subTokens: 0, ledger: [] }, revision: Number(parseFrontmatter(source.content).revision) || 1, sessionId: sessionIdentity.get(source.file.logicalPath) });
      const result = ingestObserverEvents(db, { projectId, events: built.events });
      stats.sessions += 1;
      stats.rollups += built.rollups;
      stats.summary_only_transcripts += built.summaryOnly;
      stats.accepted += result.accepted; stats.duplicates += result.duplicates; stats.conflicts += result.conflicts; stats.rejected += result.rejected;
      const sourceFields = parseFrontmatter(source.content);
      const transcriptId = sourceFields.observability_transcript_id;
      const transcriptSource = transcriptId && (transcriptSources[transcriptId] || transcriptSourceFor(vaultBase, source.file.logicalPath, sourceFields));
      if (transcriptSource) {
        const sessionId = built.sessionId;
        const transcriptContent = existsSync(transcriptSource) ? readFileSync(transcriptSource, 'utf8') : String(transcriptSource);
        const agentId = `${projectId}:${sessionId}:main`;
        const event = {
          schema_version: 1, event_id: eventId('transcript-content', projectId, `${source.file.logicalPath}:${transcriptId}`), kind: 'transcript.upsert', project_id: projectId,
          occurred_at: new Date().toISOString(), payload: { transcript_id: transcriptId, session_id: sessionId, agent_id: agentId, coverage: 'complete', content: transcriptContent, source: 'migration-source' },
        };
        const imported = ingestObserverEvents(db, { projectId, events: [event] });
        stats.accepted += imported.accepted; stats.duplicates += imported.duplicates; stats.conflicts += imported.conflicts; stats.rejected += imported.rejected;
        if (imported.accepted) stats.summary_only_transcripts = Math.max(0, stats.summary_only_transcripts - 1);
      }
    }
    return stats;
  } finally { if (ownsDatabase) db.close(); }
}

export function migrateObserverContainerData(dataDir, { database = null, security = null } = {}) {
  const memoryRoot = join(dataDir, 'memory');
  if (!existsSync(memoryRoot)) return { skipped: true, projects: 0, documents: 0, events: 0 };
  const markerPath = join(dataDir, 'observer-sql-legacy-migration.json');
  const sourceFiles = [join(dataDir, 'MEMORY_EVENTS.jsonl'), join(dataDir, 'MEMORY_INDEX.json')]
    .filter((path) => existsSync(path))
    .map((path) => { const stat = statSync(path); return `${path}:${stat.size}:${stat.mtimeMs}`; });
  const signature = hash(sourceFiles.join('|'));
  const marker = existsSync(markerPath) ? readJson(markerPath, null) : null;
  if (marker?.signature === signature) return { skipped: true, projects: Number(marker.projects || 0), documents: Number(marker.documents || 0), events: Number(marker.events || 0) };
  const index = readJson(join(dataDir, 'MEMORY_INDEX.json'), { projects: {} });
  const projectIds = new Set(Object.keys(index.projects || {}));
  for (const entry of readdirSync(memoryRoot, { withFileTypes: true })) if (entry.isDirectory()) projectIds.add(entry.name);
  const stats = { skipped: false, projects: 0, documents: 0, events: 0, accepted: 0, duplicates: 0, conflicts: 0, rejected: 0 };
  for (const projectId of projectIds) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/.test(projectId)) continue;
    const project = index.projects?.[projectId] || {};
    const result = migrateObserverData({
      dataDir,
      vaultBase: join(memoryRoot, projectId),
      projectId,
      projectName: project.project_name || projectId,
      database,
      security,
    });
    stats.projects += 1;
    stats.documents += result.documents;
    stats.events += result.accepted;
    stats.accepted += result.accepted;
    stats.duplicates += result.duplicates;
    stats.conflicts += result.conflicts;
    stats.rejected += result.rejected;
  }
  writeFileSync(markerPath, `${JSON.stringify({ signature, ...stats }, null, 2)}\n`, 'utf8');
  return stats;
}
