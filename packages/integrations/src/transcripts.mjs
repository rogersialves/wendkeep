import {
  isBootstrapPrompt,
  redactSecrets,
  sanitizeAssistantMessage,
} from './prompt-content.mjs';
import {
  addUsage,
  emptyTokenUsage,
  normalizeClaudeUsage,
  normalizeCodexUsage,
} from './transcript-usage.mjs';

function extractContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => item?.text || item?.input_text || item?.output_text || '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

const SYNTHETIC_EVENT_TAG = /^<\/?(?:task-notification|system-reminder|local-command-stdout|local-command-stderr|command-message|command-name|command-args|user-prompt-submit-hook|ide_selection|ide_opened_file|environment_context)\b/i;

function shouldIgnoreUserText(text) {
  const trimmed = String(text || '').trim();
  return SYNTHETIC_EVENT_TAG.test(trimmed)
    || isBootstrapPrompt(trimmed)
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

function createResult(provider) {
  return {
    provider,
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
}

function addConversation(turn, role, value) {
  if (!turn) return;
  const text = redactSecrets(String(value || '').trim());
  if (!text) return;
  if (!turn.conversation.some((item) => item.role === role && item.text === text)) {
    turn.conversation.push({ role, text });
  }
}

function addAssistantMessage(result, turn, value) {
  const text = sanitizeAssistantMessage(value);
  if (!text) return;
  addUnique(result.assistantMessages, text);
  addUnique(turn.assistantMessages, text);
  addConversation(turn, 'Assistente', text);
}

function normalizeRoot(value) {
  return String(value || '').replace(/\\+/g, '/').replace(/\/+$/, '');
}

function pathContext(options = {}) {
  const repoRoot = normalizeRoot(options.repoRoot);
  const vaultRoot = normalizeRoot(options.vaultRoot).toLowerCase();
  const repoLower = repoRoot.toLowerCase();
  const vaultRel = vaultRoot && repoLower && vaultRoot.startsWith(`${repoLower}/`)
    ? vaultRoot.slice(repoLower.length + 1)
    : '';
  return { repoRoot, repoLower, vaultRoot, vaultRel };
}

function normalizeExtractedPath(value, context) {
  const cleaned = String(value || '')
    .replace(/\\+/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/[:.,;)}\]]+$/, '');
  if (context.repoRoot && cleaned.toLowerCase().startsWith(`${context.repoLower}/`)) {
    return cleaned.slice(context.repoRoot.length + 1);
  }
  return cleaned;
}

