#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { LOCK_BUSY, mutateSessionNote, withPathLock } from './session-note-io.mjs';
import { basename, dirname, join, relative } from 'path';
import { getLocale } from './locale.mjs';
import { resolveProjectVault } from '../src/project-vault.mjs';
import {
  assertVaultPathSafe, mkdirVaultPath, writeVaultFileAtomic,
} from './vault-path-safety.mjs';
import {
  salvageTruncatedJson,
  parseHookInput,
  stringifyHookOutput,
  detectProvider as detectProviderFromEnvironment,
  providerMeta as providerMetaFromProvider,
  extractHookPrompt,
} from '../packages/integrations/src/hook-envelope.mjs';
import {
  isBootstrapPrompt,
  redactSecrets,
} from '../packages/integrations/src/prompt-content.mjs';
import { transcriptsMatch } from '../packages/integrations/src/session-identity.mjs';
export {
  salvageTruncatedJson,
  extractHookPrompt,
  isBootstrapPrompt,
  redactSecrets,
  transcriptsMatch,
};

// Deprecated export kept for consumers that imported it before 0.39.0. Automatic
// hooks never use this fallback: an unbound project fails closed.
export const DEFAULT_VAULT_BASE = join(
  process.env.USERPROFILE || process.env.HOME || process.cwd(),
  'wendkeep-vault',
);
export const MONTH_FOLDERS = [
  '01-JAN', '02-FEV', '03-MAR', '04-ABR', '05-MAI', '06-JUN',
  '07-JUL', '08-AGO', '09-SET', '10-OUT', '11-NOV', '12-DEZ',
];

export const VAULT_COMPLEMENT_RULES = [
  'Regra prática do Vault: os hooks garantem o histórico automático por turno; o agente só complementa manualmente quando houver valor durável de memória, decisão, bug, aprendizado ou auditoria/validação.',
  'Evite duplicar o que o hook já registra. Use escrita manual para síntese curada baseada em evidências, não para histórico bruto nem raciocínio interno.',
  'Quando complementar, registre a síntese na sessão ativa dentro de `## Iterações` antes de `## Decisões geradas nesta sessão`, ou crie nota derivada em `04-Decisões/`, `05-Bugs/` ou `06-Aprendizados/` com backlink para a sessão.',
  'Notas derivadas vivem na pasta do MÊS (`<pasta>/<ano>/<MM-MMM>/`), nunca em subpasta `DIA N`, com nome numerado `ADR-`/`BUG-`/`APR-NNNN-<slug>`. Para criar bug ou aprendizado manual, use `wendkeep note new --type bug|learning "título"` — o comando cria a nota já numerada no lugar certo e imprime o path; nunca escreva o arquivo à mão.',
  'Atualize `SHARED_MEMORY.md` somente quando a síntese mudar estado ativo que outro agente precise saber.',
];

export function readHookInput() {
  return parseHookInput(readFileSync(0, 'utf-8'));
}

export function writeHookOutput(payload = {}) {
  process.stdout.write(stringifyHookOutput(payload));
}

// Resolve from explicit hook payload or the nearest project-local binding. A legacy
// `.claude/settings.json` registration is accepted as a migration bridge so Codex can
// discover projects initialized by older WendKeep versions. Global process env and the
// historical home fallback are intentionally excluded to prevent cross-project writes.
export function resolveVault(input = {}) {
  return resolveProjectVault({ input });
}

export function getVaultBase(input = {}) {
  return resolveVault(input).base;
}

// Diagnostic commands must use the project-local package even when `wendkeep` is not installed
// globally. Quotes preserve resolved Windows paths with spaces in copy/pasteable output.
export const WENDKEEP_COMMAND = 'npx --no-install wendkeep';

export function quoteCommandArgument(value) {
  return `"${String(value ?? '').replaceAll('"', '\\"')}"`;
}

// Diagnostic logger. No-op unless WENDKEEP_DEBUG is set, so it never pollutes the
// stdout hook contract during normal runs but makes fail-open paths debuggable.
export function debugLog(...args) {
  if (!process.env.WENDKEEP_DEBUG) return;
  const text = args
    .map((a) => (a && a.stack ? a.stack : String(a)))
    .join(' ');
  process.stderr.write(`[wendkeep] ${text}\n`);
}

// Migration warning for projects that are still discovered through Claude's local
// settings. Missing bindings throw before this point and are handled by each hook's
// fail-closed top-level catch.
export function warnIfDefaultVault(input = {}) {
  const { base, source } = resolveVault(input);
  if (source === 'legacy-project-settings') {
    process.stderr.write(
      `[wendkeep] Configuração legada do vault detectada em .claude/settings.json ("${base}"). `
        + 'Rode `wendkeep init --yes` para criar .wendkeep.json; Codex e Claude continuarão no mesmo vault.\n',
    );
  }
  return source;
}

// Detecta o agente real que está executando o hook. Claude Code expõe
// CLAUDECODE / CLAUDE_CODE_SESSION_ID / CLAUDE_PROJECT_DIR; Codex não.
export function detectProvider() {
  return detectProviderFromEnvironment(process.env);
}

export function providerMeta(provider = detectProvider()) {
  return providerMetaFromProvider(provider);
}

