#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import {
  controlPath,
  getVaultBase,
  listMarkdownFiles,
  readControl,
  readSessionRegistry,
  wikilinkFromRel,
} from './obsidian-common.mjs';
import { getLocale } from './locale.mjs';
import { parseSharedMemory, validateMemoryEvent } from './memory-schema.mjs';
import { reduceMemoryEvents } from './memory-store.mjs';
import { validateMemoryBundle } from '../src/validate-memory.mjs';

const DEFAULT_PENDING_PATTERNS = [
  /^- \[ \] Revisar resumo da sessão$/i,
  /^- \[ \] Verificar se houve decisões a registrar$/i,
  /^- \[ \] Verificar se houve bugs a registrar$/i,
  /^- \[ \] Verificar se houve aprendizados a registrar$/i,
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function findDuplicateTurnMarkers(content) {
  const seen = new Set();
  const duplicated = new Set();
  const regex = /<!-- (?:wk-turn|codex-turn): ([^>]+) -->/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const turnId = match[1].trim();
    if (seen.has(turnId)) duplicated.add(turnId);
    seen.add(turnId);
  }
  return [...duplicated];
}

function hasHeadingAfterClosing(content) {
  const closing = content.indexOf('\n## Encerramento');
  if (closing === -1) return false;
  return /\n#{2,3} /.test(content.slice(closing + '\n## Encerramento'.length));
}

function sectionBody(content, heading) {
  const marker = `\n## ${heading}\n`;
  const start = content.indexOf(marker);
  if (start === -1) return '';
  const bodyStart = start + marker.length;
  const next = content.slice(bodyStart).search(/\n## /);
  const bodyEnd = next === -1 ? content.length : bodyStart + next;
  return content.slice(bodyStart, bodyEnd);
}

function hasDefaultPending(content) {
  return sectionBody(content, 'Pendências')
    .split('\n')
    .some((line) => DEFAULT_PENDING_PATTERNS.some((pattern) => pattern.test(line.trim())));
}

function usageSectionIsPlaced(content, { active = false } = {}) {
  const unified = content.indexOf('\n## Agentes, tokens e custos');
  const legacy = content.indexOf('\n## Uso de tokens e custos');
  const usage = unified !== -1 ? unified : legacy;
  if (usage === -1) return true;
  const changed = content.indexOf('\n## Arquivos criados ou alterados');
  const pending = content.indexOf('\n## Pendências');
  const closing = content.indexOf('\n## Encerramento');
  if (pending === -1 || (!active && closing === -1)) return false;
  return usage < pending && (active || usage < closing) && (changed === -1 || usage > changed);
}

function linkedNotesFromSession(content) {
  const notes = [];
  const regex = /\[\[((?:04-Decisões|05-Bugs|06-Aprendizados)\/[^\]]+)\]\]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (!notes.includes(match[1])) notes.push(match[1]);
  }
  return notes;
}

const MEMORY_STATUS_COMMAND = 'wendkeep memory status --gate --vault <vault>';
const MEMORY_REPAIR_COMMAND = 'wendkeep memory repair --vault <vault>';

function readJsonLines(path, label) {
  if (!existsSync(path)) return { items: [], errors: [] };
  const raw = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const lines = raw.endsWith('\n') ? raw.split('\n').slice(0, -1) : raw.split('\n');
  const items = [];
  const errors = [];
  lines.forEach((line, index) => {
    if (!line.trim()) {
      if (raw) errors.push(`${label} linha ${index + 1} está vazia.`);
      return;
    }
    try { items.push(JSON.parse(line)); }
    catch (error) { errors.push(`${label} linha ${index + 1} contém JSON inválido/parcial: ${error.message}`); }
  });
  return { items, errors };
}

function inspectOutbox(vaultBase, projectId) {
  const dir = join(vaultBase, '.brain', 'memory-outbox');
  if (!existsSync(dir)) return { count: 0, errors: [] };
  const files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  const errors = [];
  for (const name of files) {
    const path = join(dir, name);
    try {
      const event = JSON.parse(readFileSync(path, 'utf8'));
      const validation = validateMemoryEvent(event, projectId ? { projectId } : {});
      if (!validation.ok) errors.push(`${name}: ${validation.errors.join(' ')}`);
    } catch (error) {
      errors.push(`${name}: JSON inválido: ${error.message}`);
    }
  }
  return { count: files.length, errors };
}

/**
 * Read-only consistency check for the local memory-v2 bundle. It intentionally
 * does not acquire MEMORY.lock or invoke the projector/repair paths.
 */
