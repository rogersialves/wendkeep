#!/usr/bin/env node
// Retroactive memory: import Claude Code transcripts that predate wendkeep into the vault.
// Each `.claude/projects/<slug>/<session_id>.jsonl` becomes a full session note in its real
// dated folder, deduped by session_id against the vault's SESSION_REGISTRY. This is an offline
// replay of the live capture flow — same skeleton, same iteration blocks, same cost/subagent
// telemetry, same finalize — so an imported note is indistinguishable from a captured one.
import { existsSync, readdirSync, writeFileSync, openSync, readSync, closeSync } from 'fs';
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
import { updateSessionUsage } from './token-usage.mjs';
import { upsertSubagentUsage } from './subagent-usage.mjs';
import { readSessionRegistry, upsertSessionRegistry, formatLocalIso, formatDate } from './obsidian-common.mjs';

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

// Recursively collect *.jsonl paths (manual walk: readdir recursive lands in Node 20; floor is 18).
function walkJsonl(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, out);
    else if (/\.jsonl$/i.test(e.name)) out.push(p);
  }
  return out;
}

// Read only the leading bytes to pull the session_meta payload (id + cwd); session_meta is the
// first line of a rollout, so a bounded prefix read avoids parsing multi-MB transcripts twice.
function readSessionMeta(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(16384);
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.slice(0, n).toString('utf-8').split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { return null; } // partial/oversized first line -> skip
      return e.type === 'session_meta' ? (e.payload || {}) : null; // meta is always line 1
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  }
  return null;
}

export function discoverCodexTranscripts(projectPath, fromDir) {
  const dir = fromDir || defaultCodexSessionsDir();
  if (!dir || !existsSync(dir)) return { dir, transcripts: [] };
  const transcripts = [];
  for (const path of walkJsonl(dir)) {
    const meta = readSessionMeta(path);
    if (!meta || !meta.id) continue;
    if (projectPath && !cwdMatchesProject(meta.cwd, projectPath)) continue;
    transcripts.push({ path, sessionId: meta.id, cwd: meta.cwd || '' });
  }
  return { dir, transcripts };
}

// Session objective for the note title/frontmatter: first real user prompt, one line.
function deriveSummary(tx) {
  for (const turn of tx.turns || []) {
    const prompt = (turn.userPrompts || []).find(Boolean);
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

  // Skeleton in the real dated folder, tagged with the transcript's own provider.
  const { absPath, relPath } = allocateSessionPath(vaultBase, startDate, summary);
  writeFileSync(absPath, buildSessionContent({ relPath, now: startDate, summary, provider: tx.provider }), 'utf-8');

  // One iteration block per turn (insertIteration dedups by turn marker -> re-import safe).
  for (const turn of turns) {
    const block = buildIterationBlock(tx, { turn_id: turn.turnId, now: turn.timestamp });
    insertIteration(absPath, block, turn.turnId, tx);
  }

  // Cost + subagent telemetry, exactly like the live Stop hook. Fail-open.
  try {
    updateSessionUsage({ vaultBase, sessionRel: relPath, sessionPath: absPath, transcriptPath: txPath });
  } catch { /* usage is best-effort */ }
  try {
    upsertSubagentUsage(absPath, txPath);
  } catch { /* subagent telemetry is best-effort */ }

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
  const captured = new Set(Object.keys(readSessionRegistry(vaultBase).sessions || {}));
  const sinceMs = since ? Date.parse(since) : 0;
  const report = { source: src, claudeDir, codexDir, scanned: transcripts.length, imported: 0, skipped: 0, errors: [], sessions: [] };

  let done = 0;
  for (const t of transcripts) {
    if (captured.has(t.sessionId)) { report.skipped++; continue; }
    if (limit && done >= limit) break;

    let tx;
    try {
      tx = parseTranscript(t.path);
    } catch (error) {
      report.errors.push({ sessionId: t.sessionId, error: error.message });
      continue;
    }
    const turns = tx.turns || [];
    if (!turns.length) { report.skipped++; continue; }

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
