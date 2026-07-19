#!/usr/bin/env node
// Retroactive memory: import Claude Code transcripts that predate wendkeep into the vault.
// Each `.claude/projects/<slug>/<session_id>.jsonl` becomes a full session note in its real
// dated folder, deduped by session_id against the vault's SESSION_REGISTRY. This is an offline
// replay of the live capture flow — same skeleton, same iteration blocks, same cost/subagent
// telemetry, same finalize — so an imported note is indistinguishable from a captured one.
import { existsSync, readdirSync, writeFileSync, readFileSync, openSync, readSync, closeSync } from 'fs';
import { basename, join } from 'path';
import {
  parseTranscript,
  buildIterationBlock,
  insertIteration,
  finalizeSessionFile,
  mergeCreatedNotes,
  findLinkedDerivedNotes,
} from './session-stop.mjs';
import { buildSessionContent, allocateSessionPath } from './session-start.mjs';
import { createLinkedNotes } from './linked-notes.mjs';
import { updateSessionObservability } from './session-observability.mjs';
import { readSessionRegistry, upsertSessionRegistry, formatLocalIso, formatDate, providerMeta, isBootstrapPrompt } from './obsidian-common.mjs';
import { getLocale } from './locale.mjs';
import { captureProseDecisions } from './decision-capture.mjs';

// Claude encodes a project's absolute path as its `.claude/projects` dir name by replacing each
// path separator and the drive colon with '-'. `C:\GitHub\WendKeep` -> `C--GitHub-WendKeep`.
// Note: each char maps 1:1 (no collapsing), so `C:\` yields `C--`.
export function claudeProjectSlug(projectPath) {
  return String(projectPath || '').replace(/[\\/:]/g, '-');
}

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || '';
}

export function defaultClaudeProjectsDir(projectPath) {
  const home = homeDir();
  if (!home) return '';
  return join(home, '.claude', 'projects', claudeProjectSlug(projectPath));
}

// List candidate transcripts. The Claude session_id IS the filename, so we get it without
// parsing — cheap dedup for the (usually large) set of already-captured sessions.
export function discoverTranscripts(projectPath, fromDir) {
  const dir = fromDir || defaultClaudeProjectsDir(projectPath);
  if (!dir || !existsSync(dir)) return { dir, transcripts: [] };
  const transcripts = readdirSync(dir)
    .filter((name) => /\.jsonl$/i.test(name))
    .map((name) => ({ path: join(dir, name), sessionId: basename(name, '.jsonl') }));
  return { dir, transcripts };
}

// --- Codex source -----------------------------------------------------------
// Codex rollouts live in ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl and are NOT
// organized by project, so we scope them by the `cwd` recorded in each session_meta.

export function defaultCodexSessionsDir() {
  const home = homeDir();
  return home ? join(home, '.codex', 'sessions') : '';
}

function normPath(p) {
  return String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

// A Codex session belongs to the project when it ran from the project root or any subdir.
function cwdMatchesProject(cwd, projectPath) {
  const c = normPath(cwd);
  const proj = normPath(projectPath);
  if (!c || !proj) return false;
  return c === proj || c.startsWith(`${proj}/`);
}

// Recursively collect paths matching `re` (manual walk: readdir recursive lands in Node 20; floor is 18).
function walkFiles(dir, re, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, re, out);
    else if (re.test(e.name)) out.push(p);
  }
  return out;
}

// Read only the leading bytes of a file (avoids slurping multi-MB transcripts / notes).
function readPrefix(path, bytes = 4096) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.slice(0, n).toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

// Read the first physical line in full, growing the buffer until a newline is found (capped).
// A fixed prefix truncated any rollout whose session_meta line exceeded the window, silently
// dropping that session from discovery — Codex meta lines can be large (env, git, instructions).
function readFirstLine(path, maxBytes = 4 * 1024 * 1024) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const chunk = Buffer.alloc(65536);
    let acc = '';
    let pos = 0;
    while (pos < maxBytes) {
      const n = readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      acc += chunk.slice(0, n).toString('utf-8');
      const nl = acc.indexOf('\n');
      if (nl >= 0) return acc.slice(0, nl);
      pos += n;
    }
    return acc; // single-line file, or gave up at the cap
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

// Pull the session_meta payload (id + cwd). session_meta is line 1 of a rollout.
function readSessionMeta(path) {
  const line = readFirstLine(path);
  if (!line.trim()) return null;
  let e;
  try { e = JSON.parse(line); } catch { return null; }
  return e.type === 'session_meta' ? (e.payload || {}) : null;
}

