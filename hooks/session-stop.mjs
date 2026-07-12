#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { request } from 'http';
import { pathToFileURL } from 'url';
import { createLinkedNotes } from './linked-notes.mjs';
import { addUsage, costBreakdown, emptyTokenUsage, normalizeClaudeUsage, normalizeCodexUsage, priceForModel } from './token-usage.mjs';
import { buildBrainDigest, buildBrainIndex } from './brain-core.mjs';
import { activeChangeLink, pruneChangeSentinels } from './change-core.mjs';
import { getLocale } from './locale.mjs';
import { updateSessionObservability } from './session-observability.mjs';
import { resolveSessionEntry } from './session-identity.mjs';
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
} from './obsidian-common.mjs';

function extractContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => item?.text || item?.input_text || item?.output_text || '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

// Tags injetadas pelo harness (não são fala humana): notificações de task,
// reminders do sistema, stdout de comando local, wrappers de slash-command e
// contexto da IDE. Nunca devem virar título/Pedido/Usuário de iteração no Vault.
const SYNTHETIC_EVENT_TAG = /^<\/?(?:task-notification|system-reminder|local-command-stdout|local-command-stderr|command-message|command-name|command-args|user-prompt-submit-hook|ide_selection|ide_opened_file|environment_context)\b/i;