export function checkMemoryBundle(vaultBase) {
  const brain = join(vaultBase, '.brain');
  const bundle = validateMemoryBundle(vaultBase);
  const failures = [];
  const warnings = [];
  const parsedShared = typeof bundle.shared?.content === 'string'
    ? parseSharedMemory(bundle.shared.content)
    : { metadata: {} };
  const metadata = parsedShared.metadata || {};
  const outbox = inspectOutbox(vaultBase, bundle.project?.projectId);
  const candidates = readJsonLines(join(brain, 'MEMORY_CANDIDATES.jsonl'), 'MEMORY_CANDIDATES.jsonl');

  const ledgerCorrupt = (bundle.ledger?.errors || []).length > 0;
  if (ledgerCorrupt) {
    for (const error of bundle.ledger.errors) {
      failures.push(`${error} Execute com segurança: ${MEMORY_REPAIR_COMMAND}.`);
    }
  }
  for (const error of bundle.errors || []) {
    if (error.startsWith('ledger:')) continue;
    failures.push(`${error} Inspecione com: ${MEMORY_STATUS_COMMAND}.`);
  }

  if (outbox.errors.length) {
    failures.push(`Outbox corrompida (${outbox.errors.join('; ')}). Inspecione com: ${MEMORY_STATUS_COMMAND}.`);
  }
  if (candidates.errors.length) {
    failures.push(`${candidates.errors.join('; ')} Execute com segurança: ${MEMORY_REPAIR_COMMAND}.`);
  }

  let replay = null;
  if (bundle.ledger?.ok) {
    try { replay = reduceMemoryEvents(bundle.ledger.events); }
    catch (error) {
      failures.push(`Ledger não pode ser reduzido: ${error.message}. Execute com segurança: ${MEMORY_REPAIR_COMMAND}.`);
    }
  }
  if (replay && bundle.shared?.ok) {
    const divergences = [];
    if (metadata.revision !== replay.revision) divergences.push(`revision ${metadata.revision} != ${replay.revision}`);
    if (metadata.event_cursor !== replay.eventCursor) divergences.push(`event_cursor ${metadata.event_cursor} != ${replay.eventCursor}`);
    if (metadata.state_hash !== replay.stateHash) divergences.push(`state_hash ${metadata.state_hash} != ${replay.stateHash}`);
    if (divergences.length) {
      failures.push(`Projeção SHARED stale/lag (${divergences.join('; ')}). Inspecione com: ${MEMORY_STATUS_COMMAND}.`);
    }
  }

  const unresolved = candidates.items.filter((item) => !['resolved', 'rejected', 'superseded'].includes(item?.status));
  const activeConflicts = unresolved.filter((item) => item?.reason === 'conflict');
  const ordinaryCandidates = unresolved.filter((item) => item?.reason !== 'conflict');
  if (activeConflicts.length) {
    failures.push(`${activeConflicts.length} conflito ativo em chave operacional (${activeConflicts.map((item) => item.memory_key || item.candidate_id).join(', ')}). Inspecione com: ${MEMORY_STATUS_COMMAND}.`);
  }
  if (outbox.count) warnings.push(`${outbox.count} evento(s) pendente(s) na outbox; execute o projector quando seguro.`);
  if (ordinaryCandidates.length) warnings.push(`${ordinaryCandidates.length} candidate(s) aguardando curadoria humana.`);
  for (const warning of bundle.warnings || []) warnings.push(warning);

  const ok = failures.length === 0;
  return {
    ok,
    status: ok ? (warnings.length ? 'warning' : 'healthy') : 'blocked',
    failures,
    warnings,
    metrics: {
      schemaVersion: metadata.schema_version ?? null,
      revision: metadata.revision ?? null,
      eventCursor: metadata.event_cursor ?? null,
      stateHash: metadata.state_hash ?? null,
      ledgerEvents: bundle.ledger?.events?.length || 0,
      pendingOutbox: outbox.count,
      candidates: candidates.items.length,
      activeConflicts: activeConflicts.length,
    },
  };
}

