#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  getVaultBase,
  readControl,
  truncate,
} from './obsidian-common.mjs';

// Preços API por milhão de tokens. cachedInput = cache read.
// Cache write: 5m = 1.25x input, 1h = 2x input (multiplicadores em calculateCost).
// Tabela editável em pricing.json (mesma pasta); esta é o fallback embutido
// usado quando o JSON some ou fica inválido — o hook nunca deve quebrar por isso.
const DEFAULT_PRICE_REFERENCE = {
  'gpt-5.6-sol': { label: 'GPT-5.6 Sol API', provider: 'openai', input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.6-terra': { label: 'GPT-5.6 Terra API', provider: 'openai', input: 2.5, cachedInput: 0.25, output: 15 },
  'gpt-5.6-luna': { label: 'GPT-5.6 Luna API', provider: 'openai', input: 1, cachedInput: 0.1, output: 6 },
  'gpt-5.5': {
    label: 'GPT-5.5 API',
    provider: 'openai',
    input: 5,
    cachedInput: 0.5,
    output: 30,
  },
  'claude-opus-4.7': {
    label: 'Claude Opus 4.7 API',
    provider: 'anthropic',
    input: 5,
    cachedInput: 0.5,
    output: 25,
  },
  'claude-opus-4.8': {
    label: 'Claude Opus 4.8 API',
    provider: 'anthropic',
    input: 5,
    cachedInput: 0.5,
    output: 25,
  },
  'claude-sonnet-4.6': {
    label: 'Claude Sonnet 4.6 API',
    provider: 'anthropic',
    input: 3,
    cachedInput: 0.3,
    output: 15,
  },
  'claude-sonnet-5': {
    label: 'Claude Sonnet 5 API',
    provider: 'anthropic',
    input: 3,
    cachedInput: 0.3,
    output: 15,
  },
  'claude-haiku-4.5': {
    label: 'Claude Haiku 4.5 API',
    provider: 'anthropic',
    input: 1,
    cachedInput: 0.1,
    output: 5,
  },
  'claude-fable-5': {
    label: 'Claude Fable 5 API',
    provider: 'anthropic',
    input: 10,
    cachedInput: 1,
    output: 50,
  },
};

const PRICING_FILE = join(dirname(fileURLToPath(import.meta.url)), 'pricing.json');

// Carrega a tabela de preços do JSON editável; cai no fallback embutido se o
// arquivo sumir, não for JSON válido ou não tiver `models` com entradas.
export function loadPriceReference(file = PRICING_FILE) {
  try {
    const models = JSON.parse(readFileSync(file, 'utf-8'))?.models;
    if (models && typeof models === 'object' && Object.keys(models).length) {
      return models;
    }
  } catch {
    // arquivo ausente/corrompido — usa fallback.
  }
  return DEFAULT_PRICE_REFERENCE;
}

const PRICE_REFERENCE = loadPriceReference();

const MODEL_ALIASES = {
  'gpt-5.6': 'gpt-5.6-sol',
  'gpt-5.6-sol': 'gpt-5.6-sol',
  'gpt-5-6-sol': 'gpt-5.6-sol',
  'openai/gpt-5.6': 'gpt-5.6-sol',
  'openai/gpt-5.6-sol': 'gpt-5.6-sol',
  'gpt-5.6-terra': 'gpt-5.6-terra',
  'gpt-5-6-terra': 'gpt-5.6-terra',
  'openai/gpt-5.6-terra': 'gpt-5.6-terra',
  'gpt-5.6-luna': 'gpt-5.6-luna',
  'gpt-5-6-luna': 'gpt-5.6-luna',
  'openai/gpt-5.6-luna': 'gpt-5.6-luna',
  'gpt-5.5': 'gpt-5.5',
  'gpt-5_5': 'gpt-5.5',
  'openai/gpt-5.5': 'gpt-5.5',
  // Older/adjacent Codex model ids: priced approximately at the gpt-5.5 tier until confirmed
  // (better a close estimate than a silent $0). Codex sessions surface these via session_meta.
  'gpt-5.4': 'gpt-5.5',
  'gpt-5-4': 'gpt-5.5',
  'gpt-5.4-mini': 'gpt-5.5',
  'gpt-5.3-codex': 'gpt-5.5',
  'gpt-5.3': 'gpt-5.5',
  'openai/gpt-5.4': 'gpt-5.5',
  'claude-opus-4.7': 'claude-opus-4.7',
  'claude-opus-4-7': 'claude-opus-4.7',
  'anthropic/claude-opus-4.7': 'claude-opus-4.7',
  'anthropic/claude-opus-4-7': 'claude-opus-4.7',
  'claude-opus-4.8': 'claude-opus-4.8',
  'claude-opus-4-8': 'claude-opus-4.8',
  'anthropic/claude-opus-4.8': 'claude-opus-4.8',
  'anthropic/claude-opus-4-8': 'claude-opus-4.8',
  'claude-sonnet-4.6': 'claude-sonnet-4.6',
  'claude-sonnet-4-6': 'claude-sonnet-4.6',
  'anthropic/claude-sonnet-4.6': 'claude-sonnet-4.6',
  'anthropic/claude-sonnet-4-6': 'claude-sonnet-4.6',
  'claude-sonnet-5': 'claude-sonnet-5',
  'claude-sonnet-5-0': 'claude-sonnet-5',
  'anthropic/claude-sonnet-5': 'claude-sonnet-5',
  'claude-haiku-4.5': 'claude-haiku-4.5',
  'claude-haiku-4-5': 'claude-haiku-4.5',
  'claude-haiku-4-5-20251001': 'claude-haiku-4.5',
  'anthropic/claude-haiku-4.5': 'claude-haiku-4.5',
  'anthropic/claude-haiku-4-5': 'claude-haiku-4.5',
  'claude-fable-5': 'claude-fable-5',
  'claude-fable-5[1m]': 'claude-fable-5',
  'anthropic/claude-fable-5': 'claude-fable-5',
};

const MANAGED_FRONTMATTER_KEYS = new Set([
  'modelo',
  'modelos',
  'provedor_modelo',
  'provedores_modelo',
  'nivel_pensamento',
  'prompts',
  'tool_calls',
  'tools_distinct',
  'tools',
  'chamadas_llm',
  'tokens_input',
  'tokens_cache_write',
  'tokens_cached_input',
  'tokens_output',
  'tokens_reasoning',
  'tokens_total',
  'custo_modelo_label',
  'custo_modelo_usd',
  'custo_por_modelo',
  'usage_por_transcript',
  'subagents_count',
  'subagents_tokens_total',
  'subagents_custo_usd',
  'subagents_tools',
  'subagents_wasted_usd',
  'tokens_total_incl_subagents',
  'custo_total_incl_subagents_usd',
  'observability_schema',
  'custo_por_modelo_json',
  // Legado: chaves antigas removidas ao reprocessar a sessão.
  'custo_estimado_gpt55_usd',
  'custo_estimado_opus47_usd',
  'custo_delta_opus47_usd',
  'usage_report',
]);

// Convenção interna: campos disjuntos.
// input = tokens de entrada NÃO cacheados; cached = cache read; cacheWrite = cache write
// (cacheWrite1h = subparcela 1h, para custo 2x); thinking = tokens de raciocínio
// (Claude: estimado de chars/3.5; Codex: reasoning_output_tokens, já contidos em output).
export function emptyTokenUsage() {
  return {
    input: 0,
    cached: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    output: 0,
    reasoning: 0,
    total: 0,
  };
}

// Formato Codex: cached_input_tokens é SUBCONJUNTO de input_tokens — separa aqui.
export function normalizeCodexUsage(raw = {}) {
  const inputAll = Number(raw.input_tokens || 0);
  const cached = Math.min(Number(raw.cached_input_tokens || 0), inputAll);
  const output = Number(raw.output_tokens || 0);
  return {
    input: inputAll - cached,
    cached,
    cacheWrite: 0,
    cacheWrite1h: 0,
    output,
    reasoning: Number(raw.reasoning_output_tokens || 0),
    total: Number(raw.total_tokens || 0) || inputAll + output,
  };
}

// Formato Claude Code: campos já disjuntos.
export function normalizeClaudeUsage(raw = {}) {
  const input = Number(raw.input_tokens || 0);
  const cached = Number(raw.cache_read_input_tokens || 0);
  const cacheWrite = Number(raw.cache_creation_input_tokens || 0);
  const cacheWrite1h = Number(raw.cache_creation?.ephemeral_1h_input_tokens || 0);
  const output = Number(raw.output_tokens || 0);
  return {
    input,
    cached,
    cacheWrite,
    cacheWrite1h: Math.min(cacheWrite1h, cacheWrite),
    output,
    reasoning: 0,
    total: input + cached + cacheWrite + output,
  };
}

export function addUsage(target, usage) {
  target.input += usage.input;
  target.cached += usage.cached;
  target.cacheWrite += usage.cacheWrite;
  target.cacheWrite1h += usage.cacheWrite1h;
  target.output += usage.output;
  target.reasoning += usage.reasoning;
  target.total += usage.total;
}

function normalizeModelName(model) {
  const clean = String(model || 'unknown').trim() || 'unknown';
  // Strip a trailing context-window tag (e.g. `claude-opus-4-8[1m]`, `claude-fable-5[1m]`) so the
  // 1M variant of ANY model maps to its base price instead of falling through to $0.
  const lower = clean.toLowerCase().replace(/\[[^\]]*\]$/, '');
  if (MODEL_ALIASES[lower]) return MODEL_ALIASES[lower];
  // Fallback: remove sufixo de data (ex.: claude-opus-4-8-20260528) e tenta de novo.
  const noDate = lower.replace(/-\d{8}$/, '');
  return MODEL_ALIASES[noDate] || clean;
}