function shouldIgnoreUserText(text) {
  const trimmed = String(text || '').trim();
  return SYNTHETIC_EVENT_TAG.test(trimmed)
    || /^# AGENTS\.md instructions/.test(trimmed)
    || trimmed.startsWith('<permissions instructions>')
    || trimmed.includes('You are Codex, a coding agent')
    || trimmed.startsWith('## Memory')
    // Harness utility meta-prompts (title generation, classifiers) — not real user turns; they
    // were leaking into note titles/summaries on import.
    || /^Generate a concise( UI)? title/i.test(trimmed)
    || /^You are a helpful assistant\. You will be presented with a user prompt/i.test(trimmed);
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

function addConversation(turn, role, value) {
  if (!turn) return;
  const text = redactSecrets(String(value || '').trim());
  if (!text) return;
  const exists = turn.conversation.some((item) => item.role === role && item.text === text);
  if (!exists) turn.conversation.push({ role, text });
}

function extractPaths(text) {
  const paths = [];
  const addPath = (value) => {
    const path = normalizeExtractedPath(value);
    if (!shouldIgnoreExtractedPath(path) && !paths.includes(path)) paths.push(path);
  };

  const windowsRegex = /[A-Za-z]:[\\/]+[^"'`\r\n{}()[\],]+\.[A-Za-z0-9]+(?::\d+)?/g;
  let match;
  const source = String(text || '');
  while ((match = windowsRegex.exec(source)) !== null) {
    addPath(match[0]);
  }

  const masked = source.replace(windowsRegex, ' ');
  const regex = /(?:^|[\s"'`(])((?:\/(?:home|mnt)\/|\.{1,2}\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./@+:-]+\.[A-Za-z0-9]+(?::\d+)?)/g;
  while ((match = regex.exec(masked)) !== null) {
    addPath(match[1]);
  }
  return paths.slice(0, 20);
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

function extractPatchFiles(text) {
  const files = [];
  const regex = /^\*\*\* (?:Add|Update|Delete) File:\s+(.+)$/gm;
  let match;
  while ((match = regex.exec(text || '')) !== null) addUnique(files, match[1]);
  return files;
}

function parseToolArguments(args) {
  if (!args) return {};
  if (typeof args === 'object') return args;
  try {
    return JSON.parse(args);
  } catch {
    return { raw: String(args) };
  }
}

function toolArgumentText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(toolArgumentText).filter(Boolean).join('\n');
  if (typeof value === 'object') return Object.values(value).map(toolArgumentText).filter(Boolean).join('\n');
  return String(value);
}

export function parseCodexTranscript(transcriptPath) {
  const result = {
    provider: 'codex',
    sessionId: '',
    model: '',
    latestTurnId: '',
    latestUserPrompt: '',
    latestAssistantMessage: '',
    userPrompts: [],
    assistantMessages: [],
    tools: [],
    consultedFiles: [],
    changedFiles: [],
    turns: [],
    rawTextForDetection: '',
  };

  if (!transcriptPath || !existsSync(transcriptPath)) return result;

  const eventUserPrompts = [];
  let currentTurn = null;
  const ensureTurn = (turnId = '', timestamp = '') => {
    const normalized = turnId || currentTurn?.turnId || `turn-${result.turns.length + 1}`;
    const existing = result.turns.find((turn) => turn.turnId === normalized);
    if (existing) {
      currentTurn = existing;
      return existing;
    }
    currentTurn = createTurn(normalized, timestamp);
    result.turns.push(currentTurn);
    return currentTurn;
  };

  const lines = readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }

    if (event.type === 'session_meta') {
      result.sessionId = event.payload?.id || result.sessionId;
      result.model = event.payload?.model || event.payload?.model_provider || result.model;
      continue;
    }

    if (event.type === 'event_msg' && event.payload?.type === 'task_started') {
      result.latestTurnId = event.payload.turn_id || result.latestTurnId;
      ensureTurn(result.latestTurnId, event.timestamp);
      continue;
    }

    if (event.type === 'turn_context') {
      result.latestTurnId = event.payload?.turn_id || result.latestTurnId;
      result.model = event.payload?.model || result.model;
      ensureTurn(result.latestTurnId, event.timestamp);
      continue;
    }

    if (event.type === 'event_msg' && event.payload?.type === 'user_message') {
      const text = event.payload.message || '';
      if (text && !shouldIgnoreUserText(text)) {
        const turn = ensureTurn(event.payload.turn_id || result.latestTurnId, event.timestamp);
        addUnique(eventUserPrompts, text);
        addUnique(result.userPrompts, text);
        addUnique(turn.userPrompts, text);
        addConversation(turn, 'Usuário', text);
      }
      continue;
    }

    if (event.type === 'event_msg' && event.payload?.type === 'agent_message') {
      const text = event.payload.message || event.payload.text || '';
      if (text) {
        const turn = ensureTurn(event.payload.turn_id || result.latestTurnId, event.timestamp);
        addUnique(result.assistantMessages, text);
        addUnique(turn.assistantMessages, text);
        addConversation(turn, 'Assistente', text);
      }
      continue;
    }

    if (event.type === 'event_msg' && event.payload?.type === 'token_count') {
      const raw = event.payload?.info?.last_token_usage;
      if (raw) {
        const turn = currentTurn || ensureTurn(result.latestTurnId, event.timestamp);
        addUsage(turn.usage, normalizeCodexUsage(raw));
        if (event.payload?.info?.model) turn.model = event.payload.info.model;
      }
      continue;
    }

    if (event.type !== 'response_item') continue;
    const payload = event.payload || {};

    if (payload.type === 'message') {
      const text = extractContentText(payload.content);
      if (!text) continue;
      const turn = ensureTurn(payload.turn_id || event.turn_id || result.latestTurnId, event.timestamp);
      if (payload.role === 'user' && !shouldIgnoreUserText(text)) {
        addUnique(result.userPrompts, text);
        addUnique(turn.userPrompts, text);
        addConversation(turn, 'Usuário', text);
      }
      if (payload.role === 'assistant') {
        addUnique(result.assistantMessages, text);
        addUnique(turn.assistantMessages, text);
        addConversation(turn, 'Assistente', text);
      }
      continue;
    }

    if (payload.type === 'function_call') {
      addUnique(result.tools, payload.name || 'function_call');
      const turn = ensureTurn(payload.turn_id || event.turn_id || result.latestTurnId, event.timestamp);
      addUnique(turn.tools, payload.name || 'function_call');
      const parsed = parseToolArguments(payload.arguments);
      const combined = typeof parsed.raw === 'string'
        ? parsed.raw
        : toolArgumentText(parsed);

      for (const path of extractPaths(combined)) {
        addUnique(result.consultedFiles, path);
        addUnique(turn.consultedFiles, path);
      }
      for (const path of extractPatchFiles(combined)) {
        addUnique(result.changedFiles, path);
        addUnique(turn.changedFiles, path);
      }

      if (/apply_patch|edit|write|create/i.test(payload.name || '')) {
        for (const path of extractPaths(combined)) {
          addUnique(result.changedFiles, path);
          addUnique(turn.changedFiles, path);
        }
      }
    }

    if (payload.type === 'tool_search_call') {
      const turn = ensureTurn(payload.turn_id || event.turn_id || result.latestTurnId, event.timestamp);
      addUnique(result.tools, 'tool_search');
      addUnique(turn.tools, 'tool_search');
    }
    if (payload.type === 'web_search_call') {
      const turn = ensureTurn(payload.turn_id || event.turn_id || result.latestTurnId, event.timestamp);
      addUnique(result.tools, 'web_search');
      addUnique(turn.tools, 'web_search');
    }
  }

  for (const prompt of eventUserPrompts) addUnique(result.userPrompts, prompt);
  const latestTurn = result.turns.find((turn) => turn.turnId === result.latestTurnId)
    || result.turns.at(-1);
  result.latestUserPrompt = latestTurn?.userPrompts.at(-1)
    || eventUserPrompts.at(-1)
    || result.userPrompts.at(-1)
    || '';
  result.latestAssistantMessage = latestTurn?.assistantMessages.at(-1)
    || result.assistantMessages.at(-1)
    || '';
  result.rawTextForDetection = redactSecrets([
    ...result.userPrompts,
    ...result.assistantMessages,
  ].join('\n\n'));

  return result;
}

// Texto humano de uma mensagem de usuário do Claude Code: mantém só blocos
// `text`, descartando tool_result e contexto injetado (system-reminder etc.).
function claudeUserText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (typeof block === 'string' ? block : (block?.type === 'text' ? block.text || '' : '')))
    .map((text) => String(text || '').trim())
    .filter((text) => text && !text.startsWith('<'))
    .join('\n')
    .trim();
}