function checkSession({ vaultBase, sessionRel, control, registry }) {
  const failures = [];
  const warnings = [];
  const metrics = {};
  const sessionPath = join(vaultBase, sessionRel);

  if (!existsSync(sessionPath)) {
    failures.push(`Sessão não encontrada: ${sessionRel}`);
    return { failures, warnings, metrics };
  }

  const content = readFileSync(sessionPath, 'utf-8');
  const activeSession = control.status === 'active' && control.session_file === sessionRel;
  const duplicates = findDuplicateTurnMarkers(content);
  metrics.turnMarkers = (content.match(/<!-- (?:wk-turn|codex-turn):/g) || []).length;
  metrics.duplicateTurnMarkers = duplicates.length;

  if (duplicates.length) failures.push(`Marcadores de turno duplicados: ${duplicates.join(', ')}`);
  if (hasHeadingAfterClosing(content)) failures.push('Há headings/iterações após ## Encerramento.');
  if (!usageSectionIsPlaced(content, { active: activeSession })) failures.push('A seção de agentes, tokens e custos está fora da posição esperada.');
  if (content.includes('\n## Agentes, tokens e custos') && (content.includes('\n## Uso de tokens e custos') || content.includes('\n## Subagents & Workflows'))) {
    failures.push('A sessão mistura observabilidade consolidada e seções legadas.');
  }
  if (hasDefaultPending(content)) warnings.push('Pendências ainda contém placeholders padrão.');

  const registryPair = Object.entries(registry.sessions || {}).find(([, entry]) => entry?.session_file === sessionRel);
  const registryEntry = registryPair?.[1];
  if (!registryEntry) {
    failures.push(`SESSION_REGISTRY não possui a sessão: ${sessionRel}`);
  } else {
    if (!registryEntry.transcript_path) {
      warnings.push('SESSION_REGISTRY não possui transcript_path para a sessão ativa.');
    } else if (!existsSync(registryEntry.transcript_path)) {
      warnings.push(`Transcript da sessão ativa não encontrado: ${registryEntry.transcript_path}`);
    }
  }

  const sessionLink = wikilinkFromRel(sessionRel);
  for (const noteRel of linkedNotesFromSession(content)) {
    const notePath = join(vaultBase, noteRel.endsWith('.md') ? noteRel : `${noteRel}.md`);
    if (!existsSync(notePath)) {
      failures.push(`Nota derivada linkada não existe: ${noteRel}`);
      continue;
    }
    const noteContent = readFileSync(notePath, 'utf-8');
    if (!noteContent.includes(sessionLink) && !noteContent.includes(sessionRel)) {
      failures.push(`Nota derivada sem backlink para a sessão: ${noteRel}`);
    }
  }

  return { failures, warnings, metrics };
}

export function runVaultHealth({ vaultBase, session = '' }) {
  const control = readControl(vaultBase);
  const registry = readSessionRegistry(vaultBase);
  const sessionRel = session || control.session_file || control.last_session_file || '';
  const failures = [];
  const warnings = [];

  if (!existsSync(controlPath(vaultBase))) {
    failures.push('CURRENT_SESSION.md não encontrado.');
  }
  if (!sessionRel) failures.push('Nenhuma sessão ativa ou última sessão encontrada no controle.');

  const sessionResult = sessionRel
    ? checkSession({ vaultBase, sessionRel, control, registry })
    : { failures: [], warnings: [], metrics: {} };
  failures.push(...sessionResult.failures);
  warnings.push(...sessionResult.warnings);

  const staleDone = Object.values(registry.sessions || {})
    .filter((item) => item.status === 'active' && item.ended_at)
    .length;
  if (staleDone) warnings.push(`${staleDone} entradas active com ended_at no SESSION_REGISTRY.`);
  const activeEntries = Object.values(registry.sessions || {}).filter((item) => item?.status === 'active');
  for (const entry of activeEntries) {
    if (!entry.session_file) failures.push('SESSION_REGISTRY possui sessão ativa sem session_file.');
    if (!entry.transcript_path) warnings.push(`Sessão ativa sem transcript_path: ${entry.session_file || '(sem arquivo)'}`);
  }

  const locF = getLocale(vaultBase).folders;
  const derivedFolders = [locF.decisions, locF.bugs, locF.learnings];
  const derivedCount = derivedFolders.reduce((total, folder) => {
    const dir = join(vaultBase, folder);
    return total + (existsSync(dir) ? listMarkdownFiles(dir).length : 0);
  }, 0);

  const memoryMarkers = [
    join(vaultBase, '.brain', 'SHARED_MEMORY.md'),
    join(vaultBase, '.brain', 'MEMORY_EVENTS.jsonl'),
    join(vaultBase, '.brain', 'MEMORY_CANDIDATES.jsonl'),
    join(vaultBase, '.brain', 'memory-outbox'),
  ];
  let memory = { status: 'legacy', metrics: {} };
  if (memoryMarkers.some((path) => existsSync(path))) {
    memory = checkMemoryBundle(vaultBase);
    failures.push(...memory.failures.map((item) => `Memória: ${item}`));
    warnings.push(...memory.warnings.map((item) => `Memória: ${item}`));
  } else {
    warnings.push(`Bundle de memória v2 ausente (vault legado); inspecione com: ${MEMORY_STATUS_COMMAND}.`);
  }

  return {
    ok: failures.length === 0,
    session: sessionRel,
    failures,
    warnings,
    metrics: {
      ...sessionResult.metrics,
      registrySessions: Object.keys(registry.sessions || {}).length,
      derivedNotes: derivedCount,
      memory: memory.metrics,
    },
    memoryStatus: memory.status,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const vaultBase = getVaultBase({ obsidian_vault_path: args.vault });
  const result = runVaultHealth({ vaultBase, session: args.session || '' });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[wendkeep] Vault health falhou: ${error.message}\n`);
    process.exitCode = 1;
  }
}