function normalizeProvider(provider) {
  return String(provider || 'unknown').trim() || 'unknown';
}

function calculateCost(usage, price) {
  const inputCost = (usage.input / 1_000_000) * price.input;
  const cachedCost = (usage.cached / 1_000_000) * price.cachedInput;
  const write1h = usage.cacheWrite1h;
  const write5m = Math.max(usage.cacheWrite - write1h, 0);
  const writeCost = ((write5m * 1.25 + write1h * 2) / 1_000_000) * price.input;
  const outputCost = (usage.output / 1_000_000) * price.output;
  return roundUsd(inputCost + cachedCost + writeCost + outputCost);
}

function roundUsd(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

// Resolve o nome do modelo (com aliases/sufixo de data) para a tabela de preços.
// Devolve null quando o modelo não está tabelado.
export function priceForModel(model) {
  return PRICE_REFERENCE[normalizeModelName(model)] || null;
}

// Custo USD por tipo de uso (mesmos multiplicadores de cache do calculateCost).
// null quando o preço do modelo é desconhecido.
export function costBreakdown(usage, price) {
  if (!price) return null;
  const u = usage || {};
  const write1h = u.cacheWrite1h || 0;
  const write5m = Math.max((u.cacheWrite || 0) - write1h, 0);
  const input = (u.input / 1_000_000) * price.input;
  const cached = (u.cached / 1_000_000) * price.cachedInput;
  const cacheWrite = ((write5m * 1.25 + write1h * 2) / 1_000_000) * price.input;
  const output = (u.output / 1_000_000) * price.output;
  return { input, cached, cacheWrite, output, total: input + cached + cacheWrite + output };
}

function escapeTableCell(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

// Formata inteiros com separador de milhar pt-BR (3656657 -> 3.656.657).
function fmtNum(value) {
  const n = Math.trunc(Number(value) || 0);
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function addUnique(list, value) {
  const clean = String(value || '').trim();
  if (clean && !list.includes(clean)) list.push(clean);
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => item?.text || item?.input_text || item?.output_text || '')
    .filter(Boolean)
    .join('\n');
}

function shouldIgnoreUserText(text) {
  return /^# AGENTS\.md instructions/.test(text)
    || text.startsWith('<environment_context>')
    || text.startsWith('<permissions instructions>')
    || text.startsWith('<system-reminder>')
    || text.startsWith('<local-command-caveat>')
    || text.startsWith('<command-name>')
    || text.startsWith('<ide_')
    || text.startsWith('## Memory')
    || text.includes('You are Codex, a coding agent')
    || /^Generate a concise( UI)? title/i.test(text)
    || /^You are a helpful assistant\. You will be presented with a user prompt/i.test(text);
}

function emptyParseResult(transcriptPath) {
  return {
    transcriptPath,
    sessionId: '',
    provider: 'unknown',
    model: 'unknown',
    pensamento: '',
    userPrompts: [],
    tools: [],
    toolCalls: 0,
    calls: [],
    byModel: new Map(),
    totals: emptyTokenUsage(),
  };
}

function trackByModel(result, provider, model, usage) {
  const key = `${provider}:${model}`;
  if (!result.byModel.has(key)) {
    result.byModel.set(key, { model, provider, calls: 0, usage: emptyTokenUsage() });
  }
  const entry = result.byModel.get(key);
  entry.calls += 1;
  addUsage(entry.usage, usage);
}

function parseCodexLines(lines, result) {
  let currentProvider = 'unknown';
  let currentModel = 'unknown';
  let latestPrompt = '';

  for (const line of lines) {
    const event = parseJsonLine(line);
    if (!event) continue;

    const payload = event.payload || {};

    if (event.type === 'session_meta') {
      result.sessionId = payload.session_id || payload.id || result.sessionId;
      currentProvider = normalizeProvider(payload.model_provider || currentProvider);
      currentModel = normalizeModelName(payload.model || currentModel);
      result.provider = currentProvider;
      result.model = currentModel;
      continue;
    }

    if (event.type === 'turn_context') {
      currentProvider = normalizeProvider(payload.model_provider || currentProvider);
      currentModel = normalizeModelName(payload.model || currentModel);
      result.provider = currentProvider;
      result.model = currentModel;
      const effort = payload.effort || payload.reasoning_effort
        || payload.collaboration_mode?.settings?.reasoning_effort || '';
      if (effort) result.pensamento = String(effort);
      continue;
    }

    if (event.type === 'event_msg' && payload.type === 'user_message') {
      const text = String(payload.message || '').trim();
      if (text && !shouldIgnoreUserText(text)) {
        latestPrompt = text;
        addUnique(result.userPrompts, text);
      }
      continue;
    }

    if (event.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      const text = extractTextContent(payload.content).trim();
      if (text && !shouldIgnoreUserText(text)) {
        latestPrompt = text;
        addUnique(result.userPrompts, text);
      }
      continue;
    }

    if (event.type === 'response_item' && payload.type === 'function_call') {
      result.toolCalls += 1;
      addUnique(result.tools, payload.name || 'function_call');
      continue;
    }

    if (event.type === 'response_item' && payload.type === 'tool_search_call') {
      result.toolCalls += 1;
      addUnique(result.tools, 'tool_search');
      continue;
    }

    if (event.type === 'response_item' && payload.type === 'web_search_call') {
      result.toolCalls += 1;
      addUnique(result.tools, 'web_search');
      continue;
    }

    if (event.type !== 'event_msg' || payload.type !== 'token_count') continue;

    const info = payload.info || {};
    const rawUsage = info.last_token_usage;
    if (!rawUsage) continue;

    const usage = normalizeCodexUsage(rawUsage);
    const model = normalizeModelName(info.model || payload.model || currentModel);
    const provider = normalizeProvider(info.model_provider || payload.model_provider || currentProvider);

    result.calls.push({
      index: result.calls.length + 1,
      model,
      provider,
      usage,
      prompt: truncate(latestPrompt, 110),
    });
    addUsage(result.totals, usage);
    trackByModel(result, provider, model, usage);
  }

  return result;
}

// Transcript Claude Code: uma linha "assistant" por content block, repetindo o MESMO
// requestId/message.id e a MESMA usage — dedupe obrigatório para não multiplicar tokens.
function parseClaudeLines(lines, result) {
  result.provider = 'anthropic';
  const seenUsage = new Set();
  const seenTools = new Set();
  const seenThinking = new Set();
  let thinkingChars = 0;
  const thinkingCharsByModel = new Map();
  let sawThinking = false;
  let latestPrompt = '';

  for (const line of lines) {
    const event = parseJsonLine(line);
    if (!event) continue;

    if (event.sessionId && !result.sessionId) result.sessionId = event.sessionId;

    if (event.type === 'user' && !event.toolUseResult && event.message) {
      const text = extractTextContent(event.message.content).trim();
      if (text && !shouldIgnoreUserText(text)) {
        latestPrompt = text;
        addUnique(result.userPrompts, text);
      }
      continue;
    }

    if (event.type !== 'assistant' || !event.message) continue;

    const msg = event.message;
    const model = normalizeModelName(msg.model);
    if (model === '<synthetic>' || msg.model === '<synthetic>') continue;

    for (const block of msg.content || []) {
      if (block?.type === 'tool_use' && block.id && !seenTools.has(block.id)) {
        seenTools.add(block.id);
        result.toolCalls += 1;
        addUnique(result.tools, block.name || 'tool_use');
      }
      if (block?.type === 'thinking') {
        // Presença = extended thinking ATIVO. A `signature` persiste mesmo quando o Claude
        // Code redige o texto (`thinking: ''`) — é o único sinal confiável do effort.
        sawThinking = true;
        // O texto só sobrevive à redação às vezes; quando sobrevive, estima reasoning tokens.
        if (block.thinking) {
          const thinkKey = `${msg.id || ''}:${block.thinking.slice(0, 60)}`;
          if (!seenThinking.has(thinkKey)) {
            seenThinking.add(thinkKey);
            thinkingChars += block.thinking.length;
            thinkingCharsByModel.set(model, (thinkingCharsByModel.get(model) || 0) + block.thinking.length);
          }
        }
      }
    }

    const usageKey = event.requestId || msg.id || '';
    if (!msg.usage || !usageKey || seenUsage.has(usageKey)) continue;
    seenUsage.add(usageKey);

    const usage = normalizeClaudeUsage(msg.usage);
    result.calls.push({
      index: result.calls.length + 1,
      model,
      provider: 'anthropic',
      usage,
      prompt: truncate(latestPrompt, 110),
    });
    addUsage(result.totals, usage);
    trackByModel(result, 'anthropic', model, usage);
    result.model = model;
  }

  // Effort observável no Claude: presença de blocos thinking (signature), não o texto — o
  // nível low/medium/high não é gravado no transcript. Rótulo binário: thinking/none.
  result.pensamento = sawThinking ? 'thinking' : 'none';

  // Reasoning: estimativa-piso ~3,5 chars/token dos textos que escaparam da redação (quase
  // sempre 0 no thread principal). Já contido em output_tokens — nunca somado de novo. NÃO
  // determina o effort (desacoplado do pensamento acima).
  const thinkingTokens = Math.round(thinkingChars / 3.5);
  if (thinkingTokens > 0) {
    result.totals.reasoning = thinkingTokens;
    for (const [model, chars] of thinkingCharsByModel) {
      const entry = result.byModel.get(`anthropic:${model}`);
      if (entry) entry.usage.reasoning = Math.round(chars / 3.5);
    }
  }

  return result;
}

function detectTranscriptFormat(lines) {
  for (const line of lines.slice(0, 20)) {
    const event = parseJsonLine(line);
    if (!event) continue;
    if (event.type === 'session_meta' || event.type === 'turn_context'
      || event.type === 'event_msg' || event.type === 'response_item') return 'codex';
    if (event.type === 'assistant' || event.type === 'queue-operation'
      || event.type === 'file-history-snapshot' || event.type === 'last-prompt') return 'claude';
  }
  return 'codex';
}

export function parseTokenUsageFromTranscript(transcriptPath) {
  const result = emptyParseResult(transcriptPath);
  if (!transcriptPath || !existsSync(transcriptPath)) return result;

  const lines = readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean);
  return detectTranscriptFormat(lines) === 'claude'
    ? parseClaudeLines(lines, result)
    : parseCodexLines(lines, result);
}

function modelCost(usage, model) {
  const normalized = normalizeModelName(model);
  const price = PRICE_REFERENCE[normalized];
  return price ? calculateCost(usage, price) : 0;
}

export function summarizeTokenUsage(parsed) {
  const totals = parsed.totals;
  const modelRows = [...parsed.byModel.values()].map((entry) => ({
    ...entry,
    costs: {
      model: modelCost(entry.usage, entry.model),
    },
  }));
  const modelCostTotal = roundUsd(modelRows.reduce((sum, row) => sum + row.costs.model, 0));
  const modelLabel = modelRows.length === 1 ? modelRows[0].model : parsed.model;

  return {
    sessionId: parsed.sessionId,
    transcriptPath: parsed.transcriptPath,
    pensamento: parsed.pensamento || '',
    prompts: parsed.userPrompts.length,
    toolCalls: parsed.toolCalls,
    tools: parsed.tools,
    calls: parsed.calls.length,
    models: [...new Set(modelRows.map((row) => row.model))],
    providers: [...new Set(modelRows.map((row) => row.provider))],
    totals,
    costs: {
      model: modelCostTotal,
      modelLabel,
    },
    modelRows,
    callsTable: parsed.calls,
  };
}

// ---------------------------------------------------------------------------
// Histórico por transcript (reaberturas): cada conversa tem transcript próprio.
// O frontmatter guarda uma entrada por transcript; os campos planos são a soma.
// ---------------------------------------------------------------------------

function transcriptIdFromPath(transcriptPath) {
  return basename(String(transcriptPath || '')).replace(/\.jsonl?$/i, '') || 'desconhecido';
}

function entryFromSummary(summary, transcriptId) {
  return {
    transcript_id: transcriptId,
    provider: summary.providers.join(' + ') || 'unknown',
    modelos: summary.models,
    pensamento: summary.pensamento || '',
    input: summary.totals.input,
    cache_write: summary.totals.cacheWrite,
    cache_read: summary.totals.cached,
    output: summary.totals.output,
    reasoning: summary.totals.reasoning,
    total: summary.totals.total,
    custo_usd: summary.costs.model,
    prompts: summary.prompts,
    tool_calls: summary.toolCalls,
    chamadas_llm: summary.calls,
    tools: summary.tools,
    atualizado_em: new Date().toISOString().slice(0, 19),
  };
}

// Parser do bloco YAML `usage_por_transcript` gerado por este próprio script (formato fixo).
function parseUsageHistory(frontmatter) {
  const match = frontmatter.match(/^usage_por_transcript:\n((?:[ ]{2,}.*\n?)*)/m);
  if (!match) return [];

  const entries = [];
  let current = null;
  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const itemStart = line.match(/^[ ]{2}- transcript_id:\s*(.*)$/);
    if (itemStart) {
      current = { transcript_id: stripYamlScalar(itemStart[1]), modelos: [], tools: [] };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    const listItem = line.match(/^[ ]{6}- (.*)$/);
    if (listItem && current._listKey) {
      current[current._listKey].push(stripYamlScalar(listItem[1]));
      continue;
    }
    const kv = line.match(/^[ ]{4}([a-z_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'modelos' || key === 'tools') {
      current._listKey = key;
      current[key] = [];
      continue;
    }
    current._listKey = null;
    current[key] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : stripYamlScalar(value);
  }
  return entries.map(({ _listKey, ...entry }) => entry);
}

function stripYamlScalar(value) {
  return String(value || '').trim().replace(/^["']|["']$/g, '');
}

function aggregateEntries(entries) {
  const agg = {
    input: 0, cacheWrite: 0, cached: 0, output: 0, reasoning: 0, total: 0,
    custo: 0, prompts: 0, toolCalls: 0, calls: 0,
    models: [], providers: [], pensamentos: [], tools: [],
  };
  for (const e of entries) {
    agg.input += Number(e.input || 0);
    agg.cacheWrite += Number(e.cache_write || 0);
    agg.cached += Number(e.cache_read || 0);
    agg.output += Number(e.output || 0);
    agg.reasoning += Number(e.reasoning || 0);
    agg.total += Number(e.total || 0);
    agg.custo = roundUsd(agg.custo + Number(e.custo_usd || 0));
    agg.prompts += Number(e.prompts || 0);
    agg.toolCalls += Number(e.tool_calls || 0);
    agg.calls += Number(e.chamadas_llm || 0);
    for (const m of e.modelos || []) addUnique(agg.models, m);
    addUnique(agg.providers, e.provider);
    if (e.pensamento) addUnique(agg.pensamentos, e.pensamento);
    for (const t of e.tools || []) addUnique(agg.tools, t);
  }
  return agg;
}

function extractFrontmatterValue(content, key) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return '';
  const line = match[1].match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  return line ? line[1].trim().replace(/^["']|["']$/g, '') : '';
}

function stripManagedFrontmatter(frontmatter) {
  const lines = frontmatter.split('\n');
  const kept = [];
  let skipping = false;

  for (const line of lines) {
    const root = line.match(/^([A-Za-z0-9_]+):/);
    if (root) {
      skipping = MANAGED_FRONTMATTER_KEYS.has(root[1]);
      if (!skipping) kept.push(line);
      continue;
    }

    if (!skipping) kept.push(line);
  }

  return kept.join('\n').trimEnd();
}

function yamlList(key, values, indent = '') {
  if (!values.length) return `${indent}${key}: []`;
  return `${indent}${key}:\n${values.map((value) => `${indent}  - "${String(value).replace(/"/g, '\\"')}"`).join('\n')}`;
}

function buildUsageFrontmatter(agg, entries) {
  const model = agg.models.length === 1 ? agg.models[0] : agg.models.join(' + ');
  const provider = agg.providers.length === 1 ? agg.providers[0] : agg.providers.join(' + ');

  const historyYaml = entries.length
    ? [
      'usage_por_transcript:',
      ...entries.flatMap((e) => [
        `  - transcript_id: "${e.transcript_id}"`,
        `    provider: "${e.provider || 'unknown'}"`,
        yamlList('modelos', e.modelos || [], '    '),
        `    pensamento: "${e.pensamento || ''}"`,
        `    input: ${e.input || 0}`,
        `    cache_write: ${e.cache_write || 0}`,
        `    cache_read: ${e.cache_read || 0}`,
        `    output: ${e.output || 0}`,
        `    reasoning: ${e.reasoning || 0}`,
        `    total: ${e.total || 0}`,
        `    custo_usd: ${e.custo_usd || 0}`,
        `    prompts: ${e.prompts || 0}`,
        `    tool_calls: ${e.tool_calls || 0}`,
        `    chamadas_llm: ${e.chamadas_llm || 0}`,
        yamlList('tools', e.tools || [], '    '),
        `    atualizado_em: "${e.atualizado_em || ''}"`,
      ]),
    ].join('\n')
    : 'usage_por_transcript: []';

  return [
    `modelo: "${model || 'unknown'}"`,
    yamlList('modelos', agg.models),
    `provedor_modelo: "${provider || 'unknown'}"`,
    yamlList('provedores_modelo', agg.providers),
    `nivel_pensamento: "${agg.pensamentos.join(' + ')}"`,
    `prompts: ${agg.prompts}`,
    `tool_calls: ${agg.toolCalls}`,
    `tools_distinct: ${agg.tools.length}`,
    yamlList('tools', agg.tools),
    `chamadas_llm: ${agg.calls}`,
    `tokens_input: ${agg.input}`,
    `tokens_cache_write: ${agg.cacheWrite}`,
    `tokens_cached_input: ${agg.cached}`,
    `tokens_output: ${agg.output}`,
    `tokens_reasoning: ${agg.reasoning}`,
    `tokens_total: ${agg.total}`,
    `custo_modelo_label: "${model || 'unknown'}"`,
    `custo_modelo_usd: ${agg.custo}`,
    historyYaml,
  ].join('\n');
}

function upsertSessionFrontmatter(content, agg, entries) {
  const managedYaml = buildUsageFrontmatter(agg, entries);
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return `---\n${managedYaml}\n---\n\n${content}`;

  const clean = stripManagedFrontmatter(match[1]);
  const nextFrontmatter = [clean, managedYaml].filter(Boolean).join('\n');
  return `---\n${nextFrontmatter}\n---${content.slice(match[0].length)}`;
}

function buildModelTable(summary) {
  if (!summary.modelRows.length) return 'Nenhum modelo registrado.';

  return [
    '| Modelo | Provider | Chamadas | Input | Cache W | Cache R | Output | Reasoning | Total | Custo |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...summary.modelRows.map((row) => [
      `| ${escapeTableCell(row.model)}`,
      escapeTableCell(row.provider),
      fmtNum(row.calls),
      fmtNum(row.usage.input),
      fmtNum(row.usage.cacheWrite),
      fmtNum(row.usage.cached),
      fmtNum(row.usage.output),
      fmtNum(row.usage.reasoning),
      fmtNum(row.usage.total),
      `$${row.costs.model.toFixed(4)} |`,
    ].join(' | ')),
  ].join('\n');
}

function buildHistoryTable(entries) {
  if (!entries.length) return 'Nenhuma reabertura registrada.';

  return [
    '| Transcript | Modelo(s) | Pensamento | Input | Cache W | Cache R | Output | Total | Custo | Atualizado |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---|',
    ...entries.map((e) => [
      `| ${escapeTableCell(String(e.transcript_id).slice(0, 12))}…`,
      escapeTableCell((e.modelos || []).join(' + ')),
      escapeTableCell(e.pensamento || '-'),
      fmtNum(e.input),
      fmtNum(e.cache_write),
      fmtNum(e.cache_read),
      fmtNum(e.output),
      fmtNum(e.total),
      `$${Number(e.custo_usd || 0).toFixed(4)}`,
      `${escapeTableCell(e.atualizado_em || '')} |`,
    ].join(' | ')),
  ].join('\n');
}

function buildUsageSection(agg, entries, summary) {
  return `## Uso de tokens e custos

> Estimativa API-equivalente baseada nos transcripts locais (Codex/Claude Code). Não representa cobrança real do plano.

| Métrica | Valor |
|---|---:|
| Prompts | ${agg.prompts} |
| Ferramentas | ${agg.tools.length} tools / ${agg.toolCalls} calls |
| Chamadas com uso | ${fmtNum(agg.calls)} |
| Input tokens (não cacheados) | ${fmtNum(agg.input)} |
| Cache write tokens | ${fmtNum(agg.cacheWrite)} |
| Cache read tokens | ${fmtNum(agg.cached)} |
| Output tokens | ${fmtNum(agg.output)} |
| Thinking/reasoning tokens | ${fmtNum(agg.reasoning)} |
| Total tokens | ${fmtNum(agg.total)} |
| Modelo(s) | ${agg.models.join(' + ') || 'unknown'} |
| Nível de pensamento | ${agg.pensamentos.join(' + ') || '-'} |
| Custo estimado | $${agg.custo.toFixed(4)} |

### Por reabertura

${buildHistoryTable(entries)}

### Por modelo (transcript atual)

${buildModelTable(summary)}
`;
}

export function upsertUsageSection(content, section) {
  // Normaliza espaçamento nos dois caminhos (inserção e substituição) para manter idempotência.
  const assemble = (head, rest) => (rest
    ? `${head.trimEnd()}\n\n${section.trimEnd()}\n\n${rest.trimStart()}`
    : `${head.trimEnd()}\n\n${section.trimEnd()}\n`);

  const marker = '\n## Uso de tokens e custos';
  const existing = content.indexOf(marker);
  let base = content;

  if (existing !== -1) {
    const next = content.indexOf('\n## ', existing + marker.length);
    const usageTail = next === -1 ? content.slice(existing) : content.slice(existing, next);
    const orphanIteration = usageTail.search(/\n### \d{2}:\d{2} - /);
    const preservedTail = orphanIteration === -1 ? '' : usageTail.slice(orphanIteration).trim();
    const rest = next === -1 ? '' : content.slice(next).trimStart();
    base = [
      content.slice(0, existing).trimEnd(),
      preservedTail,
      rest,
    ].filter(Boolean).join('\n\n');
  }

  const anchor = base.includes('\n## Pendências')
    ? '\n## Pendências'
    : '\n## Encerramento';
  const anchorIndex = base.indexOf(anchor);
  if (anchorIndex === -1) return assemble(base, '');
  return assemble(base.slice(0, anchorIndex), base.slice(anchorIndex));
}

// Migração: nota antiga com totais planos mas sem usage_por_transcript.
// Preserva como entrada "legado", exceto quando o transcript atual parece ser a
// mesma conversa que gerou os totais (mesmos modelos) — aí descarta para não duplicar.
function legacyEntryFromNote(content, summary) {
  const total = Number(extractFrontmatterValue(content, 'tokens_total') || 0);
  if (!total) return null;

  const legacyModel = extractFrontmatterValue(content, 'modelo');
  const currentModels = summary.models.join(' + ');
  if (legacyModel && legacyModel === currentModels) return null;

  return {
    transcript_id: 'legado',
    provider: extractFrontmatterValue(content, 'provedor_modelo') || 'unknown',
    modelos: legacyModel ? [legacyModel] : [],
    pensamento: '',
    input: Number(extractFrontmatterValue(content, 'tokens_input') || 0),
    cache_write: 0,
    cache_read: Number(extractFrontmatterValue(content, 'tokens_cached_input') || 0),
    output: Number(extractFrontmatterValue(content, 'tokens_output') || 0),
    reasoning: Number(extractFrontmatterValue(content, 'tokens_reasoning') || 0),
    total,
    custo_usd: Number(extractFrontmatterValue(content, 'custo_modelo_usd') || 0),
    prompts: Number(extractFrontmatterValue(content, 'prompts') || 0),
    tool_calls: Number(extractFrontmatterValue(content, 'tool_calls') || 0),
    chamadas_llm: Number(extractFrontmatterValue(content, 'chamadas_llm') || 0),
    tools: [],
    atualizado_em: '',
  };
}

export function collectSessionUsage({ sessionContent, transcriptPath }) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return null;
  }

  const parsed = parseTokenUsageFromTranscript(transcriptPath);
  const summary = summarizeTokenUsage(parsed);
  if (!summary.calls) return null;

  const fmMatch = sessionContent.match(/^---\n([\s\S]*?)\n---/);
  const existingEntries = fmMatch ? parseUsageHistory(fmMatch[1]) : [];

  const transcriptId = transcriptIdFromPath(transcriptPath);
  const previous = existingEntries.find((entry) => entry.transcript_id === transcriptId);
  const current = entryFromSummary(summary, transcriptId);
  if (previous) {
    const comparable = (entry) => JSON.stringify({ ...entry, atualizado_em: undefined });
    if (comparable(previous) === comparable(current)) current.atualizado_em = previous.atualizado_em;
  }
  let entries = existingEntries.filter((e) => e.transcript_id !== transcriptId);

  if (!existingEntries.length) {
    const legacy = legacyEntryFromNote(sessionContent, summary);
    if (legacy) entries.push(legacy);
  }

  entries.push(current);

  const agg = aggregateEntries(entries);
  const withFrontmatter = upsertSessionFrontmatter(sessionContent, agg, entries);
  return {
    summary,
    aggregate: agg,
    entries,
    content: withFrontmatter,
  };
}

export function updateSessionUsage({ vaultBase, sessionRel, sessionPath, transcriptPath }) {
  if (!sessionPath || !existsSync(sessionPath)) return null;
  const result = collectSessionUsage({ sessionContent: readFileSync(sessionPath, 'utf-8'), transcriptPath });
  if (!result) return null;
  const withSection = upsertUsageSection(result.content, buildUsageSection(result.aggregate, result.entries, result.summary));
  writeFileSync(sessionPath, withSection, 'utf-8');
  return result;
}

function parseCliArgs(argv) {
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

function runCli() {
  const args = parseCliArgs(process.argv.slice(2));
  const vaultBase = getVaultBase({ obsidian_vault_path: args.vault });
  const control = readControl(vaultBase);
  const sessionRel = args.session || control.session_file || control.last_session_file || '';
  const sessionPath = sessionRel ? join(vaultBase, sessionRel) : '';
  const transcriptPath = args.transcript || '';

  const result = updateSessionUsage({ vaultBase, sessionRel, sessionPath, transcriptPath });
  if (!result) {
    console.log(JSON.stringify({ ok: false, reason: 'usage-not-available' }, null, 2));
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    session: sessionRel,
    calls: result.summary.calls,
    prompts: result.summary.prompts,
    toolCalls: result.summary.toolCalls,
    models: result.summary.models,
    pensamento: result.summary.pensamento,
    totals: result.summary.totals,
    costs: result.summary.costs,
    reaberturas: result.entries.length,
  }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`[wendkeep] Token usage falhou: ${error.message}\n`);
    process.exitCode = 1;
  }
}
