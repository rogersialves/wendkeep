#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { request } from 'http';
import { pathToFileURL } from 'url';
import { createLinkedNotes } from './linked-notes.mjs';
import { addUsage, costBreakdown, emptyTokenUsage, normalizeClaudeUsage, normalizeCodexUsage, priceForModel } from './token-usage.mjs';
import { buildBrainDigest, buildBrainIndex } from './brain-core.mjs';
import { activeChangeLink, pruneChangeSentinels } from './change-core.mjs';
import { getLocale } from './locale.mjs';
import { materializeSessionObservability } from './session-observability.mjs';
import { resolveSessionEntry } from './session-identity.mjs';
import { resolveObservabilityRoots } from './session-observability-lifecycle.mjs';
import {
  markObservabilityCheckpoint,
  readObservabilityStore,
} from './session-observability-store.mjs';
import { mutateSessionNote } from './session-note-io.mjs';
import { appendIterationOutcome } from './session-iteration-outcome.mjs';
import { applyDerivedSections, provenanceSessions } from './derived-sections.mjs';
import { buildSessionMemoryEvents, collectLifecycleEvidence } from './memory-handoff.mjs';
import { enqueueMemoryEvent, projectMemoryOutbox } from './memory-store.mjs';
import { detectMemoryMode } from './memory-mode.mjs';
import { sanitizeMemoryText } from './memory-schema.mjs';
import { assertVaultPathSafe } from './vault-path-safety.mjs';
import {
  projectStopMemoryAttempt,
  recordStopMemoryOutcome,
  stageStopMemoryAttempt,
} from './session-memory-lifecycle.mjs';
import {
  parseClaudeTranscriptContent,
  parseCodexTranscriptContent,
  parseTranscriptContent,
  resolveTurnIdentity,
} from '../packages/integrations/src/transcripts.mjs';
import {
  isSyntheticTranscriptText,
  sanitizeAssistantMessage,
} from '../packages/integrations/src/prompt-content.mjs';

const UNRESOLVED_SESSION_ID = 'unresolved';
const UNRESOLVED_TURN_ID = 'unresolved-turn';
const ABORTED_TURN_NOTICE = 'wendkeep: Stop ignorado; o turno foi abortado no transcript.';

export { resolveTurnIdentity };
import {
  ensureDir,
  findActiveSessionByTranscript,
  formatDate,
  formatHourMinute,
  formatLocalIso,
  getNextAdrNumber,
  getVaultBase,
  warnIfDefaultVault,
  listMarkdownFiles,
  readControl,
  readHookInput,
  redactSecrets,
  slugify,
  toVaultRelative,
  truncate,
  uniquePath,
  upsertSessionRegistry,
  wikilinkFromRel,
  writeControl,
  writeHookOutput,
  turnMarker,
  hasTurnMarker,
  normalizeTurnMarkers,
  mutateSessionRegistry,
  closeSessionActivation,
  resolveRegisteredTurnSequence,
  resolveStopActivation,
  applyStopActivation,
} from './obsidian-common.mjs';

function shouldIgnoreUserText(text) {
  // Tags injetadas pelo harness não são fala humana e nunca viram título/Pedido/Usuário.
  return isSyntheticTranscriptText(text);
}

function addUnique(list, value) {
  const clean = redactSecrets(String(value || '').trim());
  if (clean && !list.includes(clean)) list.push(clean);
}

function createTurn(turnId = '', timestamp = '') {
  return {
    turnId,
    timestamp,
    userPrompts: [],
    assistantMessages: [],
    tools: [],
    consultedFiles: [],
    changedFiles: [],
    conversation: [],
    usage: emptyTokenUsage(),
    model: '',
  };
}

const REPO_ROOT = String(process.cwd() || '')
  .replace(/\\+/g, '/')
  .replace(/\/+$/, '');

// Raiz do Vault: resolvida em call-time para que testes possam controlar
// process.env.OBSIDIAN_VAULT_PATH sem depender de variáveis de ambiente da máquina.
function vaultPathRoots() {
  let root = '';
  try {
    root = String(getVaultBase() || '')
      .replace(/\\+/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
  } catch {
    root = '';
  }
  if (!root || !REPO_ROOT) return { root, rel: '' };
  const repoLower = REPO_ROOT.toLowerCase();
  const rel = root.startsWith(`${repoLower}/`) ? root.slice(repoLower.length + 1) : '';
  return { root, rel };
}

function normalizeExtractedPath(value) {
  const cleaned = String(value || '')
    .replace(/\\+/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/[:.,;)}\]]+$/, '');
  // Caminhos absolutos dentro do repo viram relativos para deduplicar com as
  // formas relativas (e variações de caixa do drive no Windows).
  if (REPO_ROOT && cleaned.toLowerCase().startsWith(`${REPO_ROOT.toLowerCase()}/`)) {
    return cleaned.slice(REPO_ROOT.length + 1);
  }
  return cleaned;
}