// Parser do transcript do Claude Code. Schema por linha:
// { type:'user'|'assistant', message:{ role, content:[{type:'text'|'thinking'|'tool_use'|'tool_result',...}] } }.
// Diferente do Codex (sem `payload`), por isso precisa de parser próprio.
export function parseClaudeTranscript(transcriptPath) {
  const result = {
    provider: 'claude',
    sessionId: '',
    model: '',
    latestTurnId: '',
    latestUserPrompt: '',
    latestAssistantMessage: '',
    userPrompts: [],
    assistantMessages: [],
    tools: [],
    consultedFiles: [],
    changedFiles: [],
    turns: [],
    rawTextForDetection: '',
  };

  if (!transcriptPath || !existsSync(transcriptPath)) return result;

  let currentTurn = null;
  const ensureTurn = (turnId = '', timestamp = '') => {
    const normalized = turnId || currentTurn?.turnId || `turn-${result.turns.length + 1}`;
    const existing = result.turns.find((turn) => turn.turnId === normalized);
    if (existing) {
      currentTurn = existing;
      return existing;
    }
    currentTurn = createTurn(normalized, timestamp);
    result.turns.push(currentTurn);
    return currentTurn;
  };

  const recordToolFiles = (turn, name, input) => {
    const text = toolArgumentText(input);
    for (const path of extractPaths(text)) {
      addUnique(result.consultedFiles, path);
      addUnique(turn.consultedFiles, path);
    }
    for (const path of extractPatchFiles(text)) {
      addUnique(result.changedFiles, path);
      addUnique(turn.changedFiles, path);
    }
    if (/edit|write|create|apply_patch|notebook/i.test(name)) {
      for (const path of extractPaths(text)) {
        addUnique(result.changedFiles, path);
        addUnique(turn.changedFiles, path);
      }
    }
  };

  const lines = readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.isSidechain || event.isMeta) continue;
    if (event.sessionId && !result.sessionId) result.sessionId = event.sessionId;

    if (event.type === 'user') {
      const text = claudeUserText(event.message?.content);
      if (!text || shouldIgnoreUserText(text)) continue;
      const turn = ensureTurn(event.uuid || event.promptId || event.timestamp || '', event.timestamp || '');
      result.latestTurnId = turn.turnId;
      addUnique(result.userPrompts, text);
      addUnique(turn.userPrompts, text);
      addConversation(turn, 'Usuário', text);
      continue;
    }

    if (event.type === 'assistant') {
      const turn = currentTurn || ensureTurn(event.uuid || event.timestamp || '', event.timestamp || '');
      result.model = event.message?.model || result.model;
      if (event.message?.model) turn.model = event.message.model;
      if (event.message?.usage) addUsage(turn.usage, normalizeClaudeUsage(event.message.usage));
      const content = Array.isArray(event.message?.content) ? event.message.content : [];
      for (const block of content) {
        if (!block) continue;
        if (block.type === 'text' && block.text && block.text.trim()) {
          addUnique(result.assistantMessages, block.text);
          addUnique(turn.assistantMessages, block.text);
          addConversation(turn, 'Assistente', block.text);
        } else if (block.type === 'tool_use') {
          const name = block.name || 'tool_use';
          addUnique(result.tools, name);
          addUnique(turn.tools, name);
          recordToolFiles(turn, name, block.input);
        }
      }
      continue;
    }
  }

  const latestTurn = result.turns.find((turn) => turn.turnId === result.latestTurnId)
    || result.turns.at(-1);
  result.latestUserPrompt = latestTurn?.userPrompts.at(-1) || result.userPrompts.at(-1) || '';
  result.latestAssistantMessage = latestTurn?.assistantMessages.at(-1) || result.assistantMessages.at(-1) || '';
  result.rawTextForDetection = redactSecrets([
    ...result.userPrompts,
    ...result.assistantMessages,
  ].join('\n\n'));

  return result;
}