// The `session_id` recorded in a note's frontmatter (empty when absent).
function noteSessionId(path) {
  const m = readPrefix(path, 2048).match(/^session_id:\s*["']?([^"'\r\n]+)["']?\s*$/m);
  return m ? m[1].trim() : '';
}

// Every session_id the vault already has a record of: the SESSION_REGISTRY plus every session
// note's frontmatter id. The registry is authoritative for wendkeep-native vaults, but scanning
// notes too keeps import safe even if the registry was reset/lost — a session with a note on
// disk is never re-imported.
export function capturedSessionIds(vaultBase) {
  const ids = new Set(Object.keys(readSessionRegistry(vaultBase).sessions || {}));
  try {
    const sessionsDir = join(vaultBase, getLocale(vaultBase).folders.sessions);
    for (const path of walkFiles(sessionsDir, /\.md$/i)) {
      const id = noteSessionId(path);
      if (id) ids.add(id);
    }
  } catch { /* registry alone is enough */ }
  return ids;
}

// session_id -> absolute note path, for the sessions that already have a note on disk. The
// registry alone is not enough: it records a session the moment session-start runs, which is
// exactly the state a damaged session is stuck in (registered, note empty).
export function capturedSessionNotes(vaultBase) {
  const notes = new Map();
  const registry = readSessionRegistry(vaultBase).sessions || {};
  for (const [id, entry] of Object.entries(registry)) {
    if (!entry?.session_file) continue;
    const abs = join(vaultBase, ...String(entry.session_file).split('/'));
    if (existsSync(abs)) notes.set(id, abs);
  }
  try {
    const sessionsDir = join(vaultBase, getLocale(vaultBase).folders.sessions);
    for (const path of walkFiles(sessionsDir, /\.md$/i)) {
      const id = noteSessionId(path);
      if (id && !notes.has(id)) notes.set(id, path);
    }
  } catch { /* registry alone is enough */ }
  return notes;
}

// Turn ids already memorialized in a note, read from the `wk-turn` markers insertIteration
// writes. Missing/unreadable note = nothing captured.
export function noteTurnIds(notePath) {
  try {
    const md = readFileSync(notePath, 'utf-8');
    return new Set([...md.matchAll(/<!-- (?:wk|codex)-turn: ([^\s]+) -->/g)].map((m) => m[1]));
  } catch { return new Set(); }
}

export function discoverCodexTranscripts(projectPath, fromDir) {
  const dir = fromDir || defaultCodexSessionsDir();
  if (!dir || !existsSync(dir)) return { dir, transcripts: [] };
  const transcripts = [];
  for (const path of walkFiles(dir, /\.jsonl$/i)) {
    const meta = readSessionMeta(path);
    if (!meta || !meta.id) continue;
    if (projectPath && !cwdMatchesProject(meta.cwd, projectPath)) continue;
    transcripts.push({ path, sessionId: meta.id, cwd: meta.cwd || '' });
  }
  return { dir, transcripts };
}