export function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export function pad2(value) {
  return String(value).padStart(2, '0');
}

export function localDateParts(date = new Date()) {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
  };
}

export function formatDate(date = new Date()) {
  const p = localDateParts(date);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function formatTime(date = new Date()) {
  const p = localDateParts(date);
  return `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
}

export function formatHourMinute(date = new Date()) {
  const p = localDateParts(date);
  return `${pad2(p.hour)}-${pad2(p.minute)}`;
}

export function formatLocalIso(date = new Date()) {
  return `${formatDate(date)}T${formatTime(date)}`;
}

// Locale (0.8.0): month labels + folder names come from the vault locale when a
// vaultBase is given; without it, pt-BR (backward compat — every legacy caller).
export function datedFolderRel(rootFolder, date = new Date(), vaultBase) {
  const p = localDateParts(date);
  return join(rootFolder, String(p.year), getLocale(vaultBase).months[p.month - 1], `DIA ${pad2(p.day)}`);
}

// Mesma estrutura datada a partir de uma string 'YYYY-MM-DD' (sessões: até o DIA).
export function datedFolderRelFromDateStr(rootFolder, dateStr, vaultBase) {
  const [year, month, day] = String(dateStr).split('-');
  return join(rootFolder, year, getLocale(vaultBase).months[Number(month) - 1], `DIA ${pad2(day)}`);
}

// Estrutura até o MÊS (sem DIA) — usada pelas notas derivadas (decisões/bugs/
// aprendizados): tudo do mês fica junto em <pasta>/<ano>/<MM-MMM>/.
export function monthFolderRelFromDateStr(rootFolder, dateStr, vaultBase) {
  const [year, month] = String(dateStr).split('-');
  return join(rootFolder, year, getLocale(vaultBase).months[Number(month) - 1]);
}

export function sessionFolderRel(date = new Date(), vaultBase) {
  return datedFolderRel(getLocale(vaultBase).folders.sessions, date, vaultBase);
}

export function controlPath(vaultBase) {
  return join(vaultBase, '.brain', 'CURRENT_SESSION.md');
}

export function registryPath(vaultBase) {
  return join(vaultBase, '.brain', 'SESSION_REGISTRY.json');
}

export function toVaultRelative(vaultBase, path) {
  return relative(vaultBase, path).replaceAll('\\', '/');
}

export function stripYamlQuotes(value = '') {
  return value.trim().replace(/^["']|["']$/g, '');
}

export function yamlQuote(value = '') {
  return JSON.stringify(String(value || ''));
}

export function readControl(vaultBase) {
  const path = controlPath(vaultBase);
  const checked = assertVaultPathSafe(vaultBase, path, {
    expectedType: 'file', label: 'CURRENT_SESSION.md',
  });
  if (!checked.exists) return {};

  const content = readFileSync(checked.target, 'utf-8');
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const data = {};
  for (const line of match[1].split('\n')) {
    const item = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (item) data[item[1]] = stripYamlQuotes(item[2]);
  }
  return data;
}

export function writeControl(vaultBase, data) {
  const path = controlPath(vaultBase);
  mkdirVaultPath(vaultBase, dirname(path), { label: 'diretório do CURRENT_SESSION' });
  assertVaultPathSafe(vaultBase, path, {
    expectedType: 'file', label: 'CURRENT_SESSION.md',
  });

  const status = data.status || 'inactive';
  const sessionFile = data.session_file || '';
  const lastSessionFile = data.last_session_file || sessionFile || '';
  const startedAt = data.started_at || '';
  const endedAt = data.ended_at || '';
  const sessionId = data.session_id || '';
  const lastLoggedTurnId = data.last_logged_turn_id || '';

  const registry = readSessionRegistry(vaultBase);
  const active = Object.entries(registry.sessions || {})
    .filter(([, item]) => item?.status === 'active' && item.session_file)
    .sort((a, b) => String(b[1].last_seen || b[1].updated_at || '').localeCompare(String(a[1].last_seen || a[1].updated_at || '')));
  const activeRows = active.length
    ? active.map(([id, item]) => `| ${id} | ${item.provider || 'unknown'} | ${item.session_file} | ${item.change_slug || '-'} | ${item.last_seen || item.updated_at || '-'} |`).join('\n')
    : '| - | - | nenhuma | - | - |';

  const content = `---
status: "${status}"
session_file: "${sessionFile}"
last_session_file: "${lastSessionFile}"
started_at: "${startedAt}"
ended_at: "${endedAt}"
session_id: "${sessionId}"
last_logged_turn_id: "${lastLoggedTurnId}"
---

# CURRENT_SESSION

> Visão gerada pelo WendKeep. A autoridade de roteamento é .brain/SESSION_REGISTRY.json; hooks não usam este foco como fallback de escrita.

- **Status:** ${status}
- **Sessão ativa:** ${sessionFile || 'nenhuma'}
- **Última sessão encerrada:** ${lastSessionFile || 'nenhuma'}
- **Início:** ${startedAt || 'n/a'}
- **Fim:** ${endedAt || 'n/a'}

## Sessões ativas (${active.length})

| Conversa | Provider | Sessão | Change vinculada | Último sinal |
|---|---|---|---|---|
${activeRows}

Regra crítica: sempre anexar conteúdo à sessão ativa. Nunca sobrescrever o histórico de iterações.
`;

  writeVaultFileAtomic(vaultBase, path, content, 'utf-8', {
    label: 'CURRENT_SESSION.md',
  });
}

export function readSessionRegistry(vaultBase) {
  const path = registryPath(vaultBase);
  const checked = assertVaultPathSafe(vaultBase, path, {
    expectedType: 'file', label: 'SESSION_REGISTRY.json',
  });
  if (!checked.exists) return { version: 2, sessions: {} };

  try {
    const parsed = JSON.parse(readFileSync(checked.target, 'utf-8'));
    const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    return {
      ...root,
      version: Math.max(2, root.version || 1),
      sessions: root.sessions && typeof root.sessions === 'object' && !Array.isArray(root.sessions)
        ? root.sessions : {},
    };
  } catch {
    return { version: 2, sessions: {} };
  }
}

export function writeSessionRegistry(vaultBase, registry) {
  const path = registryPath(vaultBase);
  mkdirVaultPath(vaultBase, dirname(path), { label: 'diretório do SESSION_REGISTRY' });
  // Escrita atômica: grava em tmp e renomeia (rename é atômico no mesmo volume),
  // evitando registry truncado/corrompido quando dois hooks gravam ao mesmo tempo.
  writeVaultFileAtomic(vaultBase, path, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8', {
    label: 'SESSION_REGISTRY.json',
  });
}

export function mutateSessionRegistry(vaultBase, mutator, { timeoutMs = 2000 } = {}) {
  const path = registryPath(vaultBase);
  mkdirVaultPath(vaultBase, dirname(path), { label: 'diretório do SESSION_REGISTRY' });
  const outcome = withPathLock(path, () => {
    const registry = readSessionRegistry(vaultBase);
    const before = JSON.stringify(registry);
    registry.version = 2;
    const result = mutator(registry);
    if (JSON.stringify(registry) !== before) {
      writeSessionRegistry(vaultBase, registry);
    }
    return result;
  }, { timeoutMs, vaultBase });
  if (outcome === LOCK_BUSY) {
    throw new Error('SESSION_REGISTRY lock indisponível: lock ocupado até o timeout.');
  }
  return outcome;
}

function meaningfulPatch(patch = {}) {
  const protectedNonEmpty = new Set(['session_file', 'transcript_path', 'transcript_id', 'provider', 'started_at', 'change_slug', 'activation_id']);
  return Object.fromEntries(Object.entries(patch).filter(([key, value]) => {
    if (['advance_turn_sequence', 'turn_sequence', 'turn_id', 'last_turn_sequence', 'recovery_activation_id', 'recovery_started_at'].includes(key)) return false;
    if (value === undefined || value === null) return false;
    if (value === '' && protectedNonEmpty.has(key)) return false;
    return true;
  }));
}

function nonNegativeSequence(value, fallback = null) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function resolveRegisteredTurnSequence(entry = {}, turnId = '', fallback = 0) {
  const registered = turnId
    ? nonNegativeSequence(entry?.turn_sequences?.[String(turnId)])
    : null;
  return registered === null ? nonNegativeSequence(fallback, 0) : registered;
}

function cloneRegistry(registry = {}) {
  const sessions = Object.fromEntries(Object.entries(registry.sessions || {}).map(([id, entry]) => [
    id,
    {
      ...(entry || {}),
      ...(entry?.activations && typeof entry.activations === 'object'
        ? { activations: Object.fromEntries(Object.entries(entry.activations).map(([activationId, activation]) => [activationId, { ...(activation || {}) }])) }
        : {}),
    },
  ]));
  return { ...registry, version: Math.max(2, registry.version || 1), sessions };
}

// Pure causal helpers. Keeping them independent from filesystem I/O lets Stop perform its
// compare-and-swap under the same registry lock used by the existing upsert path.
export function openActivation(registry, session = {}, explicitActivationId = '') {
  const next = cloneRegistry(registry);
  const sessionId = session.session_id || session.canonical_session_id || session.id || '';
  const activationId = explicitActivationId || session.activation_id || '';
  if (!sessionId || !activationId) throw new TypeError('session_id and activation_id are required');

  const current = next.sessions[sessionId] || {};
  const activations = { ...(current.activations || {}) };
  const openedAfterSequence = nonNegativeSequence(
    session.opened_after_turn_sequence,
    nonNegativeSequence(current.last_turn_sequence, 0),
  );
  const requestedSequence = nonNegativeSequence(
    session.turn_sequence ?? session.last_turn_sequence,
    openedAfterSequence,
  );

  if (current.active_activation_id === activationId && activations[activationId]?.status === 'active') {
    const sequence = Math.max(nonNegativeSequence(current.last_turn_sequence, 0), requestedSequence);
    activations[activationId] = {
      ...activations[activationId],
      last_turn_sequence: sequence,
    };
    next.sessions[sessionId] = {
      ...current,
      activation_id: activationId,
      active_activation_id: activationId,
      last_turn_sequence: sequence,
      activations,
    };
    return next;
  }

  const previousId = current.active_activation_id || '';
  if (previousId && activations[previousId]?.status === 'active') {
    activations[previousId] = {
      ...activations[previousId],
      status: 'superseded',
      superseded_by: activationId,
      superseded_at: session.started_at || session.activation_started_at || '',
    };
  }

  const epoch = Math.max(
    nonNegativeSequence(current.activation_epoch, 0),
    ...Object.values(activations).map((activation) => nonNegativeSequence(activation?.epoch, 0)),
  ) + 1;
  activations[activationId] = {
    activation_id: activationId,
    epoch,
    status: 'active',
    started_at: session.activation_started_at || session.started_at || '',
    opened_after_turn_sequence: openedAfterSequence,
    ...(current.last_turn_id ? { opened_after_turn_id: current.last_turn_id } : {}),
    last_turn_sequence: Math.max(openedAfterSequence, requestedSequence),
    ...(session.transcript_id ? { transcript_id: session.transcript_id } : {}),
    ...(session.transcript_path ? { transcript_path: session.transcript_path } : {}),
    ...(session.provider ? { provider: session.provider } : {}),
  };
  next.sessions[sessionId] = {
    ...current,
    activation_id: activationId,
    active_activation_id: activationId,
    activation_epoch: epoch,
    activation_started_at: session.activation_started_at || session.started_at || '',
    last_turn_sequence: Math.max(openedAfterSequence, requestedSequence),
    activations,
  };
  return next;
}

export function advanceActivationTurn(registry, turn = {}) {
  let next = cloneRegistry(registry);
  const sessionId = turn.session_id || turn.canonical_session_id || '';
  let current = next.sessions[sessionId];
  if (!current) return next;

  const turnId = String(turn.turn_id || '');
  const knownTurn = Boolean(turnId && (
    current.last_turn_id === turnId
    || current.last_prompt_turn_id === turnId
    || Object.prototype.hasOwnProperty.call(current.turn_sequences || {}, turnId)
  ));
  if (knownTurn) return next;

  let activeId = current.active_activation_id || '';
  if ((!activeId || current.activations?.[activeId]?.status !== 'active') && turn.recovery_activation_id) {
    next = openActivation(next, {
      session_id: sessionId,
      activation_id: turn.recovery_activation_id,
      activation_started_at: turn.recovery_started_at || turn.started_at || '',
      turn_sequence: turn.turn_sequence ?? current.last_turn_sequence,
      transcript_id: turn.transcript_id || current.transcript_id,
      transcript_path: turn.transcript_path || current.transcript_path,
      provider: turn.provider || current.provider,
    });
    current = next.sessions[sessionId];
    activeId = current.active_activation_id || '';
  }
  if (turn.activation_id && activeId && turn.activation_id !== activeId) return next;
  const previous = nonNegativeSequence(current.last_turn_sequence, 0);
  const explicit = nonNegativeSequence(turn.turn_sequence ?? turn.last_turn_sequence);
  const sequence = explicit === null ? previous + 1 : Math.max(previous, explicit);
  const activations = { ...(current.activations || {}) };
  if (activeId && activations[activeId]) {
    activations[activeId] = {
      ...activations[activeId],
      last_turn_sequence: Math.max(
        nonNegativeSequence(activations[activeId].last_turn_sequence, 0),
        sequence,
      ),
      ...(turnId ? { last_prompt_turn_id: turnId } : {}),
    };
  }
  next.sessions[sessionId] = {
    ...current,
    last_turn_sequence: sequence,
    ...(turnId ? {
      last_prompt_turn_id: turnId,
      turn_sequences: { ...(current.turn_sequences || {}), [turnId]: sequence },
    } : {}),
    activations,
  };
  return next;
}

export function resolveStopActivation(registry, stop = {}) {
  const sessionId = stop.session_id || stop.canonical_session_id || '';
  const entry = registry?.sessions?.[sessionId];
  if (!entry) return '';
  if (stop.activation_id) return String(stop.activation_id);

  const activeId = entry.active_activation_id || '';
  const active = entry.activations?.[activeId];
  if (!activeId || active?.status !== 'active') return '';
  const transcriptId = String(stop.transcript_id || '');
  const transcriptPath = String(stop.transcript_path || '');
  if (!transcriptId && !transcriptPath) return '';
  if (transcriptId && active.transcript_id && active.transcript_id !== transcriptId) return '';
  const paths = [
    ...(Array.isArray(active.transcript_paths) ? active.transcript_paths : []),
    active.transcript_path,
  ].filter(Boolean);
  if (transcriptPath && paths.length && !paths.some((path) => transcriptsMatch(path, transcriptPath))) return '';
  return (
    (transcriptId && active.transcript_id === transcriptId)
    || (transcriptPath && paths.some((path) => transcriptsMatch(path, transcriptPath)))
  ) ? activeId : '';
}

function stopResult(registry, stopDisposition, canPromoteMemory = false) {
  return {
    ...registry,
    registry,
    stopDisposition,
    canPromoteMemory,
  };
}

export function applyStopActivation(registry, stop = {}) {
  const next = cloneRegistry(registry);
  const sessionId = stop.session_id || stop.canonical_session_id || '';
  const current = next.sessions[sessionId];
  const activeId = current?.active_activation_id || '';
  const stopActivationId = stop.activation_id || '';
  if (!current || !activeId || !stopActivationId) return stopResult(next, 'ambiguous');
  if (current.activations?.[activeId]?.status !== 'active') return stopResult(next, 'ambiguous');

  if (activeId !== stopActivationId) {
    const activations = { ...(current.activations || {}) };
    if (activations[stopActivationId]?.status === 'active') {
      activations[stopActivationId] = {
        ...activations[stopActivationId],
        status: 'superseded',
        superseded_by: activeId,
      };
      next.sessions[sessionId] = { ...current, activations };
    }
    return stopResult(next, 'superseded');
  }

  const stopSequence = nonNegativeSequence(stop.turn_sequence ?? stop.last_turn_sequence);
  const lastSequence = nonNegativeSequence(current.last_turn_sequence, 0);
  if (stopSequence === null) return stopResult(next, 'ambiguous');
  const active = current.activations?.[activeId] || {};
  const openedAfterSequence = nonNegativeSequence(active.opened_after_turn_sequence, 0);
  if (stopSequence <= openedAfterSequence && active.epoch > 1) {
    return stopResult(next, 'superseded');
  }
  const stopTurnId = String(stop.turn_id || '');
  if (stopTurnId && active.last_stop_turn_id === stopTurnId) {
    return stopResult(next, 'duplicate');
  }
  if (stopSequence < lastSequence) return stopResult(next, 'stale_turn');

  const activations = { ...(current.activations || {}) };
  activations[activeId] = {
    ...(activations[activeId] || { activation_id: activeId, epoch: current.activation_epoch }),
    status: 'active',
    last_turn_sequence: stopSequence,
    last_stop_turn_sequence: stopSequence,
    ...(stopTurnId ? { last_stop_turn_id: stopTurnId } : {}),
  };
  next.sessions[sessionId] = {
    ...current,
    status: 'active',
    active_activation_id: activeId,
    last_turn_sequence: Math.max(lastSequence, stopSequence),
    ...(stopTurnId ? { last_turn_id: stopTurnId } : {}),
    activations,
  };
  return stopResult(next, 'applied', true);
}

// Finalization is a second causal transition: Stop first acknowledges the turn and publishes
// observability while the activation is still addressable, then closes that same activation. The
// explicit id check prevents a late Stop from closing a newer activation opened meanwhile.
export function closeSessionActivation(registry, stop = {}) {
  const next = cloneRegistry(registry);
  const sessionId = stop.session_id || stop.canonical_session_id || '';
  const current = next.sessions[sessionId];
  const requestedActivationId = String(stop.activation_id || '');
  const activeId = String(current?.active_activation_id || '');
  const stopTurnId = String(stop.turn_id || '');
  if (!current || !requestedActivationId) return stopResult(next, 'ambiguous');
  if (!activeId && current.status === 'done' && current.last_turn_id === stopTurnId) {
    return stopResult(next, 'duplicate');
  }
  if (!activeId || activeId !== requestedActivationId) return stopResult(next, 'superseded');

  const active = current.activations?.[activeId];
  if (!active || active.status !== 'active') return stopResult(next, 'ambiguous');

  const endedAt = String(stop.ended_at || '');
  const activations = {
    ...(current.activations || {}),
    [activeId]: {
      ...active,
      status: 'done',
      ...(endedAt ? { ended_at: endedAt } : {}),
      ...(stopTurnId ? { last_stop_turn_id: stopTurnId } : {}),
    },
  };
  next.sessions[sessionId] = {
    ...current,
    status: 'done',
    active_activation_id: '',
    ...(endedAt ? { ended_at: endedAt } : {}),
    ...(stopTurnId ? { last_turn_id: stopTurnId } : {}),
    activations,
  };
  return stopResult(next, 'finalized', true);
}

// Remove one registry entry, but ONLY when its transcript matches the given path — this is
// self-healing for entries wendkeep itself mis-wrote (a subagent rollout registered as a
// top-level session by import <=0.46.1), never generic registry cleanup. An entry with the
// same id but a different transcript belongs to someone else's state and is preserved.
export function removeSessionRegistryEntry(vaultBase, sessionId, transcriptPath) {
  if (!sessionId) return false;
  let removed = false;
  mutateSessionRegistry(vaultBase, (registry) => {
    const entry = registry.sessions[sessionId];
    if (!entry) return null;
    const paths = [...(Array.isArray(entry.transcript_paths) ? entry.transcript_paths : []), entry.transcript_path].filter(Boolean);
    if (!paths.some((p) => transcriptsMatch(p, transcriptPath))) return null;
    delete registry.sessions[sessionId];
    removed = true;
    return null;
  });
  return removed;
}

export function upsertSessionRegistry(vaultBase, sessionId, patch) {
  if (!sessionId) return null;
  const clean = meaningfulPatch(patch);
  const next = mutateSessionRegistry(vaultBase, (registry) => {
    const current = registry.sessions[sessionId] || {};
    let causalCurrent = current;
    if (clean.activation_id) {
      causalCurrent = openActivation(
        { version: registry.version, sessions: { [sessionId]: current } },
        {
          session_id: sessionId,
          activation_id: clean.activation_id,
          activation_started_at: clean.activation_started_at,
          started_at: clean.activation_started_at || clean.started_at,
          last_turn_sequence: patch.last_turn_sequence,
          transcript_id: clean.transcript_id || current.transcript_id,
          transcript_path: clean.transcript_path || current.transcript_path,
          provider: clean.provider || current.provider,
        },
      ).sessions[sessionId];
    }
    if (patch?.advance_turn_sequence === true || patch?.turn_sequence !== undefined) {
      causalCurrent = advanceActivationTurn(
        { version: registry.version, sessions: { [sessionId]: causalCurrent } },
        {
          session_id: sessionId,
          activation_id: causalCurrent.active_activation_id || '',
          recovery_activation_id: patch.recovery_activation_id || '',
          recovery_started_at: patch.recovery_started_at || '',
          turn_id: patch.turn_id || '',
          turn_sequence: patch.turn_sequence,
          transcript_id: clean.transcript_id || causalCurrent.transcript_id,
          transcript_path: clean.transcript_path || causalCurrent.transcript_path,
          provider: clean.provider || causalCurrent.provider,
        },
      ).sessions[sessionId];
    }
    const activeId = causalCurrent.active_activation_id || '';
    if (activeId && causalCurrent.activations?.[activeId]) {
      const active = causalCurrent.activations[activeId];
      causalCurrent = {
        ...causalCurrent,
        activations: {
          ...causalCurrent.activations,
          [activeId]: {
            ...active,
            ...(!active.transcript_id && clean.transcript_id ? { transcript_id: clean.transcript_id } : {}),
            ...(!active.transcript_path && clean.transcript_path ? { transcript_path: clean.transcript_path } : {}),
            ...(!active.provider && clean.provider ? { provider: clean.provider } : {}),
          },
        },
      };
    }
    const transcriptPaths = [...new Set([
      ...(Array.isArray(causalCurrent.transcript_paths) ? causalCurrent.transcript_paths : []),
      causalCurrent.transcript_path,
      ...(Array.isArray(clean.transcript_paths) ? clean.transcript_paths : []),
      clean.transcript_path,
    ].filter(Boolean))];
    const value = {
      ...causalCurrent,
      ...clean,
      ...(transcriptPaths.length ? { transcript_paths: transcriptPaths, transcript_path: clean.transcript_path || causalCurrent.transcript_path || transcriptPaths.at(-1) } : {}),
      last_seen: clean.last_seen || clean.updated_at || formatLocalIso(new Date()),
      updated_at: clean.updated_at || formatLocalIso(new Date()),
    };
    registry.sessions[sessionId] = value;
    return value;
  });
  const focus = readControl(vaultBase);
  writeControl(vaultBase, focus);
  return next;
}

// Sessões sem evento de fim (janela fechada, crash, agente sem SessionEnd) ficam
// `active` para sempre. Após este limite ocioso, considera-se a sessão encerrada.
export const SESSION_IDLE_CLOSE_MS = 12 * 60 * 60 * 1000;

// Pura: marca como `done` toda sessão `active` cujo último sinal de vida
// (`updated_at`, senão `started_at`) é mais antigo que `maxIdleMs`. `ended_at`
// recebe esse último sinal (melhor estimativa de quando parou). Não toca na
// sessão de `excludeTranscriptPath` — ela pode estar sendo reaproveitada agora.
// Muta o registry recebido e devolve quantas fechou.
export function sweepStaleSessions(registry, nowMs, maxIdleMs, excludeTranscriptPath = '') {
  const closed = [];
  for (const item of Object.values(registry?.sessions || {})) {
    if (!item || item.status !== 'active') continue;
    if (excludeTranscriptPath && transcriptsMatch(item.transcript_path, excludeTranscriptPath)) continue;
    const lastSeen = item.updated_at || item.started_at || '';
    const lastMs = Date.parse(lastSeen);
    if (!Number.isFinite(lastMs) || nowMs - lastMs <= maxIdleMs) continue;
    item.status = 'done';
    item.ended_at = lastSeen;
    closed.push({ session_file: item.session_file, ended_at: lastSeen });
  }
  return closed;
}

// Registry retention. The registry is read/serialized in full on every hook and scanned O(N)
// for routing — it only needs active + recent sessions (historical audit lives in the notes).
// Left unbounded it grew to 330 entries / ~170 KB in production.
export const REGISTRY_KEEP_DONE = 200;
export const REGISTRY_DONE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

// Pure: drop 'done' entries older than maxAgeMs, then cap the remaining 'done' at keepDone
// (newest by ended_at/updated_at/started_at kept). Never touches active entries. Mutates the
// registry and returns how many were pruned.
export function pruneRegistry(registry, nowMs, { keepDone = REGISTRY_KEEP_DONE, maxAgeMs = REGISTRY_DONE_MAX_AGE_MS } = {}) {
  const sessions = registry?.sessions || {};
  const stamp = (v) => Date.parse((v && (v.ended_at || v.updated_at || v.started_at)) || '') || 0;
  let pruned = 0;
  for (const [id, v] of Object.entries(sessions)) {
    if (!v || v.status !== 'done') continue;
    const t = stamp(v);
    if (t && nowMs - t > maxAgeMs) { delete sessions[id]; pruned += 1; }
  }
  const done = Object.entries(sessions)
    .filter(([, v]) => v && v.status === 'done')
    .sort((a, b) => stamp(b[1]) - stamp(a[1]));
  for (const [id] of done.slice(keepDone)) { delete sessions[id]; pruned += 1; }
  return pruned;
}

// Wrapper de IO: varre as ociosas, poda o registry, grava e fecha a NOTA `.md` de cada
// sessão encerrada (mantém vault e registry alinhados). Devolve quantas fechou.
export function sweepStaleSessionsFile(vaultBase, now = new Date(), maxIdleMs = SESSION_IDLE_CLOSE_MS, excludeTranscriptPath = '') {
  const closed = mutateSessionRegistry(vaultBase, (registry) => {
    const result = sweepStaleSessions(registry, now.getTime(), maxIdleMs, excludeTranscriptPath);
    pruneRegistry(registry, now.getTime());
    return result;
  });
  for (const { session_file, ended_at } of closed) {
    try { closeSessionNoteFile(vaultBase, session_file, ended_at); } catch { /* nunca derruba o sweep */ }
  }
  return closed.length;
}

// IO: alinha a nota `.md` da sessão ao `done` (idempotente; no-op se ausente ou
// já fechada com o mesmo `endedAt`). Devolve true se gravou.
export function closeSessionNoteFile(vaultBase, sessionFileRel, endedAt) {
  if (!sessionFileRel) return false;
  const checked = assertVaultPathSafe(vaultBase, join(vaultBase, sessionFileRel), {
    expectedType: 'file', label: 'nota de sessão encerrada',
  });
  if (!checked.exists) return false;
  return mutateSessionNote(checked.target, (content) => closeSessionNote(content, endedAt), {
    vaultBase,
  }).written;
}

// Marca de sessão ainda aberta no corpo da nota (template do hook de início).
export const SESSION_OPEN_PLACEHOLDER = 'Sessão ainda em andamento.';

// Pura e NÃO-DESTRUTIVA: alinha a NOTA `.md` ao `done` do registry mexendo só no
// frontmatter (`status`/`ended_at`) e trocando o placeholder de sessão aberta
// pelos campos de fechamento. Preserva todo o resto — inclusive seções anexadas
// depois de `## Encerramento`. No-op idempotente em nota já fechada.
export function closeSessionNote(content, endedAt) {
  const src = String(content);
  const isOpen = /^status:\s*"?active/m.test(src) || src.includes(SESSION_OPEN_PLACEHOLDER);
  if (!isOpen) return src;
  let next = src.replace(/^ended_at:.*$/m, `ended_at: ${endedAt}`);
  next = next.replace(/^status:.*$/m, 'status: done');
  next = next.replace(SESSION_OPEN_PLACEHOLDER, [
    `- **Fim:** ${endedAt}`,
    '- **Status:** done',
    '- **Resumo final:** Sessão encerrada na reconciliação de histórico (status alinhado ao SESSION_REGISTRY).',
  ].join('\n'));
  return next;
}

export function slugify(text, fallback = 'nota', maxLen = 60) {
  let slug = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > maxLen) {
    // Truncate on a word boundary (last '-' before maxLen) when a reasonable one exists,
    // instead of cutting mid-word \u2014 keeps generated note names readable.
    const cut = slug.slice(0, maxLen);
    const lastDash = cut.lastIndexOf('-');
    slug = (lastDash > maxLen * 0.5 ? cut.slice(0, lastDash) : cut).replace(/-+$/g, '');
  }
  return slug || fallback;
}

// Chave de conteúdo p/ dedup de notas derivadas: normaliza e corta em 60 chars.
// Mesma normalização do slugify, mas preserva espaços (legível) e sem hífens.
export function derivedContentKey(text = '') {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
}

// "Bate" = chaves iguais OU uma é prefixo da outra (cobre reformulação que
// estende o texto). Chave vazia nunca bate (evita falso-positivo).
export function keysBate(a = '', b = '') {
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

export function summarizePromptForTitle(text = '', fallback = 'session') {
  const cleaned = redactSecrets(String(text || ''))
    .replace(/\[@[^\]]+\]\([^)]+\)/g, ' ')
    .replace(/<image>[\s\S]*?<\/image>/gi, ' ')
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/\r/g, '\n');

  const source = cleaned
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !isBootstrapPrompt(line))
    .find((line) => !/^[-*_`#\s]+$/.test(line));

  if (!source) return fallback;

  const withoutCommitPrefix = source.replace(/^(feat|fix|docs|style|refactor|test|chore|perf|ci|build)(\([^)]+\))?:\s*/i, '');
  const words = withoutCommitPrefix
    .replace(/[`*_>#()[\]{}]/g, ' ')
    .replace(/[^\p{L}\p{N}@+./:-]+/gu, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^[.:;,-]+|[.:;,-]+$/g, ''))
    .filter(Boolean)
    .slice(0, 10);

  const summary = words.join(' ');
  if (!summary) return fallback;
  return `${summary.charAt(0).toLocaleUpperCase('pt-BR')}${summary.slice(1)}`;
}

