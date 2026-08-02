#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import {
  controlPath,
  getVaultBase,
  listMarkdownFiles,
  quoteCommandArgument,
  readControl,
  readSessionRegistry,
  WENDKEEP_COMMAND,
  wikilinkFromRel,
} from './obsidian-common.mjs';
import { getLocale } from './locale.mjs';
import { parseSharedMemory, validateMemoryEvent } from './memory-schema.mjs';
import { detectMemoryMode, LEGACY_MEMORY_WARNING } from './memory-mode.mjs';
import { deriveMemoryProjection } from './memory-store.mjs';
import { assertVaultPathSafe, assertVaultPathsSafe } from './vault-path-safety.mjs';
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

const memoryStatusCommand = (vaultBase) => (
  `${WENDKEEP_COMMAND} memory status --gate --vault ${quoteCommandArgument(vaultBase)}`
);
const memoryRepairCommand = (vaultBase) => (
  `${WENDKEEP_COMMAND} memory repair --vault ${quoteCommandArgument(vaultBase)}`
);
const memoryMigrateCommand = (vaultBase) => (
  `${WENDKEEP_COMMAND} memory migrate --apply --vault ${quoteCommandArgument(vaultBase)}`
);
const memoryCandidatesCommand = (vaultBase) => (
  `${WENDKEEP_COMMAND} memory candidates --active --vault ${quoteCommandArgument(vaultBase)}`
);
const memoryPromoteCommand = (vaultBase) => (
  `${WENDKEEP_COMMAND} memory promote <candidate-id> --event <event-id> --vault ${quoteCommandArgument(vaultBase)}`
);
const memoryRejectCommand = (vaultBase) => (
  `${WENDKEEP_COMMAND} memory reject <candidate-id> --vault ${quoteCommandArgument(vaultBase)}`
);

function readJsonLines(vaultBase, path, label) {
  let checked;
  try {
    checked = assertVaultPathSafe(vaultBase, path, { expectedType: 'file', label });
  } catch (error) {
    return { items: [], errors: [`${label} inseguro: ${error?.message || error}`] };
  }
  if (!checked.exists) return { items: [], errors: [] };
  let raw;
  try {
    checked = assertVaultPathSafe(vaultBase, checked.target, {
      allowMissing: false, expectedType: 'file', label,
    });
    raw = readFileSync(checked.target, 'utf8').replace(/\r\n/g, '\n');
  }
  catch (error) { return { items: [], errors: [`${label} ilegível: ${error?.message || error}`] }; }
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
  let checked;
  try {
    checked = assertVaultPathSafe(vaultBase, dir, {
      expectedType: 'directory', label: 'outbox de memória',
    });
  } catch (error) {
    return {
      count: 0,
      errors: [`outbox insegura: ${error?.message || error}`],
      eventIds: new Set(),
      eventsById: new Map(),
    };
  }
  if (!checked.exists) return {
    count: 0, errors: [], eventIds: new Set(), eventsById: new Map(),
  };
  try {
    checked = assertVaultPathSafe(vaultBase, checked.target, {
      allowMissing: false, expectedType: 'directory', label: 'outbox de memória',
    });
  } catch (error) {
    return {
      count: 0,
      errors: [`outbox insegura: ${error?.message || error}`],
      eventIds: new Set(),
      eventsById: new Map(),
    };
  }
  const files = readdirSync(checked.target).filter((name) => name.endsWith('.json')).sort();
  const errors = [];
  const eventIds = new Set();
  const eventsById = new Map();
  for (const name of files) {
    const path = join(checked.target, name);
    try {
      const file = assertVaultPathSafe(vaultBase, path, {
        allowMissing: false, expectedType: 'file', label: `evento ${name} da outbox`,
      });
      const event = JSON.parse(readFileSync(file.target, 'utf8'));
      const validation = validateMemoryEvent(event, projectId ? { projectId } : {});
      if (!validation.ok) errors.push(`${name}: ${validation.errors.join(' ')}`);
      else {
        eventIds.add(event.event_id);
        eventsById.set(event.event_id, event);
      }
    } catch (error) {
      errors.push(`${name}: JSON inválido: ${error.message}`);
    }
  }
  return {
    count: files.length, errors, eventIds, eventsById,
  };
}

function memoryMetrics() {
  return {
    schemaVersion: null,
    revision: null,
    eventCursor: null,
    stateHash: null,
    ledgerEvents: 0,
    pendingOutbox: 0,
    candidates: 0,
    activeConflicts: 0,
  };
}

function blockedMemoryBoundary(error) {
  return {
    ok: false,
    status: 'blocked',
    failures: [`Boundary física da memória insegura: ${error?.message || error}`],
    warnings: [],
    metrics: memoryMetrics(),
  };
}