function shouldIgnoreExtractedPath(path) {
  if (!path) return true;
  const { root: VAULT_ROOT, rel: VAULT_REL } = vaultPathRoots();
  if (VAULT_ROOT && path.toLowerCase().startsWith(`${VAULT_ROOT}/`)) return true; // notas do Vault (abs)
  if (VAULT_REL && path.toLowerCase().startsWith(`${VAULT_REL}/`)) return true; // notas do Vault (rel)
  if (path.includes('/.codex/sessions/')) return true;
  if (path.includes('/.claude/projects/')) return true; // transcripts internos do Claude
  if (path.startsWith('../') || path.includes('/../')) return true; // relativos que escapam
  if (/(?:^|\/)(?:CURRENT_SESSION\.md|SESSION_REGISTRY\.json)$/.test(path)) return true; // controle interno
  if (/^[A-Za-z]:\/[A-Za-z]:\//.test(path)) return true;
  if (/^Alves\/\.codex\//.test(path)) return true;
  if (/\/\.[A-Za-z0-9]+(?::\d+)?$/.test(path)) return true;
  return false;
}

function shouldDropFileListLine(line) {
  if (/^- Nenhum/.test(line)) return true;
  const match = String(line || '').match(/^- `(.+)`$/);
  return Boolean(match && shouldIgnoreExtractedPath(normalizeExtractedPath(match[1])));
}

// Reescreve uma linha de lista `- `<path>`` com o path normalizado (absoluto do
// repo → relativo), para auto-reparar listas antigas com formas duplicadas.
function normalizeFileListLine(line) {
  const match = String(line).match(/^- `(.+)`$/);
  if (!match) return line;
  return `- \`${normalizeExtractedPath(match[1])}\``;
}

function transcriptContent(transcriptPath) {
  return transcriptPath && existsSync(transcriptPath)
    ? readFileSync(transcriptPath, 'utf-8')
    : '';
}

function transcriptOptions() {
  let vaultRoot = '';
  try { vaultRoot = getVaultBase(); } catch { /* projeto sem binding */ }
  return { repoRoot: process.cwd(), vaultRoot };
}

export function parseCodexTranscript(transcriptPath) {
  return parseCodexTranscriptContent(transcriptContent(transcriptPath), transcriptOptions());
}

export function parseClaudeTranscript(transcriptPath) {
  return parseClaudeTranscriptContent(transcriptContent(transcriptPath), transcriptOptions());
}

export function parseTranscript(transcriptPath) {
  return parseTranscriptContent(transcriptContent(transcriptPath), transcriptOptions());
}

function escapeMarkdownBackticks(text) {
  let escaped = '';
  let precedingBackslashes = 0;
  for (const char of String(text || '')) {
    if (char === '\\') {
      escaped += char;
      precedingBackslashes += 1;
      continue;
    }
    if (char === '`') {
      if (precedingBackslashes % 2 === 0) escaped += '\\';
      escaped += char;
      precedingBackslashes = 0;
      continue;
    }
    escaped += char;
    precedingBackslashes = 0;
  }
  return escaped;
}

function escapeMarkdownHtmlTags(text) {
  return String(text || '').replace(
    /<(\/?[\p{L}][\p{L}\p{N}_.-]*)(?=[\s/>])([^<>\n]*)>/gu,
    '&lt;$1$2&gt;',
  );
}

function compactText(text, max = 600) {
  const clean = redactSecrets(String(text || ''))
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const source = clean || 'Não capturado automaticamente.';
  const compact = source.replace(/\s+/g, ' ').trim();
  const clipped = truncate(source, max);
  // Um corte no meio de código inline/fence pode casar com backticks da próxima
  // entrada gerada. Só snippets realmente truncados perdem a formatação incompleta.
  const markdownSafe = compact.length > max ? escapeMarkdownBackticks(clipped) : clipped;
  return escapeMarkdownHtmlTags(markdownSafe);
}

function selectTurn(tx, turnId) {
  return tx.turns.find((turn) => turn.turnId === turnId)
    || tx.turns.find((turn) => turn.turnId === tx.latestTurnId)
    || tx.turns.at(-1)
    || createTurn(turnId || tx.latestTurnId || 'turno');
}

function formatConversation(turn) {
  const entries = (turn.conversation || [])
    .map((entry) => (
      entry.role === 'Assistente'
        ? { ...entry, text: sanitizeAssistantMessage(entry.text) }
        : entry
    ))
    .filter((entry) => entry.text && !shouldIgnoreUserText(entry.text));
  if (!entries.length) return '- Nenhuma mensagem útil capturada no transcript.';

  const maxEntries = 12;
  const omitted = entries.length > maxEntries ? entries.length - maxEntries + 1 : 0;
  const visible = omitted
    ? [
      ...entries.slice(0, 2),
      { role: 'Resumo', text: `${omitted} mensagens intermediárias omitidas para manter a nota legível.` },
      ...entries.slice(-(maxEntries - 3)),
    ]
    : entries;

  return visible
    .map((entry) => {
      const limit = entry.role === 'Usuário' ? 900 : 500;
      return `- **${entry.role}:** ${compactText(entry.text, limit)}`;
    })
    .join('\n');
}

function formatInlineList(items, fallback = 'Nenhuma registrada.') {
  const clean = [...new Set((items || []).filter(Boolean))].slice(0, 12);
  return clean.length ? clean.map((item) => `\`${item}\``).join(', ') : fallback;
}

function fmtTokens(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function fmtUsd(n) {
  return `$${(Math.round((Number(n) || 0) * 10000) / 10000).toFixed(4)}`;
}

// Resumo inline dos tokens do turno: contagem por tipo + custo USD entre
// parênteses (quando o modelo está tabelado). Texto neutro quando ausente.
function formatTokenLine(usage, model) {
  const u = usage || {};
  if (!u.total) return 'não reportados neste turno';
  const cost = costBreakdown(u, priceForModel(model));
  const cell = (label, n, c) => `${label} ${fmtTokens(n)}${c != null ? ` (${fmtUsd(c)})` : ''}`;
  const parts = [cell('entrada', u.input, cost?.input), cell('cache leitura', u.cached, cost?.cached)];
  if (u.cacheWrite) parts.push(cell('cache escrita', u.cacheWrite, cost?.cacheWrite));
  parts.push(cell('saída', u.output, cost?.output));
  if (u.reasoning) parts.push(`raciocínio ${fmtTokens(u.reasoning)}`);
  parts.push(cell('total', u.total, cost?.total));
  const line = parts.join(' · ');
  // Custo é estimativa API-equivalente (preço da API avulsa), não cobrança do plano/assinatura.
  return cost ? `${line} — ≈ API equivalente (não é cobrança do plano)` : line;
}

// User-facing explanation for a turn that could not be memorialized. Names the upstream bug
// when the payload arrived salvaged, because "wendkeep didn't record it" reads as a wendkeep
// defect and the user would have nowhere to look.
export function bailMessage(why, input = {}) {
  const truncated = input._wkSalvaged
    ? ' O payload do Stop chegou truncado (openai/codex#23784).'
    : '';
  return `[wendkeep] Turno não registrado: ${why}.${truncated} Recupere com \`wendkeep import --source codex\`.`;
}

export function buildIterationBlock(tx, input) {
  const turnId = input.turn_id || tx.latestTurnId || `${Date.now()}`;
  const turn = selectTurn(tx, turnId);
  const preferredDate = input.now || turn.timestamp || '';
  const parsedDate = preferredDate ? new Date(preferredDate) : new Date();
  const now = Number.isFinite(parsedDate.getTime()) ? parsedDate : new Date();
  const promptText = turn.userPrompts.at(-1) || tx.latestUserPrompt || '';
  const latestAssistant = turn.assistantMessages.at(-1) || tx.latestAssistantMessage || '';
  const heading = escapeMarkdownHtmlTags(
    truncate(promptText.replace(/[\r\n#]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Iteração', 80),
  );
  const files = [...new Set([...(turn.consultedFiles || []), ...(turn.changedFiles || [])])];
  const model = turn.model || tx.model || '';

  // O bloco de iteração precisa ser autoexplicativo para retomada futura:
  // inclui recortes da conversa do turno, sem despejar outputs brutos.
  return `
### ${formatTimeForHeading(now)} - ${heading}
${turnMarker(turnId)}

**Pedido:** ${compactText(promptText, 1000)}

**Contexto conversado:**
${formatConversation(turn)}

**Ferramentas usadas:** ${formatInlineList(turn.tools || tx.tools)}

**Tokens${model ? ` (${model})` : ''}:** ${formatTokenLine(turn.usage, model)}

**Arquivos detectados no turno:** ${formatInlineList(files, 'Nenhum arquivo detectado automaticamente.')}

**Estado ao final do turno:** ${compactText(sanitizeAssistantMessage(latestAssistant) || 'Checkpoint registrado automaticamente ao final do turno.', 900)}
`;
}

function formatTimeForHeading(date) {
  return formatHourMinute(date).replace('-', ':');
}

// Mescla `lines` à seção dedicada `## <heading>`, deduplicando e descartando
// linhas que casem `dropPattern` (placeholders). No-op se a seção não existe ou
// não há linhas novas. Preserva o restante do arquivo.
function upsertListSection(content, heading, lines, dropPattern, transform) {
  if (!lines.length) return content;
  const shouldDrop = (line) => {
    if (!dropPattern) return false;
    if (typeof dropPattern === 'function') return dropPattern(line);
    return dropPattern.test(line);
  };
  const marker = `\n## ${heading}\n`;
  const start = content.indexOf(marker);
  if (start === -1) return content;
  const bodyStart = start + marker.length;
  const nextRel = content.slice(bodyStart).search(/\n## /);
  const bodyEnd = nextRel === -1 ? content.length : bodyStart + nextRel;

  const existing = content.slice(bodyStart, bodyEnd)
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.startsWith('- ') && !shouldDrop(l))
    .map((l) => (transform ? transform(l) : l));

  const merged = [];
  for (const line of existing) addUnique(merged, line);
  for (const line of lines) addUnique(merged, line);

  return `${content.slice(0, bodyStart)}\n${merged.join('\n')}\n\n${content.slice(bodyEnd).replace(/^\n+/, '')}`;
}

const DEFAULT_PENDING_PATTERNS = [
  /^- \[ \] Revisar resumo da sessão$/i,
  /^- \[ \] Verificar se houve decisões a registrar$/i,
  /^- \[ \] Verificar se houve bugs a registrar$/i,
  /^- \[ \] Verificar se houve aprendizados a registrar$/i,
  /^- Nenhuma pendência identificada automaticamente\.$/i,
  /^Nenhuma pendência identificada automaticamente\.$/i,
];

function isDefaultPendingLine(line) {
  const clean = String(line || '').trim();
  return DEFAULT_PENDING_PATTERNS.some((pattern) => pattern.test(clean));
}

export function cleanPendingPlaceholders(content) {
  const marker = '\n## Pendências\n';
  const start = content.indexOf(marker);
  if (start === -1) return content;

  const bodyStart = start + marker.length;
  const nextRel = content.slice(bodyStart).search(/\n## /);
  const bodyEnd = nextRel === -1 ? content.length : bodyStart + nextRel;
  const kept = content.slice(bodyStart, bodyEnd)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !isDefaultPendingLine(line));
  const body = kept.length
    ? kept.join('\n')
    : 'Nenhuma pendência identificada automaticamente.';

  return `${content.slice(0, bodyStart)}\n${body}\n\n${content.slice(bodyEnd).replace(/^\n+/, '')}`;
}

// Roteia arquivos consultados/alterados e pendências detectadas para as seções
// dedicadas do rodapé, em vez de duplicá-los dentro de cada bloco de iteração.
function applyDedicatedSections(content, tx) {
  const consulted = tx.consultedFiles.map((f) => `- \`${f}\``);
  const changed = tx.changedFiles.map((f) => `- \`${f}\``);
  const pending = extractPending(tx.rawTextForDetection)
    .map((p) => `- [ ] ${p.replace(/^[-*]\s*(\[ \]\s*)?/, '').trim()}`);

  let next = content;
  next = upsertListSection(next, 'Arquivos consultados', consulted, shouldDropFileListLine, normalizeFileListLine);
  next = upsertListSection(next, 'Arquivos criados ou alterados', changed, shouldDropFileListLine, normalizeFileListLine);
  next = cleanPendingPlaceholders(upsertListSection(next, 'Pendências', pending, isDefaultPendingLine));
  return next;
}

// Insere `block` dentro da seção `## Iterações`, em ordem de preferência de âncora:
// antes de `## Decisões geradas nesta sessão`; senão logo após o heading `## Iterações`;
// senão antes de `## Encerramento`; senão no fim do arquivo.
function insertIntoIteracoes(content, block) {
  const iter = content.indexOf('\n## Iterações');
  if (iter !== -1) {
    const anchors = [
      '\n## Agentes, tokens e custos',
      '\n## Uso de tokens e custos',
      '\n## Decisões geradas nesta sessão',
      '\n## Bugs gerados nesta sessão',
      '\n## Aprendizados gerados nesta sessão',
      '\n## Arquivos consultados',
      '\n## Arquivos criados ou alterados',
      '\n## Pendências',
      '\n## Encerramento',
    ]
      .map((anchor) => content.indexOf(anchor, iter + 1))
      .filter((index) => index !== -1)
      .sort((a, b) => a - b);
    if (anchors.length) {
      const at = anchors[0];
      return `${content.slice(0, at).trimEnd()}\n${block}\n${content.slice(at)}`;
    }
    const lineEnd = content.indexOf('\n', iter + 1);
    const at = lineEnd === -1 ? content.length : lineEnd + 1;
    return `${content.slice(0, at).trimEnd()}\n${block}\n${content.slice(at)}`;
  }
  const enc = content.indexOf('\n## Encerramento');
  if (enc !== -1) {
    return `${content.slice(0, enc).trimEnd()}\n${block}\n${content.slice(enc)}`;
  }
  return `${content.trimEnd()}\n${block}\n`;
}

// Auto-reparo: realoca blocos `## ...` órfãos que o agente anexou após `## Encerramento`
// (iterações fora de lugar) de volta para dentro de `## Iterações`, rebaixando `##` → `###`.
// `## Encerramento` é sempre a última seção do template, então qualquer heading nível 2
// depois dela é órfão. Idempotente: no-op quando não há órfãos.
function relocateOrphanIterations(content) {
  const closing = '\n## Encerramento';
  const closingIdx = content.indexOf(closing);
  if (closingIdx === -1) return content;

  const afterClosing = closingIdx + closing.length;
  const nextRel = content.slice(afterClosing).search(/\n## /);
  if (nextRel === -1) return content; // Encerramento é a última seção: nada órfão.

  const splitAt = afterClosing + nextRel;
  const head = `${content.slice(0, splitAt).trimEnd()}\n`;
  const demoted = content.slice(splitAt).replace(/^## /gm, '### ').trim();
  if (!demoted) return content;

  return insertIntoIteracoes(head, `\n${demoted}`);
}

export function insertIteration(sessionPath, block, turnId, tx, vaultBase = '') {
  let inserted = false;
  let duplicate = false;
  // Sob lock: outro hook (subagent-stop) pode estar reescrevendo a mesma nota agora.
  const mutation = mutateSessionNote(sessionPath, (original) => {
    // Self-heal: migrate any legacy `codex-turn` markers to the neutral name on this write.
    let content = normalizeTurnMarkers(original);
    if (hasTurnMarker(content, turnId)) {
      duplicate = true;
      // Turno já registrado: ainda assim repara órfãos e seções dedicadas.
      return applyDedicatedSections(relocateOrphanIterations(content), tx);
    }
    content = relocateOrphanIterations(content);
    content = insertIntoIteracoes(content, block);
    inserted = true;
    return applyDedicatedSections(content, tx);
  }, { vaultBase });
  const result = duplicate
    ? 'duplicate'
    : mutation.written && inserted
      ? 'inserted'
      : mutation.reason === 'busy'
        ? 'busy'
        : 'failed';
  return {
    inserted: result === 'inserted',
    confirmed: result === 'inserted' || result === 'duplicate',
    written: Boolean(mutation.written),
    result,
    reason: mutation.reason || 'unknown',
  };
}

export function confirmedLoggedTurnId(currentTurnId, candidateTurnId, projection) {
  return projection?.confirmed ? candidateTurnId : currentTurnId;
}

function shouldFinalizeSession() {
  // Finaliza em todo Stop por padrão; escape hatch negativo p/ debug/teste.
  return process.env.OBSIDIAN_NO_AUTO_FINALIZE !== '1';
}

function sharedHandoffFromInput(input = {}, entry = {}) {
  const supplied = input.shared || input.handoff?.shared;
  const shared = supplied && typeof supplied === 'object' && !Array.isArray(supplied)
    ? { ...supplied }
    : {};
  const workSessionId = shared.work_session_id
    || shared.workSessionId
    || input.work_session_id
    || input.workSessionId
    || entry?.work_session_id
    || '';
  if (!shared.work_session_id && workSessionId) shared.work_session_id = workSessionId;
  return Object.keys(shared).length ? shared : null;
}

export function commitSessionMemory(vaultBase, handoff, { projectOptions = {} } = {}) {
  if (detectMemoryMode(vaultBase).mode === 'legacy') {
    return { status: 'legacy', eventCount: 0, eventIds: [], checkpoint: null };
  }
  const events = buildSessionMemoryEvents(handoff);
  const eventIds = events.map((event) => event.event_id);
  try {
    for (const event of events) enqueueMemoryEvent(vaultBase, event);
    const projection = projectMemoryOutbox(vaultBase, projectOptions);
    if (projection.status === 'busy') {
      return {
        status: 'degraded',
        error: 'memory projector busy; outbox preserved for replay',
        eventCount: events.length,
        eventIds,
        checkpoint: null,
      };
    }
    return {
      status: 'projected',
      eventCount: events.length,
      eventIds,
      checkpoint: projection.checkpoint && typeof projection.checkpoint === 'object'
        ? { ...projection.checkpoint }
        : {
          revision: projection.revision,
          event_cursor: projection.eventCursor,
          state_hash: projection.stateHash,
        },
    };
  } catch (error) {
    return {
      status: 'degraded',
      error: sanitizeMemoryText(error?.message || String(error)),
      eventCount: events.length,
      eventIds,
      checkpoint: null,
    };
  }
}

// Só captura checkboxes de tarefa reais (`- [ ] ...`). Antes casava as palavras
// `todo`/`pendência`/`pendente` em prosa (ex.: "todo" dentro de "todos"), o que
// despejava trechos de conversa na seção Pendências.
export function extractPending(text) {
  const pending = [];
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    if (/^\s*[-*]\s*\[ \]\s+\S/.test(line)) addUnique(pending, truncate(line.trim(), 160));
  }
  return pending.slice(0, 8);
}

function noteReferencesSession(content, sessionRel) {
  // Quando a derivada declara `source:`, ele manda: uma nota que apenas CITA outra sessão
  // (em `related:` ou na prosa) não pertence a ela. Sem `source:` (nota legada), qualquer
  // referência vale — é o que DRV-5 estabeleceu e o que `note relink` existe para corrigir.
  const declared = provenanceSessions(content);
  if (declared.length) {
    const key = sessionRel.replace(/\.md$/, '').replaceAll('\\', '/');
    return declared.some((target) => target.replace(/\.md$/, '') === key);
  }
  const sessionLink = wikilinkFromRel(sessionRel);
  return content.includes(sessionRel) || content.includes(sessionLink);
}

export function findLinkedDerivedNotes(vaultBase, sessionRel) {
  const linked = { decisions: [], bugs: [], learnings: [] };
  const locF = getLocale(vaultBase).folders;
  const folders = {
    decisions: locF.decisions,
    bugs: locF.bugs,
    learnings: locF.learnings,
  };

  // Recursive: derived notes live in month subfolders (04-Decisões/2026/07-JUL/ADR-...,
  // 05-Bugs/.../BUG-...) — a root-only scan missed every one of them.
  const walk = (dir, key) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const absPath = join(dir, entry.name);
      if (entry.isDirectory()) { walk(absPath, key); continue; }
      if (!entry.name.endsWith('.md')) continue;
      try {
        const content = readFileSync(absPath, 'utf-8');
        if (noteReferencesSession(content, sessionRel)) {
          linked[key].push(toVaultRelative(vaultBase, absPath));
        }
      } catch {
        // Ignore unreadable notes; the hook must not block session shutdown.
      }
    }
  };
  for (const [key, folder] of Object.entries(folders)) walk(join(vaultBase, folder), key);

  return linked;
}

export function mergeCreatedNotes(created, linked) {
  const merged = { decisions: [], bugs: [], learnings: [] };
  for (const key of Object.keys(merged)) {
    merged[key] = [...new Set([...(created[key] || []), ...(linked[key] || [])])];
  }
  return merged;
}

function formatPendingSection(pending) {
  return pending.length
    ? pending.map((item) => `- ${item}`).join('\n')
    : 'Nenhuma pendência identificada automaticamente.';
}

function formatPendingClosing(pending) {
  return pending.length
    ? pending.map((item) => `  - ${item}`).join('\n')
    : '  - Nenhuma pendência identificada automaticamente.';
}

function updateFrontmatter(content, endedAt) {
  let next = content;
  next = next.replace(/^ended_at:.*$/m, `ended_at: ${endedAt}`);
  next = next.replace(/^status:.*$/m, 'status: done');
  return next;
}

function replacePendingSection(content, pending) {
  const marker = '\n## Pendências';
  const closingMarker = '\n## Encerramento';
  const start = content.indexOf(marker);
  if (start === -1) return content;

  const end = content.indexOf(closingMarker, start + marker.length);
  if (end === -1) return content;

  // Preserva seções que outros writers inseriram dentro do span (observabilidade,
  // ## Progresso do plano, ## Mudanças…) — só o texto das Pendências em si é regenerado.
  const span = content.slice(start + marker.length, end);
  const innerIdx = span.indexOf('\n## ');
  const preserved = innerIdx === -1 ? '' : span.slice(innerIdx).trimEnd();

  return [
    content.slice(0, start).trimEnd(),
    '',
    '## Pendências',
    '',
    formatPendingSection(pending),
    ...(preserved ? [preserved] : []),
    content.slice(end),
  ].join('\n');
}

function replaceClosingSection(content, closing) {
  const marker = '\n## Encerramento';
  const index = content.indexOf(marker);
  if (index === -1) return `${content.trimEnd()}\n\n${closing}\n`;
  return `${content.slice(0, index).trimEnd()}\n\n${closing}\n`;
}

const GENERATED_ITERATION_LINE_RULES = [
  { pattern: /^(### \d{2}:\d{2} - )(.*)$/u, assistant: false },
  { pattern: /^(\*\*Pedido:\*\* )(.*)$/u, assistant: false },
  { pattern: /^(- \*\*Usuário:\*\* )(.*)$/u, assistant: false },
  { pattern: /^(- \*\*Assistente:\*\* )(.*)$/u, assistant: true },
  { pattern: /^(- \*\*Resumo:\*\* )(.*)$/u, assistant: true },
  { pattern: /^(\*\*Estado ao final do turno:\*\* )(.*)$/u, assistant: true },
];
const GENERATED_CLOSING_LINE_RULES = [
  { pattern: /^(- \*\*Resumo final:\*\* )(.*)$/u, assistant: true },
];

function generatedSessionLine(line, rules) {
  for (const rule of rules) {
    const match = rule.pattern.exec(line);
    if (match) return { ...rule, prefix: match[1], value: match[2] };
  }
  return null;
}

function splitSessionMarkdownLines(source) {
  const lines = [];
  let cursor = 0;
  while (cursor < source.length) {
    const newline = source.indexOf('\n', cursor);
    if (newline === -1) {
      lines.push({ text: source.slice(cursor), eol: '' });
      break;
    }
    const textEnd = source[newline - 1] === '\r' ? newline - 1 : newline;
    lines.push({ text: source.slice(cursor, textEnd), eol: source.slice(textEnd, newline + 1) });
    cursor = newline + 1;
  }
  return lines;
}

function generatedMetadataContinuation(line, mode = '') {
  const clean = line.trim();
  if (!clean) return null;
  if (/^<\/?session\s*>/i.test(clean)) return mode;
  if (/^<\/?(?:oai-mem-citation|citation_entries|rollout_ids)\b/i.test(clean)) {
    const nested = [...clean.matchAll(/<(citation_entries|rollout_ids)\b[^>]*>/gi)].at(-1);
    return nested ? nested[1].toLowerCase() : mode;
  }
  if (mode === 'citation_entries' && (
    /\|note=\[[^\]]*\]\s*$/i.test(clean)
      || /^[^\s<>]+:\d+(?:-\d+)?(?:\|[^\s].*)?$/i.test(clean)
  )) return mode;
  if (mode === 'rollout_ids' && /^(?:[0-9a-f]{8,}(?:-[0-9a-f-]+)*|019f-[A-Za-z0-9_-]+)$/i.test(clean)) {
    return mode;
  }
  return null;
}

export function sanitizeGeneratedSessionMarkdown(content) {
  const lines = splitSessionMarkdownLines(String(content || ''));
  let section = '';
  let output = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^## /u.test(line.text)) {
      section = line.text === '## Iterações'
        ? 'iterations'
        : (line.text === '## Encerramento' ? 'closing' : '');
      output += `${line.text}${line.eol}`;
      continue;
    }

    const rules = section === 'iterations'
      ? GENERATED_ITERATION_LINE_RULES
      : (section === 'closing' ? GENERATED_CLOSING_LINE_RULES : []);
    const generated = generatedSessionLine(line.text, rules);
    if (!generated) {
      output += `${line.text}${line.eol}`;
      continue;
    }

    let value = generated.value;
    let last = index;
    let mode = '';
    if (generated.assistant) {
      for (let next = index + 1; next < lines.length; next += 1) {
        const nextMode = generatedMetadataContinuation(lines[next].text, mode);
        if (nextMode === null) break;
        value += `${lines[last].eol}${lines[next].text}`;
        last = next;
        mode = nextMode;
      }
      value = sanitizeAssistantMessage(value);
    }

    output += `${generated.prefix}${escapeMarkdownHtmlTags(value)}${lines[last].eol}`;
    index = last;
  }
  return output;
}

export function finalizeSessionFile(sessionPath, tx, created, endedAt, vaultBase = '') {
  const pending = extractPending(tx.rawTextForDetection);
  const links = (items) => items.length ? items.map((rel) => `  - ${wikilinkFromRel(rel)}`).join('\n') : '  - Nenhuma';
  const summary = sessionFinalSummary(tx);

  const closing = `## Encerramento

- **Fim:** ${endedAt}
- **Status:** done
- **Resumo final:** ${summary}
- **Decisões registradas:**
${links(created.decisions)}
- **Bugs registrados:**
${links(created.bugs)}
- **Aprendizados registrados:**
${links(created.learnings)}
- **Pendências:**
${formatPendingClosing(pending)}
`;

  mutateSessionNote(sessionPath, (content) => replaceClosingSection(
    // As três seções derivadas saem do MESMO `created` que monta o Encerramento — antes
    // elas ficavam de fora deste write e a nota mentia no corpo (ver hooks/derived-sections.mjs).
    applyDerivedSections(
      replacePendingSection(updateFrontmatter(sanitizeGeneratedSessionMarkdown(content), endedAt), pending),
      created,
    ),
    closing,
  ), { vaultBase });
}

export function sessionFinalSummary(tx) {
  const assistantSummary = sanitizeAssistantMessage(tx.latestAssistantMessage);
  return assistantSummary
    ? compactText(assistantSummary, 500)
    : `Sessão encerrada com ${tx.userPrompts.length} prompts e ${tx.tools.length} ferramentas registradas.`;
}

// --- Vínculo Sessão ↔ Issues Linear (03-Linear) -------------------------------
// Coleta IDs `NUT-\d+` citados na conversa, resolve as notas em 03-Linear e, ao
// ler cada nota, descobre NUTs conectadas (1 salto) mencionadas no corpo dela.
// Escreve os wikilinks numa seção `## Issues Linear` da própria sessão; o backlink
// na nota da NUT é resolvido pelo Obsidian (sem editar a nota sincronizada).
const LINEAR_DIR = '03-Linear';

function collectIssueIds(text) {
  const ids = [];
  const regex = /\bNUT-\d+\b/gi;
  let match;
  while ((match = regex.exec(String(text || ''))) !== null) {
    const id = match[0].toUpperCase();
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function findLinearNote(vaultBase, issueId) {
  const dir = join(vaultBase, LINEAR_DIR);
  const byName = new RegExp(`^${issueId}(?![0-9])`, 'i');
  for (const fileName of listMarkdownFiles(dir)) {
    if (byName.test(fileName)) return toVaultRelative(vaultBase, join(dir, fileName));
  }
  const byFront = new RegExp(`^linear_identifier:\\s*["']?${issueId}["']?\\s*$`, 'im');
  for (const fileName of listMarkdownFiles(dir)) {
    try {
      if (byFront.test(readFileSync(join(dir, fileName), 'utf-8'))) {
        return toVaultRelative(vaultBase, join(dir, fileName));
      }
    } catch {
      // Nota ilegível: ignora; o hook não pode travar o encerramento.
    }
  }
  return null;
}

function findConnectedIssueIds(vaultBase, noteRel, excludeId) {
  try {
    const content = readFileSync(join(vaultBase, noteRel), 'utf-8');
    return collectIssueIds(content).filter((id) => id !== excludeId);
  } catch {
    return [];
  }
}

// Insere uma seção `## <heading>` vazia antes de `beforeMarker` se ainda não existir.
function ensureSection(content, heading, beforeMarker) {
  if (content.includes(`\n## ${heading}\n`)) return content;
  const block = `## ${heading}\n\n`;
  const index = content.indexOf(beforeMarker);
  if (index === -1) return `${content.trimEnd()}\n\n${block}`;
  return `${content.slice(0, index).trimEnd()}\n\n${block}${content.slice(index + 1)}`;
}

function applyLinearLinks(sessionPath, tx, vaultBase, sessionRel) {
  const seeds = collectIssueIds(tx.rawTextForDetection);
  if (!seeds.length) return;

  const resolved = new Map(); // issueId -> relPath
  for (const id of seeds) {
    const rel = findLinearNote(vaultBase, id);
    if (rel) resolved.set(id, rel);
  }
  // 1 salto: NUTs conectadas citadas dentro das notas semente.
  for (const [id, rel] of [...resolved]) {
    for (const connId of findConnectedIssueIds(vaultBase, rel, id)) {
      if (resolved.has(connId)) continue;
      const connRel = findLinearNote(vaultBase, connId);
      if (connRel) resolved.set(connId, connRel);
    }
  }
  if (!resolved.size) return;

  const lines = [...resolved.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([id, rel]) => `- ${id} — ${wikilinkFromRel(rel)}`);

  mutateSessionNote(sessionPath, (original) => (
    upsertListSection(ensureSection(original, 'Issues Linear', '\n## Encerramento'), 'Issues Linear', lines, null)
  ), { vaultBase });
}

// Triggers Obsidian Local REST API to re-index the vault after file writes.
// Silent no-op if Obsidian is closed or plugin not installed.
function pingObsidianVault(apiKey) {
  const key = apiKey || process.env.OBSIDIAN_API_KEY || '';
  if (!key) return;
  try {
    const req = request({
      hostname: '127.0.0.1',
      port: 27124,
      path: '/vault/',
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      timeout: 2000,
    });
    req.on('error', () => {});
    req.end();
  } catch {}
}

export function shouldAbortStopAfterStaging(causalStop, memoryAttempt) {
  const rejectedByV2Revalidation = memoryAttempt?.memory_mode === 'v2'
    && memoryAttempt?.state === 'skipped';
  if (rejectedByV2Revalidation) return true;
  return Boolean(
    causalStop
    && !causalStop.canPromoteMemory
    && memoryAttempt?.state !== 'enqueued'
  );
}

const STOP_OBSERVABILITY_DEADLINE_MS = 45_000;

function stopEntryCausalSnapshot(entry) {
  const activationId = String(entry?.active_activation_id || '');
  const activation = entry?.activations?.[activationId] || {};
  return {
    activationId,
    activationEpoch: Number(activation.epoch || entry?.activation_epoch || 0),
    turnSequence: Number(entry?.last_turn_sequence || activation.last_turn_sequence || 0),
  };
}

function expectedStopCausalSnapshot(entry, causalStop, turnSequence) {
  if (!causalStop) return stopEntryCausalSnapshot(entry);
  return {
    activationId: String(causalStop.activationId || ''),
    activationEpoch: Number(causalStop.activation?.epoch || entry?.activation_epoch || 0),
    turnSequence: Number(turnSequence || 0),
  };
}

function sameStopCausalSnapshot(left, right) {
  return left.activationId === right.activationId
    && left.activationEpoch === right.activationEpoch
    && left.turnSequence === right.turnSequence;
}

function stopClaudeRoots(entry) {
  const paths = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) paths.add(value.trim());
  };
  add(entry?.transcript_path);
  for (const path of entry?.transcript_paths || []) add(path);
  for (const activation of Object.values(entry?.activations || {})) {
    add(activation?.transcript_path);
    for (const path of activation?.transcript_paths || []) add(path);
  }
  return { state: 'complete', rootPaths: [...paths], descendantPaths: [], diagnostics: [] };
}

function materializeStopObservability(request) {
  return materializeSessionObservability({
    vaultBase: request.vaultBase,
    sessionPath: request.sessionPath,
    transcriptPath: request.transcriptPath,
    entry: request.entry,
    canonicalConversationId: request.canonicalConversationId,
    frontier: request.frontier,
    signals: request.signals,
    cache: request.cache,
    mode: 'live',
    deadlineAt: request.deadlineAt,
    now: request.now,
    allowNone: request.allowNone,
    readRuntimeFrontier: request.readRuntimeFrontier,
    withPublicationGuard: request.withPublicationGuard,
    writeRegistryCheckpoint: request.writeRegistryCheckpoint,
  });
}

export async function refreshStopObservability({
  vaultBase,
  input,
  sessionPath,
  sessionId,
  entry,
  causalStop,
  turnSequence,
  hookStartedAt,
  expectedSignalSequence,
}, {
  now = Date.now,
  resolveEntry = resolveSessionEntry,
  mutateRegistry = mutateSessionRegistry,
  readStore = readObservabilityStore,
  resolveRoots = resolveObservabilityRoots,
  materialize = materializeStopObservability,
  returnDetails = false,
} = {}) {
  const outcome = (ok, status, reason = '') => (
    returnDetails ? { ok, status, reason } : ok
  );
  if (causalStop && !causalStop.canPromoteMemory) return outcome(false, 'skipped', 'causal-stop-not-promotable');
  const deadlineAt = hookStartedAt + STOP_OBSERVABILITY_DEADLINE_MS;
  if (now() >= deadlineAt) return outcome(false, 'stale', 'deadline-before-refresh');

  const expected = expectedStopCausalSnapshot(entry, causalStop, turnSequence);
  const fresh = resolveEntry(vaultBase, input, entry?.provider);
  if (fresh.identity?.state !== 'resolved'
    || fresh.identity.canonicalConversationId !== sessionId
    || !fresh.entry?.session_file
    || fresh.entry.session_file !== entry?.session_file
    || !sameStopCausalSnapshot(expected, stopEntryCausalSnapshot(fresh.entry))) {
    return outcome(false, 'stale', 'causal-snapshot-changed');
  }

  const runtime = readStore(vaultBase, sessionId);
  const signalSequence = Number(runtime?.observability_signal_sequence || 0);
  if (expectedSignalSequence !== undefined
    && signalSequence !== Number(expectedSignalSequence)) {
    return outcome(false, 'stale', 'signal-sequence-changed');
  }
  if (now() >= deadlineAt) return outcome(false, 'stale', 'deadline-before-materialize');

  const roots = fresh.identity.provider === 'codex'
    ? resolveRoots(fresh.entry)
    : stopClaudeRoots(fresh.entry);
  if (roots?.state !== 'complete' || !roots.rootPaths?.length) {
    return outcome(false, 'missing', 'observability-roots-missing');
  }

  const frontier = {
    canonical_session_id: sessionId,
    activation_id: expected.activationId || 'legacy',
    activation_epoch: expected.activationEpoch,
    turn_sequence: expected.turnSequence,
    signal_sequence: signalSequence,
    roots_stat_hash: 'pending',
    graph_cursor: 'pending',
    source_manifest_hash: 'pending',
  };
  const readRuntimeFrontier = (candidateFrontier, guardContext) => {
    const currentEntry = guardContext?.entry;
    const current = currentEntry
      ? { identity: { state: 'resolved', canonicalConversationId: sessionId }, entry: currentEntry }
      : resolveEntry(vaultBase, input, entry?.provider);
    if (current.identity?.state !== 'resolved'
      || current.identity.canonicalConversationId !== sessionId
      || !current.entry) {
      return { ...candidateFrontier, canonical_session_id: 'unresolved' };
    }
    const currentCausal = stopEntryCausalSnapshot(current.entry);
    const currentRuntime = readStore(vaultBase, sessionId);
    return {
      ...candidateFrontier,
      activation_id: currentCausal.activationId || 'legacy',
      activation_epoch: currentCausal.activationEpoch,
      turn_sequence: currentCausal.turnSequence,
      signal_sequence: Math.max(
        Number(currentRuntime?.observability_signal_sequence || 0),
        Number(current.entry.observability_signal_sequence || 0),
      ),
    };
  };
  const withPublicationGuard = (_candidateFrontier, publishGuarded) => (
    mutateRegistry(vaultBase, (registry) => publishGuarded({
      registry,
      entry: registry.sessions?.[sessionId] || null,
    }))
  );
  const writeRegistryCheckpoint = ({
    frontier: checkpointFrontier,
    state,
    diagnostics,
    snapshot,
  }, guardContext) => {
    const registry = guardContext?.registry;
    const current = registry?.sessions?.[sessionId];
    if (!current) return null;
    const currentSignal = Number(current.observability_signal_sequence || checkpointFrontier.signal_sequence);
    registry.sessions[sessionId] = {
      ...current,
      observability_signal_sequence: currentSignal,
      observability_checkpoint_sequence: checkpointFrontier.signal_sequence,
      observability_dirty: currentSignal > checkpointFrontier.signal_sequence,
      observability_checkpoint_frontier: checkpointFrontier,
      subagents_observability_state: state,
      subagents_diagnostics: diagnostics || [],
    };
    return markObservabilityCheckpoint(vaultBase, sessionId, {
      checkpointSequence: checkpointFrontier.signal_sequence,
      frontier: checkpointFrontier,
      sourceManifest: snapshot?.subagents?.sourceManifest,
      graphCache: snapshot?.subagents?.cache,
      diagnostics,
    });
  };

  const result = await Promise.resolve(materialize({
    vaultBase,
    sessionPath,
    entry: fresh.entry,
    rootPaths: roots.rootPaths,
    transcriptPath: roots.rootPaths[0],
    caller: 'stop',
    canonicalConversationId: sessionId,
    activationId: expected.activationId,
    activationEpoch: expected.activationEpoch,
    turnSequence: expected.turnSequence,
    signalSequence,
    deadlineAt,
    allowNone: true,
    frontier,
    signals: runtime?.signals || [],
    cache: runtime?.graph_cache || null,
    now,
    readRuntimeFrontier,
    withPublicationGuard,
    writeRegistryCheckpoint,
  }));
  const status = result?.status || (result?.ok === false ? 'failed' : 'published');
  return outcome(!['stale', 'conflict', 'degraded', 'missing'].includes(status), status);
}

export function recordStopOutcome(vaultBase, {
  sessionId = UNRESOLVED_SESSION_ID,
  transcriptId = '',
  turnId = UNRESOLVED_TURN_ID,
  turnSequence = 0,
  hook = 'Stop',
  stage = 'iteration',
  result = 'failed',
  lockStatus = 'unknown',
  durationMs = 0,
  reason = '',
} = {}) {
  try {
    return appendIterationOutcome(vaultBase, {
      session_id: sessionId,
      transcript_id: transcriptId,
      turn_id: turnId,
      turn_sequence: turnSequence,
      hook,
      stage,
      result,
      lock_status: lockStatus,
      duration_ms: durationMs,
      occurred_at: new Date().toISOString(),
      reason,
    });
  } catch {
    // O ledger é diagnóstico: um problema nele nunca deve bloquear a sessão nem publicar o erro.
    return { written: false, result: 'failed', reason: 'outcome-ledger-write-failed' };
  }
}

export function finalizeSessionRegistry(vaultBase, {
  sessionId = '',
  activationId = '',
  turnId = '',
  endedAt = '',
} = {}) {
  let disposition = 'ambiguous';
  mutateSessionRegistry(vaultBase, (registry) => {
    const closed = closeSessionActivation(registry, {
      session_id: sessionId,
      activation_id: activationId,
      turn_id: turnId,
      ended_at: endedAt,
    });
    disposition = closed.stopDisposition;
    if (closed.stopDisposition === 'finalized') {
      registry.version = closed.registry.version;
      registry.sessions = closed.registry.sessions;
    }
    return null;
  });
  return disposition;
}

export async function main({
  stageMemory = stageStopMemoryAttempt,
  clock = Date.now,
  refreshObservability = refreshStopObservability,
} = {}) {
  const hookStartedAt = clock();
  const input = readHookInput();
  if (input.stop_hook_active) {
    writeHookOutput({});
    return;
  }

  const vaultBase = getVaultBase(input);
  warnIfDefaultVault(input);
  const control = readControl(vaultBase);
  const transcriptPath = input.transcript_path || input.transcriptPath || '';
  const { identity, entry } = resolveSessionEntry(vaultBase, input);
  if (identity.state !== 'resolved' || !entry?.session_file) {
    const why = identity.diagnostics?.join('; ') || 'sessão não registrada';
    recordStopOutcome(vaultBase, {
      sessionId: identity.canonicalConversationId || input.session_id || 'unresolved',
      transcriptId: identity.transcriptId || input.transcript_id || '',
      turnId: input.turn_id || input.turnId || 'unresolved-turn',
      hook: input.hook_event_name || 'Stop',
      result: 'ambiguous',
      reason: `identity-unresolved: ${why}`,
    });
    process.stderr.write(`[wendkeep] Stop sem identidade segura: ${why}\n`);
    // stderr alone is a black hole here: Codex discards it, which is how an entire session of
    // lost turns produced no signal at all. systemMessage is what the UI actually shows.
    writeHookOutput({ systemMessage: bailMessage(why, input) });
    return;
  }

  // Roteia o turn pela sessão DO PRÓPRIO transcript (registry), não pelo
  // CURRENT_SESSION global — que sessões concorrentes sobrescrevem, fazendo
  // o turn cair na nota de outra conversa. Sem match por transcript NÃO caímos
  // no global (contaminaria nota alheia): pulamos e o backfill recupera depois.
  const sessionRel = entry.session_file;
  if (!sessionRel) {
    recordStopOutcome(vaultBase, {
      sessionId: identity.canonicalConversationId,
      transcriptId: identity.transcriptId,
      turnId: input.turn_id || input.turnId || 'unresolved-turn',
      hook: input.hook_event_name || 'Stop',
      result: 'ambiguous',
      reason: 'session-note-not-registered',
    });
    writeHookOutput({});
    return;
  }

  const checkedSession = assertVaultPathSafe(vaultBase, join(vaultBase, sessionRel), {
    expectedType: 'file', label: 'nota de sessão do Stop',
  });
  if (!checkedSession.exists) {
    recordStopOutcome(vaultBase, {
      sessionId: identity.canonicalConversationId,
      transcriptId: identity.transcriptId,
      turnId: input.turn_id || input.turnId || 'unresolved-turn',
      hook: input.hook_event_name || 'Stop',
      result: 'failed',
      reason: 'session-note-missing-on-disk',
    });
    writeHookOutput({});
    return;
  }
  const sessionPath = checkedSession.target;

  const tx = parseTranscript(identity.transcriptPath || input.transcript_path || input.transcriptPath);
  const requestedTurnId = String(input.turn_id || input.turnId || '');
  const sessionId = identity.canonicalConversationId;
  const finalizing = shouldFinalizeSession();
  const turnIdentity = resolveTurnIdentity(tx, requestedTurnId);
  if (!turnIdentity) {
    if (finalizing) {
      const activeId = String(entry.active_activation_id || '');
      const active = entry.activations?.[activeId] || {};
      stageMemory(vaultBase, {
        sessionId,
        activationId: activeId,
        activationEpoch: Number(active.epoch || entry.activation_epoch || 0),
        turnId: requestedTurnId || 'unresolved-turn',
        turnSequence: Number(entry.last_turn_sequence || 0),
        disposition: 'ambiguous',
        observedAt: new Date(0).toISOString(),
      });
    }
    recordStopOutcome(vaultBase, {
      sessionId,
      transcriptId: identity.transcriptId,
      turnId: requestedTurnId || 'unresolved-turn',
      turnSequence: Number(entry.last_turn_sequence || 0),
      hook: input.hook_event_name || 'Stop',
      result: 'ambiguous',
      reason: 'turn-not-proven-by-transcript',
    });
    const message = 'wendkeep: Stop ambiguous; o turno solicitado não foi provado pelo transcript.';
    process.stderr.write(`[wendkeep] ${message}\n`);
    writeHookOutput({ systemMessage: message });
    return;
  }
  const turnId = turnIdentity.id;
  const parsedTurn = tx.turns.find((turn) => turn.turnId === turnId);
  if (parsedTurn?.status === 'aborted') {
    recordStopOutcome(vaultBase, {
      sessionId,
      transcriptId: identity.transcriptId,
      turnId,
      turnSequence: turnIdentity.order,
      hook: input.hook_event_name || 'Stop',
      result: 'aborted',
      reason: 'transcript-turn-aborted',
    });
    process.stderr.write(`[wendkeep] ${ABORTED_TURN_NOTICE}\n`);
    writeHookOutput({ systemMessage: ABORTED_TURN_NOTICE });
    return;
  }
  const now = finalizing ? new Date() : null;
  const endedAt = finalizing ? formatLocalIso(now) : '';
  const causalStop = finalizing
    ? mutateSessionRegistry(vaultBase, (registry) => {
      const stopTurnSequence = resolveRegisteredTurnSequence(
        registry.sessions?.[sessionId],
        turnId,
        turnIdentity.order,
      );
      const activationId = resolveStopActivation(registry, {
        session_id: sessionId,
        activation_id: input.activation_id || input.activationId || '',
        transcript_id: identity.transcriptId,
        transcript_path: identity.transcriptPath || transcriptPath,
      });
      const cas = applyStopActivation(registry, {
        session_id: sessionId,
        activation_id: activationId,
        turn_id: turnId,
        turn_sequence: stopTurnSequence,
        ended_at: endedAt,
      });
      const activation = cas.registry.sessions[sessionId]?.activations?.[activationId] || null;
      if (cas.canPromoteMemory) {
        registry.version = cas.registry.version;
        registry.sessions = cas.registry.sessions;
        registry.sessions[sessionId] = {
          ...registry.sessions[sessionId],
          session_file: sessionRel,
          last_turn_id: turnId,
          transcript_path: transcriptPath,
          transcript_id: identity.transcriptId,
          provider: identity.provider,
        };
      }
      return {
        activationId,
        activation,
        stopDisposition: cas.stopDisposition,
        canPromoteMemory: cas.canPromoteMemory,
        turnSequence: stopTurnSequence,
      };
    })
    : null;
  const stopTurnSequence = causalStop?.turnSequence ?? turnIdentity.order;
  let memoryHandoff = null;
  let memoryAttempt = null;
  if (finalizing) {
    let projectId = '';
    try {
      const projectPath = join(vaultBase, '.brain', 'PROJECT.json');
      let checkedProject = assertVaultPathSafe(vaultBase, projectPath, {
        expectedType: 'file', label: 'autoridade PROJECT.json do Stop',
      });
      if (checkedProject.exists) {
        checkedProject = assertVaultPathSafe(vaultBase, checkedProject.target, {
          allowMissing: false, expectedType: 'file', label: 'autoridade PROJECT.json do Stop',
        });
        projectId = JSON.parse(readFileSync(checkedProject.target, 'utf8')).projectId || '';
      }
    } catch (error) {
      if (error?.code === 'VAULT_PATH_UNSAFE') throw error;
      /* the staging validator exposes ordinary missing/invalid PROJECT below */
    }
    const finalSummary = sessionFinalSummary(tx);
    const memoryEvidence = collectLifecycleEvidence(vaultBase, {
      changeSlug: entry.change_slug,
      summary: finalSummary,
      noteRel: sessionRel,
    });
    const sharedHandoff = sharedHandoffFromInput(input, entry);
    memoryHandoff = {
      projectId,
      identity,
      activation: {
        id: causalStop?.activationId || '',
        epoch: Number(causalStop?.activation?.epoch || entry.activation_epoch || 0),
      },
      turn: { id: turnId, sequence: stopTurnSequence },
      noteRel: sessionRel,
      observedAt: turnIdentity.observedAt || new Date(0).toISOString(),
      summary: finalSummary,
      evidence: memoryEvidence,
      ...(sharedHandoff ? { shared: sharedHandoff } : {}),
    };
    memoryAttempt = stageMemory(vaultBase, {
      handoff: memoryHandoff,
      disposition: causalStop?.stopDisposition || 'ambiguous',
    });
  }
  if (shouldAbortStopAfterStaging(causalStop, memoryAttempt)) {
    const disposition = memoryAttempt?.disposition || causalStop?.stopDisposition || 'ambiguous';
    recordStopOutcome(vaultBase, {
      sessionId,
      transcriptId: identity.transcriptId,
      turnId,
      turnSequence: stopTurnSequence,
      hook: input.hook_event_name || 'Stop',
      result: disposition === 'duplicate' && memoryAttempt?.state === 'duplicate'
        ? 'duplicate'
        : 'skipped',
      reason: `staging-${disposition}`,
    });
    if (disposition === 'duplicate' && memoryAttempt?.state === 'duplicate') {
      writeHookOutput({});
      return;
    }
    const message = `wendkeep: Stop ${disposition}; uma activation mais nova foi preservada e a memória não foi promovida.`;
    process.stderr.write(`[wendkeep] ${message}\n`);
    writeHookOutput({ systemMessage: message });
    return;
  }
  const iterationStartedAt = clock();
  const logged = insertIteration(sessionPath, buildIterationBlock(tx, input), turnId, tx, vaultBase);
  recordStopOutcome(vaultBase, {
    sessionId,
    transcriptId: identity.transcriptId,
    turnId,
    turnSequence: stopTurnSequence,
    hook: input.hook_event_name || 'Stop',
    result: logged.result,
    lockStatus: logged.result === 'busy' ? 'busy' : logged.confirmed ? 'acquired' : 'unknown',
    durationMs: Math.max(0, clock() - iterationStartedAt),
    reason: `note-${logged.reason}`,
  });

  try {
    applyLinearLinks(sessionPath, tx, vaultBase, sessionRel);
  } catch (error) {
    process.stderr.write(`[wendkeep] Linear link falhou: ${error.message}\n`);
  }

  try {
    const refreshed = await refreshObservability({
      vaultBase,
      input,
      sessionPath,
      sessionId,
      entry,
      causalStop,
      turnSequence: stopTurnSequence,
      hookStartedAt,
    }, {
      now: clock,
      returnDetails: true,
    });
    const observability = typeof refreshed === 'boolean'
      ? { status: refreshed ? 'published' : 'failed', reason: 'legacy-boolean-result' }
      : (refreshed || { status: 'missing', reason: 'empty-result' });
    recordStopOutcome(vaultBase, {
      sessionId,
      transcriptId: identity.transcriptId,
      turnId,
      turnSequence: stopTurnSequence,
      hook: input.hook_event_name || 'Stop',
      stage: 'observability',
      result: observability.status,
      reason: observability.reason || 'observability-refresh',
    });
  } catch (error) {
    recordStopOutcome(vaultBase, {
      sessionId,
      transcriptId: identity.transcriptId,
      turnId,
      turnSequence: stopTurnSequence,
      hook: input.hook_event_name || 'Stop',
      stage: 'observability',
      result: 'failed',
      reason: 'observability-refresh-threw',
    });
    process.stderr.write(`[wendkeep] Observabilidade falhou: ${error.message}\n`);
  }

  if (!finalizing) {
    writeControl(vaultBase, {
      ...control,
      status: 'active',
      session_file: sessionRel,
      last_session_file: control.last_session_file || sessionRel,
      session_id: sessionId,
      last_logged_turn_id: confirmedLoggedTurnId(control.last_logged_turn_id, turnId, logged),
    });
    upsertSessionRegistry(vaultBase, sessionId, {
      session_file: sessionRel,
      status: 'active',
      // started_at omitido de propósito: o merge preserva o da própria entry
      // (definido no SessionStart). Usar control.started_at contaminava com o
      // started_at de sessões concorrentes que sobrescrevem o ponteiro global.
      ended_at: '',
      last_turn_id: confirmedLoggedTurnId(control.last_logged_turn_id, turnId, logged),
      transcript_path: transcriptPath,
      transcript_id: identity.transcriptId,
      provider: identity.provider,
    });
    pingObsidianVault(input.obsidian_api_key);
    writeHookOutput({});
    return;
  }

  const created = mergeCreatedNotes(
    createLinkedNotes(vaultBase, formatDate(now), sessionRel, tx),
    findLinkedDerivedNotes(vaultBase, sessionRel),
  );
  // Link durável sessão↔change: uma seção "Mudanças" ANTES de `## Encerramento`. O append antigo
  // (após o Encerramento) era apagado a cada reopen por stripClosingSection, perdendo a aresta do
  // grafo quando a change fechava antes do turno seguinte. Aqui sobrevive ao reopen e acumula toda
  // change que passou pela sessão (upsertListSection deduplica). Fail-quiet: nunca derruba o Stop.
  try {
    const chgLink = entry.change_slug
      ? `Change ativa: [[${getLocale(vaultBase).folders.changes}/${entry.change_slug}/proposta]]`
      : activeChangeLink(vaultBase);
    const wl = (chgLink.match(/\[\[[^\]]+\]\]/) || [])[0];
    if (wl) {
      mutateSessionNote(sessionPath, (cur) => (
        upsertListSection(ensureSection(cur, 'Mudanças', '\n## Encerramento'), 'Mudanças', [`- ${wl}`], null)
      ), { vaultBase });
    }
  } catch { /* nunca derruba o Stop */ }
  const memoryResult = projectStopMemoryAttempt(vaultBase, memoryAttempt);
  if (memoryResult.status === 'legacy') {
    mutateSessionRegistry(vaultBase, (registry) => {
      const current = registry.sessions[sessionId];
      const active = current?.activations?.[current.active_activation_id || ''];
      if (!current
        || current.active_activation_id !== memoryAttempt.activation_id
        || Number(active?.epoch || 0) !== Number(memoryAttempt.activation_epoch || 0)) return null;
      registry.sessions[sessionId] = {
        ...current,
        memory_status: 'legacy',
        memory_activation_id: memoryAttempt.activation_id,
      };
      return null;
    });
  } else {
    recordStopMemoryOutcome(vaultBase, memoryAttempt, memoryResult);
  }

  // A memória compartilhada é um consumidor causal do fechamento. Se o projetor estiver
  // ocupado ou falhar, o outbox é a autoridade de retry e a sessão não pode ser marcada como
  // encerrada: fechar aqui criaria uma sessão `done` sem a publicação que o fechamento promete.
  if (memoryResult.status === 'degraded') {
    upsertSessionRegistry(vaultBase, sessionId, {
      session_file: sessionRel,
      status: 'active',
      ended_at: '',
      last_turn_id: confirmedLoggedTurnId(control.last_logged_turn_id, turnId, logged),
      transcript_path: transcriptPath,
      transcript_id: identity.transcriptId,
      provider: identity.provider,
    });
    writeControl(vaultBase, {
      ...control,
      status: 'active',
      session_file: sessionRel,
      last_session_file: sessionRel,
      session_id: sessionId,
      ended_at: '',
      last_logged_turn_id: confirmedLoggedTurnId(control.last_logged_turn_id, turnId, logged),
    });
    pingObsidianVault(input.obsidian_api_key);
    writeHookOutput({
      systemMessage: 'wendkeep: memória compartilhada degradada; outbox preservado para retry e sessão mantida ativa.',
    });
    return;
  }

  finalizeSessionFile(sessionPath, tx, created, endedAt, vaultBase);

  // Só fecha a activation depois do último consumidor causal (memória compartilhada) ter lido
  // a activation ainda ativa. O registry fechado alimenta a visão CURRENT_SESSION abaixo.
  let registryFinalization = 'ambiguous';
  try {
    registryFinalization = finalizeSessionRegistry(vaultBase, {
      sessionId,
      activationId: causalStop?.activationId || '',
      turnId,
      endedAt,
    });
  } catch (error) {
    process.stderr.write(`[wendkeep] fechamento do registry falhou: ${error.message}\n`);
  }

  const registryClosed = registryFinalization === 'finalized' || registryFinalization === 'duplicate';
  writeControl(vaultBase, {
    status: registryClosed ? 'inactive' : 'active',
    session_file: registryClosed ? '' : sessionRel,
    last_session_file: sessionRel,
    started_at: control.started_at,
    ended_at: registryClosed ? endedAt : '',
    session_id: sessionId,
    last_logged_turn_id: confirmedLoggedTurnId(control.last_logged_turn_id, turnId, logged),
  });

  // Reconstrói índice (camada fria) + digest (camada quente) ao finalizar. Nunca derruba o Stop.
  try {
    const rows = buildBrainIndex(vaultBase);
    buildBrainDigest(vaultBase, rows);
  } catch (error) {
    process.stderr.write(`[wendkeep] brain index/digest falhou: ${error.message}\n`);
  }

  // GC das sentinelas dos hooks de lifecycle (>7 dias) — fail-quiet, nunca derruba o Stop.
  try { pruneChangeSentinels(vaultBase); } catch { /* bônus */ }

  pingObsidianVault(input.obsidian_api_key);
  writeHookOutput(memoryResult.status === 'degraded'
    ? { systemMessage: `wendkeep: sessão salva; memória compartilhada degradada (${memoryResult.error}). Outbox preservada para replay.` }
    : {});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`[wendkeep] Stop falhou: ${error.message}\n`);
    // Same reasoning as the identity bail: stderr is discarded by Codex. Exit stays 0 —
    // a non-zero Stop hook blocks the turn (openai/codex#21921), and trading a lost turn
    // for a stuck session is a worse deal.
    writeHookOutput({ systemMessage: bailMessage(error.message) });
  }
}
