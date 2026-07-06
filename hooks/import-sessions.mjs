#!/usr/bin/env node
// Retroactive memory: import Claude Code transcripts that predate wendkeep into the vault.
// Each `.claude/projects/<slug>/<session_id>.jsonl` becomes a full session note in its real
// dated folder, deduped by session_id against the vault's SESSION_REGISTRY. This is an offline
// replay of the live capture flow — same skeleton, same iteration blocks, same cost/subagent
// telemetry, same finalize — so an imported note is indistinguishable from a captured one.
import { existsSync, readdirSync, writeFileSync } from 'fs';
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
export function importSession(vaultBase, txPath, preParsed) {
  const tx = preParsed || parseTranscript(txPath);
  const turns = tx.turns || [];
  if (!turns.length) return null;

  const sessionId = tx.sessionId || basename(String(txPath), '.jsonl');
  const startDate = toDate(turns[0].timestamp, new Date());
  const endDate = toDate(turns.at(-1).timestamp, startDate);
  const summary = deriveSummary(tx);

  // Skeleton in the real dated folder.
  const { absPath, relPath } = allocateSessionPath(vaultBase, startDate, summary);
  writeFileSync(absPath, buildSessionContent({ relPath, now: startDate, summary }), 'utf-8');

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

// Import every not-yet-captured transcript. Deduped by session_id against the registry.
// Options: { projectPath, from, since (ISO/date), limit, dryRun }.
export function runImport(vaultBase, opts = {}) {
  const { projectPath = process.cwd(), from = '', since = '', limit = 0, dryRun = false } = opts;
  const { dir, transcripts } = discoverTranscripts(projectPath, from);
  const captured = new Set(Object.keys(readSessionRegistry(vaultBase).sessions || {}));
  const sinceMs = since ? Date.parse(since) : 0;
  const report = { dir, scanned: transcripts.length, imported: 0, skipped: 0, errors: [], sessions: [] };

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
      const r = importSession(vaultBase, t.path, tx);
      if (r) { report.sessions.push(r); report.imported++; done++; }
      else { report.skipped++; }
    } catch (error) {
      report.errors.push({ sessionId: t.sessionId, error: error.message });
    }
  }

  return report;
}