function preflightMemoryBundle(vaultBase) {
  const brain = join(vaultBase, '.brain');
  assertVaultPathSafe(vaultBase, brain, {
    expectedType: 'directory', label: 'raiz .brain da memória',
  });
  assertVaultPathsSafe(vaultBase, [
    'PROJECT.json', 'CORE.md', 'MEMORY_EVENTS.jsonl', 'SHARED_MEMORY.md',
    'MEMORY_CANDIDATES.jsonl',
  ].map((name) => ({
    path: join(brain, name), expectedType: 'file', label: `${name} ilegível ou inseguro`,
  })));
  const outbox = assertVaultPathSafe(vaultBase, join(brain, 'memory-outbox'), {
    expectedType: 'directory', label: 'outbox de memória',
  });
  if (!outbox.exists) return;
  const entries = readdirSync(outbox.target);
  for (const name of entries) {
    assertVaultPathSafe(vaultBase, join(outbox.target, name), {
      allowMissing: false, label: `entrada ${name} da outbox de memória`,
    });
  }
}

function checkpointMatchesLedgerPrefix(checkpoint, eventIds, ledgerEvents, vaultBase) {
  if (!checkpoint || typeof checkpoint !== 'object') return false;
  if (!Number.isInteger(checkpoint.revision) || checkpoint.revision < 0) return false;
  if (typeof checkpoint.event_cursor !== 'string' || !checkpoint.event_cursor) return false;
  if (typeof checkpoint.state_hash !== 'string' || !checkpoint.state_hash) return false;

  const cursorIndex = ledgerEvents.findIndex((event) => event?.event_id === checkpoint.event_cursor);
  if (cursorIndex < 0) return false;
  const prefix = ledgerEvents.slice(0, cursorIndex + 1);
  const prefixIds = new Set(prefix.map((event) => event.event_id));
  if (eventIds.some((eventId) => !prefixIds.has(eventId))) return false;

  try {
    const replay = deriveMemoryProjection(vaultBase, prefix);
    const causalMatches = checkpoint.causal_event_cursor === undefined
      || checkpoint.causal_event_cursor === replay.eventCursor;
    return checkpoint.revision === replay.checkpoint.revision
      && checkpoint.event_cursor === replay.checkpoint.event_cursor
      && checkpoint.state_hash === replay.checkpoint.state_hash
      && causalMatches;
  } catch {
    return false;
  }
}