export function sessionSummaryFromInput(input = {}, fallback = 'session') {
  return summarizePromptForTitle(extractHookPrompt(input), fallback);
}

// Evita retitular a sessão com resumo fraco (fallback ou palavra única),
// para que o título reflita o primeiro prompt real da conversa.
export function isUsableSummary(summary = '', fallback = 'session') {
  if (!summary || summary === fallback) return false;
  return String(summary).trim().split(/\s+/).filter(Boolean).length >= 2;
}

export function sessionFileName(date = new Date(), summary = 'session') {
  return `${formatHourMinute(date)}-${slugify(summary, 'session')}.md`;
}

export function isPlaceholderSessionFile(relPath = '') {
  return /^\d{2}-\d{2}-(?:codex|session)(?:-\d+)?\.md$/i.test(basename(relPath));
}

export function shouldReuseActiveSession(control = {}, now = new Date()) {
  if (control.status !== 'active' || !control.session_file || control.ended_at) return false;
  const startedMs = Date.parse(control.started_at || '');
  if (!Number.isFinite(startedMs)) return true;
  const windowMinutes = Number(process.env.OBSIDIAN_REUSE_ACTIVE_WINDOW_MINUTES || process.env.CODEX_OBSIDIAN_REUSE_ACTIVE_WINDOW_MINUTES || 10);
  return now.getTime() - startedMs <= windowMinutes * 60 * 1000;
}

