#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative } from 'path';
import { getLocale } from './locale.mjs';

// Neutral fallback only. The vault is normally resolved from the
// OBSIDIAN_VAULT_PATH env var (set by `wendkeep init`) via getVaultBase() below.
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
  'Atualize `SHARED_MEMORY.md` somente quando a síntese mudar estado ativo que outro agente precise saber.',
];

export function readHookInput() {
  const raw = readFileSync(0, 'utf-8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

export function writeHookOutput(payload = {}) {
  process.stdout.write(JSON.stringify(payload));
}

// Resolve the vault and report WHERE the path came from, so callers can react to
// an unconfigured install instead of silently writing to the home fallback.
//   env     -> OBSIDIAN_VAULT_PATH (set by `wendkeep init`)
//   payload -> obsidian_vault_path from the hook's JSON input
//   default -> DEFAULT_VAULT_BASE (~/wendkeep-vault) — a phantom vault nobody opened
export function resolveVault(input = {}) {
  if (process.env.OBSIDIAN_VAULT_PATH) {
    return { base: process.env.OBSIDIAN_VAULT_PATH, source: 'env' };
  }
  if (input && input.obsidian_vault_path) {
    return { base: input.obsidian_vault_path, source: 'payload' };
  }
  return { base: DEFAULT_VAULT_BASE, source: 'default' };
}

export function getVaultBase(input = {}) {
  return resolveVault(input).base;
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

// Warn loudly (stderr) when the vault resolved to the home fallback — i.e. neither
// OBSIDIAN_VAULT_PATH nor a payload path was provided. Without this the hooks write
// notes into ~/wendkeep-vault with zero signal that the install is misconfigured.
// Returns the resolution source so callers can branch if they want.
export function warnIfDefaultVault(input = {}) {
  const { base, source } = resolveVault(input);
  if (source === 'default') {
    process.stderr.write(
      `[wendkeep] WARNING: OBSIDIAN_VAULT_PATH não definido — gravando no fallback "${base}". ` +
        'Rode `wendkeep init` ou defina OBSIDIAN_VAULT_PATH apontando ao seu vault Obsidian.\n',
    );
  }
  return source;
}

// Detecta o agente real que está executando o hook. Claude Code expõe
// CLAUDECODE / CLAUDE_CODE_SESSION_ID / CLAUDE_PROJECT_DIR; Codex não.
export function detectProvider() {
  if (process.env.CLAUDECODE === '1' || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_PROJECT_DIR) {
    return 'claude';
  }
  return 'codex';
}

export function providerMeta(provider = detectProvider()) {
  if (provider === 'claude') {
    return { id: 'claude', label: 'Claude Code', tag: 'claude', source: 'claude-hook' };
  }
  return { id: 'codex', label: 'Codex', tag: 'codex', source: 'codex-hook' };
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
  if (!existsSync(path)) return {};

  const content = readFileSync(path, 'utf-8');
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
  ensureDir(dirname(path));

  const status = data.status || 'inactive';
  const sessionFile = data.session_file || '';
  const lastSessionFile = data.last_session_file || sessionFile || '';
  const startedAt = data.started_at || '';
  const endedAt = data.ended_at || '';
  const sessionId = data.session_id || '';
  const lastLoggedTurnId = data.last_logged_turn_id || '';

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

- **Status:** ${status}
- **Sessão ativa:** ${sessionFile || 'nenhuma'}
- **Última sessão encerrada:** ${lastSessionFile || 'nenhuma'}
- **Início:** ${startedAt || 'n/a'}
- **Fim:** ${endedAt || 'n/a'}

Regra crítica: sempre anexar conteúdo à sessão ativa. Nunca sobrescrever o histórico de iterações.
`;

  writeFileSync(path, content, 'utf-8');
}

export function readSessionRegistry(vaultBase) {
  const path = registryPath(vaultBase);
  if (!existsSync(path)) return { version: 1, sessions: {} };

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return {
      version: parsed.version || 1,
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
    };
  } catch {
    return { version: 1, sessions: {} };
  }
}

export function writeSessionRegistry(vaultBase, registry) {
  const path = registryPath(vaultBase);
  ensureDir(dirname(path));
  // Escrita atômica: grava em tmp e renomeia (rename é atômico no mesmo volume),
  // evitando registry truncado/corrompido quando dois hooks gravam ao mesmo tempo.
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
}

export function upsertSessionRegistry(vaultBase, sessionId, patch) {
  if (!sessionId) return null;

  const registry = readSessionRegistry(vaultBase);
  const current = registry.sessions[sessionId] || {};
  const next = {
    ...current,
    ...patch,
    updated_at: patch.updated_at || formatLocalIso(new Date()),
  };
  registry.sessions[sessionId] = next;
  writeSessionRegistry(vaultBase, registry);
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

// Wrapper de IO: varre as ociosas, grava o registry e fecha a NOTA `.md` de cada
// sessão encerrada (mantém vault e registry alinhados). Devolve quantas fechou.
export function sweepStaleSessionsFile(vaultBase, now = new Date(), maxIdleMs = SESSION_IDLE_CLOSE_MS, excludeTranscriptPath = '') {
  const registry = readSessionRegistry(vaultBase);
  const closed = sweepStaleSessions(registry, now.getTime(), maxIdleMs, excludeTranscriptPath);
  if (closed.length) writeSessionRegistry(vaultBase, registry);
  for (const { session_file, ended_at } of closed) {
    try { closeSessionNoteFile(vaultBase, session_file, ended_at); } catch { /* nunca derruba o sweep */ }
  }
  return closed.length;
}

// IO: alinha a nota `.md` da sessão ao `done` (idempotente; no-op se ausente ou
// já fechada com o mesmo `endedAt`). Devolve true se gravou.
export function closeSessionNoteFile(vaultBase, sessionFileRel, endedAt) {
  if (!sessionFileRel) return false;
  const path = join(vaultBase, sessionFileRel);
  if (!existsSync(path)) return false;
  const content = readFileSync(path, 'utf-8');
  const next = closeSessionNote(content, endedAt);
  if (next === content) return false;
  writeFileSync(path, next, 'utf-8');
  return true;
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

export function slugify(text, fallback = 'nota') {
  const slug = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/g, '');
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

export function extractHookPrompt(input = {}) {
  const candidates = [
    input.prompt,
    input.user_prompt,
    input.userPrompt,
    input.message,
    input.input,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }

  if (Array.isArray(input.messages)) {
    const text = input.messages
      .map((message) => message?.content || message?.text || '')
      .filter((item) => typeof item === 'string' && item.trim())
      .join('\n')
      .trim();
    if (text) return text;
  }

  return '';
}

export function isBootstrapPrompt(text = '') {
  const clean = String(text || '').trim();
  return clean.startsWith('# AGENTS.md instructions')
    || clean.startsWith('<environment_context>')
    || clean.startsWith('<permissions instructions>')
    || clean.includes('You are Codex, a coding agent')
    || clean.startsWith('## Memory');
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

function normalizeTranscript(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase();
}

function transcriptBasename(p) {
  const n = normalizeTranscript(p);
  const i = n.lastIndexOf('/');
  return i === -1 ? n : n.slice(i + 1);
}

// Mesmo transcript apesar de caixa/separador diferentes (o Claude Code emite o
// slug do projeto ora `c--`, ora `C--`) ou prefixo de path diferente (WSL vs
// Windows). Compara normalizado e, em último caso, pelo basename
// (`<session_id>.jsonl`, globalmente único). Evita rupturas de sessão no restart.
export function transcriptsMatch(a, b) {
  if (!a || !b) return false;
  if (normalizeTranscript(a) === normalizeTranscript(b)) return true;
  const ba = transcriptBasename(a);
  return !!ba && ba === transcriptBasename(b);
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
    if (!transcriptsMatch(item.transcript_path, transcriptPath)) continue;
    if (!best || String(item.started_at || '') > String(best.started_at || '')) {
      best = { sessionId, session_file: item.session_file, started_at: item.started_at || '' };
    }
  }
  return best;
}

export function redactSecrets(text) {
  if (!text) return '';
  return String(text)
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED_SECRET]')
    .replace(/\b(whsec_[A-Za-z0-9_/-]{8,})\b/g, '[REDACTED_SECRET]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[REDACTED_SECRET]')
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{12,})\b/g, '[REDACTED_SECRET]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*)\s*[:=]\s*["']?[^"'\s]+/gi, '$1=[REDACTED_SECRET]')
    .replace(/:\/\/([^:\s/@]+):([^@\s/]+)@/g, '://[REDACTED_SECRET]@');
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

export function listMarkdownFiles(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
}

export function getNextAdrNumber(vaultBase) {
  const decisionsDir = join(vaultBase, getLocale(vaultBase).folders.decisions);
  let max = 0;
  // Varre recursivamente: os ADRs agora vivem em subpastas datadas (AAAA/MM-MMM/DIA DD).
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
        const match = entry.name.match(/^ADR-(\d+)/i);
        if (match) max = Math.max(max, Number(match[1]));
      }
    }
  };
  walk(decisionsDir);
  return max + 1;
}

export function statExists(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}