function shouldIgnoreExtractedPath(path, context) {
  if (!path) return true;
  const lower = path.toLowerCase();
  if (context.vaultRoot && lower.startsWith(`${context.vaultRoot}/`)) return true;
  if (context.vaultRel && lower.startsWith(`${context.vaultRel}/`)) return true;
  if (lower.includes('/.codex/sessions/')) return true;
  if (lower.includes('/.claude/projects/')) return true;
  if (path.startsWith('../') || path.includes('/../')) return true;
  if (/(?:^|\/)(?:CURRENT_SESSION\.md|SESSION_REGISTRY\.json)$/i.test(path)) return true;
  if (/^[A-Za-z]:\/[A-Za-z]:\//.test(path)) return true;
  if (/^Alves\/\.codex\//i.test(path)) return true;
  if (/\/\.[A-Za-z0-9]+(?::\d+)?$/.test(path)) return true;
  return false;
}

function extractPaths(text, context) {
  const paths = [];
  const addPath = (value) => {
    const path = normalizeExtractedPath(value, context);
    if (!shouldIgnoreExtractedPath(path, context) && !paths.includes(path)) paths.push(path);
  };
  const windowsRegex = /[A-Za-z]:[\\/]+[^"'`\r\n{}()[\],]+\.[A-Za-z0-9]+(?::\d+)?/g;
  const source = String(text || '');
  let match;
  while ((match = windowsRegex.exec(source)) !== null) addPath(match[0]);
  const masked = source.replace(windowsRegex, ' ');
  const regex = /(?:^|[\s"'`(])((?:\/(?:home|mnt)\/|\.{1,2}\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./@+:-]+\.[A-Za-z0-9]+(?::\d+)?)/g;
  while ((match = regex.exec(masked)) !== null) addPath(match[1]);
  return paths.slice(0, 20);
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
  try { return JSON.parse(args); } catch { return { raw: String(args) }; }
}

function toolArgumentText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(toolArgumentText).filter(Boolean).join('\n');
  if (typeof value === 'object') return Object.values(value).map(toolArgumentText).filter(Boolean).join('\n');
  return String(value);
}

function jsonLines(content) {
  return String(content || '').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

export function completedCodexTurnIdsContent(content = '') {
  const completed = new Set();
  for (const event of jsonLines(content)) {
    if (event.type !== 'event_msg' || event.payload?.type !== 'task_complete') continue;
    const turnId = String(event.payload?.turn_id || event.turn_id || '').trim();
    if (turnId) completed.add(turnId);
  }
  return completed;
}

export function parseCodexTranscriptContent(content, options = {}) {
  const result = createResult('codex');
  const eventUserPrompts = [];
  const paths = pathContext(options);
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

  for (const event of jsonLines(content)) {
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
        addAssistantMessage(result, turn, text);
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
        addAssistantMessage(result, turn, text);
      }
      continue;
    }
    if (payload.type === 'function_call') {
      const name = payload.name || 'function_call';
      const turn = ensureTurn(payload.turn_id || event.turn_id || result.latestTurnId, event.timestamp);
      addUnique(result.tools, name);
      addUnique(turn.tools, name);
      const parsed = parseToolArguments(payload.arguments);
      const combined = typeof parsed.raw === 'string' ? parsed.raw : toolArgumentText(parsed);
      for (const path of extractPaths(combined, paths)) {
        addUnique(result.consultedFiles, path);
        addUnique(turn.consultedFiles, path);
      }
      for (const path of extractPatchFiles(combined)) {
        addUnique(result.changedFiles, path);
        addUnique(turn.changedFiles, path);
      }
      if (/apply_patch|edit|write|create/i.test(name)) {
        for (const path of extractPaths(combined, paths)) {
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

export function parseClaudeTranscriptContent(content, options = {}) {
  const result = createResult('claude');
  const paths = pathContext(options);
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
    for (const path of extractPaths(text, paths)) {
      addUnique(result.consultedFiles, path);
      addUnique(turn.consultedFiles, path);
    }
    for (const path of extractPatchFiles(text)) {
      addUnique(result.changedFiles, path);
      addUnique(turn.changedFiles, path);
    }
    if (/edit|write|create|apply_patch|notebook/i.test(name)) {
      for (const path of extractPaths(text, paths)) {
        addUnique(result.changedFiles, path);
        addUnique(turn.changedFiles, path);
      }
    }
  };

  for (const event of jsonLines(content)) {
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
      const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
      for (const block of blocks) {
        if (block?.type === 'text' && block.text && block.text.trim()) {
          addAssistantMessage(result, turn, block.text);
        } else if (block?.type === 'tool_use') {
          const name = block.name || 'tool_use';
          addUnique(result.tools, name);
          addUnique(turn.tools, name);
          recordToolFiles(turn, name, block.input);
        }
      }
    }
  }

  const latestTurn = result.turns.find((turn) => turn.turnId === result.latestTurnId)
    || result.turns.at(-1);
  result.latestUserPrompt = latestTurn?.userPrompts.at(-1) || result.userPrompts.at(-1) || '';
  result.latestAssistantMessage = latestTurn?.assistantMessages.at(-1)
    || result.assistantMessages.at(-1)
    || '';
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

export function parseTranscriptContent(content, options = {}) {
  for (const event of jsonLines(content)) {
    if (looksLikeCodexEvent(event)) return parseCodexTranscriptContent(content, options);
    if (looksLikeClaudeEvent(event)) return parseClaudeTranscriptContent(content, options);
  }
  return parseCodexTranscriptContent(content, options);
}

export function resolveTurnIdentity(transcript, requestedTurnId = '') {
  const turns = Array.isArray(transcript?.turns) ? transcript.turns : [];
  const requested = String(requestedTurnId || '');
  let index = requested
    ? turns.findIndex((turn) => String(turn?.turnId || '') === requested)
    : -1;
  if (requested && index < 0) return null;
  if (index < 0 && transcript?.latestTurnId) {
    index = turns.findIndex((turn) => String(turn?.turnId || '') === String(transcript.latestTurnId));
  }
  if (index < 0) index = turns.length - 1;
  const turn = turns[index];
  if (!turn?.turnId) return null;
  return {
    id: String(turn.turnId),
    order: index + 1,
    observedAt: String(turn.timestamp || ''),
  };
}