function checkMemoryAttempts(registry, {
  vaultBase, ledgerEvents = [], outboxEventIds = new Set(), outboxEventsById = new Map(),
} = {}) {
  const failures = [];
  const warnings = [];
  const ledgerEventIds = new Set(ledgerEvents.map((event) => event?.event_id).filter(Boolean));
  const ledgerById = new Map(ledgerEvents
    .filter((event) => event?.event_id)
    .map((event) => [event.event_id, event]));
  const attempts = Object.entries(registry?.sessions || {})
    .map(([sessionId, entry]) => [sessionId, entry?.last_memory_attempt])
    .filter(([, attempt]) => attempt && typeof attempt === 'object' && attempt.memory_mode === 'v2');

  for (const [sessionId, attempt] of attempts) {
    const state = String(attempt.state || '');
    const disposition = String(attempt.disposition || '');
    const eventIds = Array.isArray(attempt.event_ids)
      ? [...new Set(attempt.event_ids.filter((eventId) => typeof eventId === 'string' && eventId))]
      : [];

    if (state === 'skipped' && disposition === 'ambiguous') {
      failures.push(`Lifecycle de memória v2 ambíguo: Stop pulou a publicação sem identidade causal suficiente. Inspecione com: ${memoryStatusCommand(vaultBase)}.`);
      continue;
    }

    if (state === 'skipped' && ['stale_turn', 'superseded'].includes(disposition)) {
      if (eventIds.length) {
        failures.push(`Stop stale/superseded emitiu event_ids apesar da rejeição causal. Inspecione com: ${memoryStatusCommand(vaultBase)}.`);
      } else {
        warnings.push('Stop stale/superseded foi descartado sem publicar memória.');
      }
      continue;
    }

    if (disposition !== 'applied') {
      if (state === 'skipped') warnings.push('Attempt de memória v2 foi descartado sem publicação.');
      else failures.push(`Attempt de memória v2 possui disposition não reconhecida para o estado informado. Inspecione com: ${memoryStatusCommand(vaultBase)}.`);
      continue;
    }

    if (!eventIds.length) {
      failures.push(`Attempt v2 aplicado não declarou event_ids; publicação perdida. Inspecione com: ${memoryStatusCommand(vaultBase)}.`);
      continue;
    }

    const identity = {
      canonical_session_id: sessionId,
      activation_id: attempt.activation_id,
      activation_epoch: attempt.activation_epoch,
      source_turn_id: attempt.turn_id,
      turn_sequence: attempt.turn_sequence,
    };
    const invalidAttemptFields = [];
    if (attempt.canonical_session_id !== sessionId) invalidAttemptFields.push('canonical_session_id');
    if (typeof attempt.activation_id !== 'string' || !attempt.activation_id) invalidAttemptFields.push('activation_id');
    if (!Number.isInteger(attempt.activation_epoch) || attempt.activation_epoch < 0) invalidAttemptFields.push('activation_epoch');
    if (typeof attempt.turn_id !== 'string' || !attempt.turn_id) invalidAttemptFields.push('turn_id');
    if (!Number.isInteger(attempt.turn_sequence) || attempt.turn_sequence < 0) invalidAttemptFields.push('turn_sequence');
    if (invalidAttemptFields.length) {
      failures.push(`Attempt v2 da sessão ${sessionId} possui identidade causal inválida (${invalidAttemptFields.join(', ')}). Inspecione com: ${memoryStatusCommand(vaultBase)}.`);
      continue;
    }
    const causalMismatches = [];
    for (const eventId of eventIds) {
      const event = ledgerById.get(eventId) || outboxEventsById.get(eventId);
      if (!event) continue;
      const fields = Object.entries(identity)
        .filter(([field, expected]) => event[field] !== expected)
        .map(([field]) => field);
      if (fields.length) causalMismatches.push(`${eventId}: ${fields.join(', ')}`);
    }
    if (causalMismatches.length) {
      failures.push(`Attempt v2 da sessão ${sessionId} referencia evento(s) com identidade causal divergente (${causalMismatches.join('; ')}). Inspecione com: ${memoryStatusCommand(vaultBase)}.`);
      continue;
    }

    if (state === 'enqueued' || state === 'degraded') {
      const missing = eventIds.filter((eventId) => !ledgerEventIds.has(eventId) && !outboxEventIds.has(eventId));
      if (missing.length) {
        failures.push(`Attempt v2 perdeu ${missing.length} evento(s): ausentes do ledger e da outbox. Inspecione com: ${memoryStatusCommand(vaultBase)}.`);
      } else if (
        state === 'enqueued'
        && eventIds.every((eventId) => ledgerEventIds.has(eventId))
        && eventIds.every((eventId) => !outboxEventIds.has(eventId))
      ) {
        warnings.push(`Attempt de memória v2 possui acknowledgement projetado pendente. Recupere com: wendkeep memory recover-attempt ${sessionId}.`);
      } else {
        warnings.push(`Attempt de memória v2 ${state} permanece recuperável: ${eventIds.length} evento(s) durável(is) no ledger e/ou outbox.`);
      }
      continue;
    }

    if (state === 'projected') {
      const outsideLedger = eventIds.filter((eventId) => !ledgerEventIds.has(eventId));
      if (outsideLedger.length) {
        failures.push(`Attempt projetado perdeu ${outsideLedger.length} evento(s) no ledger. Inspecione com: ${memoryStatusCommand(vaultBase)}.`);
      } else if (!checkpointMatchesLedgerPrefix(attempt.checkpoint, eventIds, ledgerEvents, vaultBase)) {
        failures.push(`Checkpoint do attempt projetado diverge do prefixo rederivado do ledger. Inspecione com: ${memoryStatusCommand(vaultBase)}.`);
      }
      continue;
    }

    failures.push(`Attempt de memória v2 possui state inválido. Inspecione com: ${memoryStatusCommand(vaultBase)}.`);
  }

  return { failures, warnings };
}

/**
 * Read-only consistency check for the local memory-v2 bundle. It intentionally
 * does not acquire MEMORY.lock or invoke the projector/repair paths.
 */