function looksLikeCodexEvent(event) {
  return event.payload !== undefined
    || event.type === 'session_meta'
    || event.type === 'response_item'
    || event.type === 'turn_context'
    || event.type === 'event_msg';
}

function looksLikeClaudeEvent(event) {
  return (event.type === 'user' || event.type === 'assistant') && event.message !== undefined;
}

// Despacha para o parser certo conforme o schema do transcript (Codex x Claude),
// já que o mesmo hook Stop atende os dois agentes.
export function parseTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return parseCodexTranscript(transcriptPath);
  const lines = readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (looksLikeCodexEvent(event)) return parseCodexTranscript(transcriptPath);
    if (looksLikeClaudeEvent(event)) return parseClaudeTranscript(transcriptPath);
  }
  return parseCodexTranscript(transcriptPath);
}

function compactText(text, max = 600) {
  const clean = redactSecrets(String(text || ''))
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return truncate(clean || 'Não capturado automaticamente.', max);
}

function selectTurn(tx, turnId) {
  return tx.turns.find((turn) => turn.turnId === turnId)
    || tx.turns.find((turn) => turn.turnId === tx.latestTurnId)
    || tx.turns.at(-1)
    || createTurn(turnId || tx.latestTurnId || 'turno');
}

function formatConversation(turn) {
  const entries = (turn.conversation || [])
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

export function buildIterationBlock(tx, input) {
  const turnId = input.turn_id || tx.latestTurnId || `${Date.now()}`;
  const turn = selectTurn(tx, turnId);
  const preferredDate = input.now || turn.timestamp || '';
  const parsedDate = preferredDate ? new Date(preferredDate) : new Date();
  const now = Number.isFinite(parsedDate.getTime()) ? parsedDate : new Date();
  const promptText = turn.userPrompts.at(-1) || tx.latestUserPrompt || '';
  const latestAssistant = turn.assistantMessages.at(-1) || tx.latestAssistantMessage || '';
  const heading = truncate(promptText.replace(/[\r\n#]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Iteração', 80);
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

**Estado ao final do turno:** ${compactText(latestAssistant || 'Checkpoint registrado automaticamente ao final do turno.', 900)}
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

export function insertIteration(sessionPath, block, turnId, tx) {
  const original = readFileSync(sessionPath, 'utf-8');
  // Self-heal: migrate any legacy `codex-turn` markers to the neutral name on this write.
  let content = normalizeTurnMarkers(original);
  if (hasTurnMarker(content, turnId)) {
    // Turno já registrado: ainda assim repara órfãos e seções dedicadas.
    const repaired = applyDedicatedSections(relocateOrphanIterations(content), tx);
    if (repaired !== original) writeFileSync(sessionPath, repaired, 'utf-8');
    return false;
  }
  content = relocateOrphanIterations(content);
  content = insertIntoIteracoes(content, block);
  content = applyDedicatedSections(content, tx);
  if (content !== original) writeFileSync(sessionPath, content, 'utf-8');
  return true;
}

function shouldFinalizeSession() {
  // Finaliza em todo Stop por padrão; escape hatch negativo p/ debug/teste.
  return process.env.OBSIDIAN_NO_AUTO_FINALIZE !== '1';
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

  for (const [key, folder] of Object.entries(folders)) {
    const dir = join(vaultBase, folder);
    for (const fileName of listMarkdownFiles(dir)) {
      const absPath = join(dir, fileName);
      try {
        const content = readFileSync(absPath, 'utf-8');
        if (noteReferencesSession(content, sessionRel)) {
          linked[key].push(toVaultRelative(vaultBase, absPath));
        }
      } catch {
        // Ignore unreadable notes; the hook must not block session shutdown.
      }
    }
  }

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

export function finalizeSessionFile(sessionPath, tx, created, endedAt) {
  const pending = extractPending(tx.rawTextForDetection);
  const links = (items) => items.length ? items.map((rel) => `  - ${wikilinkFromRel(rel)}`).join('\n') : '  - Nenhuma';
  const summary = tx.latestAssistantMessage
    ? truncate(tx.latestAssistantMessage, 500)
    : `Sessão encerrada com ${tx.userPrompts.length} prompts e ${tx.tools.length} ferramentas registradas.`;

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

  const content = readFileSync(sessionPath, 'utf-8');
  const finalized = replaceClosingSection(
    replacePendingSection(updateFrontmatter(content, endedAt), pending),
    closing,
  );
  writeFileSync(sessionPath, finalized, 'utf-8');
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

  let content = readFileSync(sessionPath, 'utf-8');
  content = ensureSection(content, 'Issues Linear', '\n## Encerramento');
  content = upsertListSection(content, 'Issues Linear', lines, null);
  writeFileSync(sessionPath, content, 'utf-8');
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

function main() {
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
    process.stderr.write(`[wendkeep] Stop sem identidade segura: ${identity.diagnostics?.join('; ') || 'sessão não registrada'}\n`);
    writeHookOutput({});
    return;
  }

  // Roteia o turn pela sessão DO PRÓPRIO transcript (registry), não pelo
  // CURRENT_SESSION global — que sessões concorrentes sobrescrevem, fazendo
  // o turn cair na nota de outra conversa. Sem match por transcript NÃO caímos
  // no global (contaminaria nota alheia): pulamos e o backfill recupera depois.
  const sessionRel = entry.session_file;
  if (!sessionRel) {
    writeHookOutput({});
    return;
  }

  const sessionPath = join(vaultBase, sessionRel);
  if (!existsSync(sessionPath)) {
    writeHookOutput({});
    return;
  }

  const tx = parseTranscript(input.transcript_path || input.transcriptPath);
  const turnId = input.turn_id || tx.latestTurnId || String(Date.now());
  const sessionId = identity.canonicalConversationId;
  const logged = insertIteration(sessionPath, buildIterationBlock(tx, input), turnId, tx);

  try {
    applyLinearLinks(sessionPath, tx, vaultBase, sessionRel);
  } catch (error) {
    process.stderr.write(`[wendkeep] Linear link falhou: ${error.message}\n`);
  }

  try {
    updateSessionObservability({ sessionPath, transcriptPath, caller: 'stop', canonicalConversationId: sessionId });
  } catch (error) {
    process.stderr.write(`[wendkeep] Token usage falhou: ${error.message}\n`);
  }

  if (!shouldFinalizeSession()) {
    writeControl(vaultBase, {
      ...control,
      status: 'active',
      session_file: sessionRel,
      last_session_file: control.last_session_file || sessionRel,
      session_id: sessionId,
      last_logged_turn_id: logged ? turnId : control.last_logged_turn_id,
    });
    upsertSessionRegistry(vaultBase, sessionId, {
      session_file: sessionRel,
      status: 'active',
      // started_at omitido de propósito: o merge preserva o da própria entry
      // (definido no SessionStart). Usar control.started_at contaminava com o
      // started_at de sessões concorrentes que sobrescrevem o ponteiro global.
      ended_at: '',
      last_turn_id: logged ? turnId : control.last_logged_turn_id,
      transcript_path: transcriptPath,
      transcript_id: identity.transcriptId,
      provider: identity.provider,
    });
    pingObsidianVault(input.obsidian_api_key);
    writeHookOutput({});
    return;
  }

  const now = new Date();
  const endedAt = formatLocalIso(now);
  const created = mergeCreatedNotes(
    createLinkedNotes(vaultBase, formatDate(now), sessionRel, tx),
    findLinkedDerivedNotes(vaultBase, sessionRel),
  );
  finalizeSessionFile(sessionPath, tx, created, endedAt);
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
      let cur = readFileSync(sessionPath, 'utf8');
      cur = ensureSection(cur, 'Mudanças', '\n## Encerramento');
      cur = upsertListSection(cur, 'Mudanças', [`- ${wl}`], null);
      writeFileSync(sessionPath, cur, 'utf8');
    }
  } catch { /* nunca derruba o Stop */ }
  writeControl(vaultBase, {
    status: 'inactive',
    session_file: '',
    last_session_file: sessionRel,
    started_at: control.started_at,
    ended_at: endedAt,
    session_id: sessionId,
    last_logged_turn_id: turnId,
  });
  upsertSessionRegistry(vaultBase, sessionId, {
    session_file: sessionRel,
    status: 'done',
    // started_at omitido: preserva o da própria entry (ver branch acima).
    ended_at: endedAt,
    last_turn_id: turnId,
    transcript_path: transcriptPath,
    transcript_id: identity.transcriptId,
    provider: identity.provider,
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
  writeHookOutput({});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[wendkeep] Stop falhou: ${error.message}\n`);
    writeHookOutput({});
  }
}