// O `transcript_path` é estável dentro de uma conversa mesmo quando o
// SessionStart re-dispara (compactação/resume) com `session_id` novo. Achar a
// sessão ativa do mesmo transcript evita criar placeholders `HH-MM-codex`.
export function findActiveSessionByTranscript(vaultBase, transcriptPath) {
  if (!transcriptPath) return null;
  const registry = readSessionRegistry(vaultBase);
  let best = null;
  for (const [sessionId, item] of Object.entries(registry.sessions || {})) {
    if (!item || item.status !== 'active' || !item.session_file) continue;
    const paths = [...(Array.isArray(item.transcript_paths) ? item.transcript_paths : []), item.transcript_path].filter(Boolean);
    if (!paths.some((path) => transcriptsMatch(path, transcriptPath))) continue;
    if (!best || String(item.started_at || '') > String(best.started_at || '')) {
      best = { sessionId, session_file: item.session_file, started_at: item.started_at || '' };
    }
  }
  return best;
}

export function truncate(text, max = 240) {
  const clean = redactSecrets(String(text || '').replace(/\s+/g, ' ').trim());
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 3)).trim()}...`;
}

export function uniquePath(basePath) {
  if (!existsSync(basePath)) return basePath;
  const extMatch = basePath.match(/(\.[^.\/]+)$/);
  const ext = extMatch ? extMatch[1] : '';
  const stem = ext ? basePath.slice(0, -ext.length) : basePath;
  let index = 2;
  while (existsSync(`${stem}-${index}${ext}`)) index += 1;
  return `${stem}-${index}${ext}`;
}

export function wikilinkFromRel(relPath) {
  return `[[${relPath.replace(/\.md$/i, '').replaceAll('\\', '/')}]]`;
}

// Per-iteration dedup marker (an invisible HTML comment). Provider-neutral name `wk-turn`; the
// old `codex-turn` (legacy, from when this was a Codex-only tool) is still RECOGNIZED so notes
// written by older versions keep deduping, and normalizeTurnMarkers migrates them on the next write.
export const TURN_MARKER = 'wk-turn';
export const LEGACY_TURN_MARKERS = ['codex-turn'];

export function turnMarker(id) {
  return `<!-- ${TURN_MARKER}: ${id} -->`;
}

export function hasTurnMarker(content, id) {
  return [TURN_MARKER, ...LEGACY_TURN_MARKERS].some((m) => String(content || '').includes(`<!-- ${m}: ${id} -->`));
}

// Rewrite any legacy turn markers in a note to the current name (self-healing migration).
export function normalizeTurnMarkers(content) {
  let c = String(content || '');
  for (const m of LEGACY_TURN_MARKERS) c = c.replaceAll(`<!-- ${m}: `, `<!-- ${TURN_MARKER}: `);
  return c;
}

export function listMarkdownFiles(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
}

// Sequential numbering shared by every derived-note family (ADR-, BUG-, APR-):
// recursive walk because notes live in dated subfolders (AAAA/MM-MMM and legacy DIA DD).
export function getNextDerivedNumber(vaultBase, folderKey, prefix) {
  const baseDir = join(vaultBase, getLocale(vaultBase).folders[folderKey]);
  const re = new RegExp(`^${prefix}-(\\d+)`, 'i');
  let max = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name));
      } else {
        const match = entry.name.match(re);
        if (match) max = Math.max(max, Number(match[1]));
      }
    }
  };
  walk(baseDir);
  return max + 1;
}

export function getNextAdrNumber(vaultBase) {
  return getNextDerivedNumber(vaultBase, 'decisions', 'ADR');
}

export function statExists(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}