export function checkMemoryBundle(vaultBase, { registry } = {}) {
  if (!existsSync(vaultBase)) {
    return {
      ok: false,
      status: 'blocked',
      failures: [`Vault not found: ${vaultBase}`],
      warnings: [],
      metrics: memoryMetrics(),
    };
  }
  try { preflightMemoryBundle(vaultBase); }
  catch (error) { return blockedMemoryBoundary(error); }
  const brain = join(vaultBase, '.brain');
  let mode;
  try { mode = detectMemoryMode(vaultBase); }
  catch (error) { return blockedMemoryBoundary(error); }
  if (mode.mode === 'legacy') {
    return {
      ok: true,
      status: 'legacy',
      failures: [],
      warnings: [`${LEGACY_MEMORY_WARNING} Comando com Vault resolvido: ${memoryMigrateCommand(vaultBase)}.`],
      metrics: memoryMetrics(),
    };
  }
  const bundle = validateMemoryBundle(vaultBase);
  const failures = [];
  const warnings = [];
  const parsedShared = typeof bundle.shared?.content === 'string'
    ? parseSharedMemory(bundle.shared.content)
    : { metadata: {} };
  const metadata = parsedShared.metadata || {};
  const outbox = inspectOutbox(vaultBase, bundle.project?.projectId);
  const candidates = readJsonLines(
    vaultBase, join(brain, 'MEMORY_CANDIDATES.jsonl'), 'MEMORY_CANDIDATES.jsonl',
  );

  const ledgerCorrupt = (bundle.ledger?.errors || []).length > 0;
  if (ledgerCorrupt) {
    for (const error of bundle.ledger.errors) {
      failures.push(`${error} Execute com segurança: ${memoryRepairCommand(vaultBase)}.`);
    }
  }
  for (const error of bundle.errors || []) {
    if (error.startsWith('ledger:')) continue;
    failures.push(`${error} Inspecione com: ${memoryStatusCommand(vaultBase)}.`);
  }

  if (outbox.errors.length) {
    failures.push(`Outbox corrompida (${outbox.errors.join('; ')}). Inspecione com: ${memoryStatusCommand(vaultBase)}.`);
  }
  if (candidates.errors.length) {
    failures.push(`${candidates.errors.join('; ')} Execute com segurança: ${memoryRepairCommand(vaultBase)}.`);
  }

  let replay = null;
  if (bundle.ledger?.ok) {
    try { replay = deriveMemoryProjection(vaultBase, bundle.ledger.events); }
    catch (error) {
      failures.push(`Ledger não pode ser reduzido: ${error.message}. Execute com segurança: ${memoryRepairCommand(vaultBase)}.`);
    }
  }
  if (replay && bundle.shared?.ok) {
    const divergences = [];
    if (metadata.revision !== replay.revision) divergences.push(`revision ${metadata.revision} != ${replay.revision}`);
    if (metadata.event_cursor !== replay.ledgerCursor) divergences.push(`event_cursor ${metadata.event_cursor} != ${replay.ledgerCursor}`);
    if (metadata.state_hash !== replay.stateHash) divergences.push(`state_hash ${metadata.state_hash} != ${replay.stateHash}`);
    if (divergences.length) {
      failures.push(`Projeção SHARED stale/lag (${divergences.join('; ')}). Inspecione com: ${memoryStatusCommand(vaultBase)}.`);
    }
  }

  let effectiveRegistry = registry;
  if (!effectiveRegistry) {
    try { effectiveRegistry = readSessionRegistry(vaultBase); }
    catch (error) { failures.push(`SESSION_REGISTRY.json inseguro ou ilegível: ${error?.message || error}.`); }
  }
  const lifecycle = checkMemoryAttempts(effectiveRegistry || { version: 2, sessions: {} }, {
    vaultBase,
    ledgerEvents: bundle.ledger?.events || [],
    outboxEventIds: outbox.eventIds,
    outboxEventsById: outbox.eventsById,
  });
  failures.push(...lifecycle.failures);
  warnings.push(...lifecycle.warnings);

  const unresolved = candidates.items.filter((item) => !['resolved', 'rejected', 'superseded'].includes(item?.status));
  const activeConflicts = unresolved.filter((item) => item?.reason === 'conflict');
  const ordinaryCandidates = unresolved.filter((item) => item?.reason !== 'conflict');
  if (activeConflicts.length) {
    const keys = [...new Set(activeConflicts.map((item) => item.memory_key || item.candidate_id))]
      .sort((left, right) => String(left).localeCompare(String(right)));
    const label = activeConflicts.length === 1
      ? '1 conflito ativo'
      : `${activeConflicts.length} conflitos ativos`;
    failures.push(`${label} em chave operacional (${keys.join(', ')}). Conflito semântico exige curadoria humana; memory repair não escolhe vencedor. Liste IDs seguros com: ${memoryCandidatesCommand(vaultBase)}. Depois da revisão, use ${memoryPromoteCommand(vaultBase)} ou ${memoryRejectCommand(vaultBase)}.`);
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
    memory = checkMemoryBundle(vaultBase, { registry });
    failures.push(...memory.failures.map((item) => `Memória: ${item}`));
    warnings.push(...memory.warnings.map((item) => `Memória: ${item}`));
  } else {
    warnings.push(`Bundle de memória v2 ausente (vault legado); inspecione com: ${memoryStatusCommand(vaultBase)}.`);
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