// Session objective for the note title/frontmatter: first real user prompt, one line.
// Mirrors buildIterationBlock's selection (`userPrompts.at(-1)`) on purpose: the harness
// injects preamble as the FIRST prompt of a turn and the user's request lands LAST, so taking
// the first titled six Vendiva sessions "<recommended_plugins> Here is a list of plugins".
// isBootstrapPrompt is the belt: it runs per whole prompt, not per line — filtering by line
// would fall through to the next line of the SAME injected block.
export function deriveSummary(tx) {
  for (const turn of tx?.turns || []) {
    const prompt = (turn.userPrompts || []).filter((p) => p && !isBootstrapPrompt(p)).at(-1);
    if (prompt) {
      return prompt.replace(/[\r\n#]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'session';
    }
  }
  return 'session';
}

function toDate(ts, fallback) {
  const d = ts ? new Date(ts) : null;
  return d && Number.isFinite(d.getTime()) ? d : fallback;
}

// Replay one transcript into a fresh, finalized note. Returns {sessionId, relPath, turns} or
// null when the transcript has no memorializable turns. Assumes the caller already deduped.
// opts: { tx (pre-parsed), sessionId (registry key — pass the discovered id so registration
// matches the dedup key exactly; falls back to the transcript's own id) }.
export function importSession(vaultBase, txPath, opts = {}) {
  const { tx: preParsed, sessionId: sessionIdOverride } = opts;
  const tx = preParsed || parseTranscript(txPath);
  const turns = tx.turns || [];
  if (!turns.length) return null;

  const sessionId = sessionIdOverride || tx.sessionId || basename(String(txPath), '.jsonl');
  const startDate = toDate(turns[0].timestamp, new Date());
  const endDate = toDate(turns.at(-1).timestamp, startDate);
  const summary = deriveSummary(tx);

  // Skeleton in the real dated folder, tagged with the transcript's own provider + session id.
  const { absPath, relPath } = allocateSessionPath(vaultBase, startDate, summary);
  writeFileSync(absPath, buildSessionContent({ relPath, now: startDate, summary, provider: tx.provider, sessionId }), 'utf-8');

  // One iteration block per turn (insertIteration dedups by turn marker -> re-import safe).
  for (const turn of turns) {
    const block = buildIterationBlock(tx, { turn_id: turn.turnId, now: turn.timestamp });
    insertIteration(absPath, block, turn.turnId, tx);
  }

  // Cost + subagent telemetry, exactly like the live Stop hook. Fail-open.
  try {
    updateSessionObservability({ sessionPath: absPath, transcriptPath: txPath });
  } catch { /* observability is best-effort */ }

  // Finalize: derived notes + closing section + ended_at from the last turn.
  const endedAt = formatLocalIso(endDate);
  const created = mergeCreatedNotes(
    createLinkedNotes(vaultBase, formatDate(endDate), relPath, tx),
    findLinkedDerivedNotes(vaultBase, relPath),
  );
  finalizeSessionFile(absPath, tx, created, endedAt);

  upsertSessionRegistry(vaultBase, sessionId, {
    session_file: relPath,
    status: 'done',
    started_at: formatLocalIso(startDate),
    ended_at: endedAt,
    last_turn_id: turns.at(-1).turnId,
    transcript_path: txPath,
    imported: true,
  });

  return { sessionId, relPath, turns: turns.length };
}

// Re-scan ALREADY-imported/captured transcripts for prose decisions only (no session re-import).
// For sessions imported before 0.29.0, whose transcripts carry options-in-prose choices that were
// never captured. Walks the registry (session_file + transcript_path), parses each transcript and
// runs captureProseDecisions — filename-deduped, so re-running is a no-op. Fail-soft per session.
export function rescanDecisions(vaultBase, { limit = 0 } = {}) {
  const sessions = readSessionRegistry(vaultBase).sessions || {};
  const report = { scanned: 0, decisions: 0, errors: [], sessions: [] };
  let done = 0;
  for (const [sessionId, entry] of Object.entries(sessions)) {
    if (!entry?.transcript_path || !entry.session_file) continue;
    if (!existsSync(entry.transcript_path)) continue;
    if (limit && done >= limit) break;
    report.scanned += 1;
    done += 1;
    try {
      const tx = parseTranscript(entry.transcript_path);
      const dateStr = String(entry.started_at || entry.ended_at || '').slice(0, 10) || formatDate(new Date());
      const written = captureProseDecisions(vaultBase, {
        tx, dateStr, sessionRel: entry.session_file, provider: providerMeta(tx.provider),
      });
      if (written.length) {
        report.decisions += written.length;
        report.sessions.push({ sessionId, notes: written });
      }
    } catch (error) {
      report.errors.push({ sessionId, error: error.message });
    }
  }
  return report;
}

// Stamp a missing/empty `session_id` into a note's frontmatter (only within the frontmatter
// block, right after `provider:`). Leaves a note that already has a non-empty id untouched.
function injectSessionIdFrontmatter(content, sessionId) {
  const q = `"${String(sessionId).replace(/"/g, '\\"')}"`;
  if (/^session_id:\s*$/m.test(content)) return content.replace(/^session_id:\s*$/m, `session_id: ${q}`);
  if (/^session_id:\s*\S/m.test(content)) return content; // already has a value
  if (/^provider:.*$/m.test(content)) return content.replace(/^(provider:.*)$/m, `$1\nsession_id: ${q}`);
  return content.replace(/^---\s*$/m, `---\nsession_id: ${q}`);
}

// Backfill `session_id` into existing session notes from the SESSION_REGISTRY (session_file -> id).
// For notes captured/imported before the field existed. Idempotent; only touches notes missing it.
export function stampSessionIds(vaultBase) {
  const reg = readSessionRegistry(vaultBase).sessions || {};
  const report = { total: Object.keys(reg).length, stamped: 0, alreadyOk: 0, missingFile: 0 };
  for (const [sessionId, entry] of Object.entries(reg)) {
    if (!entry?.session_file) continue;
    const abs = join(vaultBase, entry.session_file);
    if (!existsSync(abs)) { report.missingFile++; continue; }
    let content;
    try { content = readFileSync(abs, 'utf-8'); } catch { report.missingFile++; continue; }
    const next = injectSessionIdFrontmatter(content, sessionId);
    if (next !== content) { writeFileSync(abs, next, 'utf-8'); report.stamped++; }
    else { report.alreadyOk++; }
  }
  return report;
}

// Import every not-yet-captured transcript from the requested source(s). Deduped by session_id
// against the registry. Options: { projectPath, source ('all'|'claude'|'codex'), from, codexFrom,
// since (ISO/date), limit, dryRun }. importSession is provider-agnostic, so both sources share
// the same dedup + import loop.
export function runImport(vaultBase, opts = {}) {
  const { projectPath = process.cwd(), source = 'all', from = '', codexFrom = '', since = '', limit = 0, dryRun = false } = opts;
  const src = String(source).toLowerCase();
  const transcripts = [];
  let claudeDir = '';
  let codexDir = '';
  if (src === 'all' || src === 'claude') {
    const d = discoverTranscripts(projectPath, from);
    claudeDir = d.dir;
    transcripts.push(...d.transcripts);
  }
  if (src === 'all' || src === 'codex') {
    const d = discoverCodexTranscripts(projectPath, codexFrom);
    codexDir = d.dir;
    transcripts.push(...d.transcripts);
  }
  const notes = capturedSessionNotes(vaultBase);
  const sinceMs = since ? Date.parse(since) : 0;
  const report = { source: src, claudeDir, codexDir, scanned: transcripts.length, imported: 0, repaired: 0, skipped: 0, errors: [], sessions: [] };

  let done = 0;
  for (const t of transcripts) {
    if (limit && done >= limit) break;

    // Every transcript is parsed now, including already-captured ones: partial coverage is
    // undetectable without the turn list. The old presence-only check was cheaper but made
    // the recovery command blind to exactly the sessions it exists to repair. Narrow a large
    // vault with --since / --limit.
    let tx;
    try {
      tx = parseTranscript(t.path);
    } catch (error) {
      report.errors.push({ sessionId: t.sessionId, error: error.message });
      continue;
    }
    const turns = tx.turns || [];
    if (!turns.length) { report.skipped++; continue; }

    const existingNote = notes.get(t.sessionId);
    if (existingNote) {
      const have = noteTurnIds(existingNote);
      const missing = turns.filter((turn) => !have.has(String(turn.turnId)));
      if (!missing.length) { report.skipped++; continue; }
      if (dryRun) {
        report.sessions.push({ sessionId: t.sessionId, turns: missing.length, repaired: true, dryRun: true });
        report.repaired++;
        done++;
        continue;
      }
      try {
        for (const turn of missing) {
          insertIteration(existingNote, buildIterationBlock(tx, { turn_id: turn.turnId, now: turn.timestamp }), turn.turnId, tx);
        }
        try { updateSessionObservability({ sessionPath: existingNote, transcriptPath: t.path }); } catch { /* best-effort */ }
        report.sessions.push({ sessionId: t.sessionId, turns: missing.length, repaired: true });
        report.repaired++;
        done++;
      } catch (error) {
        report.errors.push({ sessionId: t.sessionId, error: error.message });
      }
      continue;
    }

    const startTs = turns[0].timestamp || '';
    if (sinceMs && startTs && Number.isFinite(Date.parse(startTs)) && Date.parse(startTs) < sinceMs) {
      report.skipped++;
      continue;
    }

    if (dryRun) {
      report.sessions.push({ sessionId: t.sessionId, turns: turns.length, startTs, dryRun: true });
      report.imported++;
      done++;
      continue;
    }

    try {
      const r = importSession(vaultBase, t.path, { tx, sessionId: t.sessionId });
      if (r) { report.sessions.push(r); report.imported++; done++; }
      else { report.skipped++; }
    } catch (error) {
      report.errors.push({ sessionId: t.sessionId, error: error.message });
    }
  }

  return report;
}
