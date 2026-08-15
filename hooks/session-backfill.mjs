#!/usr/bin/env node
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import {
  buildIterationBlock,
  insertIteration,
  parseTranscript,
} from './session-stop.mjs';
import { completedCodexTurnIdsContent } from '../packages/integrations/src/transcripts.mjs';
import {
  getVaultBase,
  readControl,
  readSessionRegistry,
} from './obsidian-common.mjs';
import { assertVaultPathSafe } from './vault-path-safety.mjs';

function parseArgs(argv) {
  const args = { write: false, limit: 0, session: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--write') {
      args.write = true;
      continue;
    }
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
  args.limit = Number(args.limit || 0);
  return args;
}

function hasTurnMarker(content, turnId) {
  // recognize both the current `wk-turn` and the legacy `codex-turn`
  return content.includes(`<!-- wk-turn: ${turnId} -->`)
    || content.includes(`<!-- codex-turn: ${turnId} -->`);
}

function sessionEntries(vaultBase, args) {
  const registry = readSessionRegistry(vaultBase);
  const entries = Object.entries(registry.sessions || {})
    .map(([sessionId, item]) => ({ sessionId, ...item }))
    .filter((item) => item.session_file && item.transcript_path);

  if (args.session) {
    return entries.filter((item) => item.session_file === args.session || item.sessionId === args.session);
  }

  return entries;
}

export function backfillSessions({ vaultBase, write = false, limit = 0, session = '' }) {
  const args = { write, limit: Number(limit || 0), session };
  const report = {
    ok: true,
    mode: write ? 'write' : 'dry-run',
    scanned: 0,
    candidates: 0,
    inserted: 0,
    incomplete: 0,
    skipped: 0,
    missing: [],
    sessions: [],
  };

  for (const entry of sessionEntries(vaultBase, args)) {
    if (args.limit && report.scanned >= args.limit) break;
    report.scanned += 1;

    const checkedSession = assertVaultPathSafe(vaultBase, join(vaultBase, entry.session_file), {
      expectedType: 'file', label: 'nota de sessão do backfill',
    });
    const sessionPath = checkedSession.target;
    if (!checkedSession.exists || !existsSync(entry.transcript_path)) {
      report.missing.push({
        session: entry.session_file,
        sessionExists: existsSync(sessionPath),
        transcriptExists: existsSync(entry.transcript_path),
      });
      continue;
    }

    const transcriptContent = readFileSync(entry.transcript_path, 'utf-8');
    const tx = parseTranscript(entry.transcript_path);
    const allTurns = tx.turns.filter((turn) => turn.turnId && turn.userPrompts.length);
    const completedCodexTurns = tx.provider === 'codex'
      ? completedCodexTurnIdsContent(transcriptContent)
      : null;
    const turns = completedCodexTurns
      ? allTurns.filter((turn) => completedCodexTurns.has(turn.turnId))
      : allTurns;
    const content = readFileSync(sessionPath, 'utf-8');
    const missingTurns = turns.filter((turn) => !hasTurnMarker(content, turn.turnId));
    const incompleteTurns = completedCodexTurns
      ? allTurns.filter((turn) => (
        !completedCodexTurns.has(turn.turnId) && !hasTurnMarker(content, turn.turnId)
      ))
      : [];
    report.incomplete += incompleteTurns.length;

    if (!missingTurns.length) {
      report.skipped += 1;
      if (incompleteTurns.length) {
        report.sessions.push({
          session: entry.session_file,
          transcript: entry.transcript_path,
          missingTurns: [],
          incompleteTurns: incompleteTurns.map((turn) => turn.turnId),
          inserted: 0,
        });
      }
      continue;
    }

    report.candidates += 1;
    const sessionReport = {
      session: entry.session_file,
      transcript: entry.transcript_path,
      missingTurns: missingTurns.map((turn) => turn.turnId),
      incompleteTurns: incompleteTurns.map((turn) => turn.turnId),
      inserted: 0,
    };

    if (write) {
      for (const turn of missingTurns) {
        const inserted = insertIteration(
          sessionPath,
          buildIterationBlock(tx, { turn_id: turn.turnId, now: turn.timestamp }),
          turn.turnId,
          tx,
          vaultBase,
        );
        if (inserted.result === 'inserted') {
          report.inserted += 1;
          sessionReport.inserted += 1;
        }
      }
    }

    report.sessions.push(sessionReport);
  }

  return report;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const vaultBase = getVaultBase({ obsidian_vault_path: args.vault });
  const control = readControl(vaultBase);
  const result = backfillSessions({
    vaultBase,
    write: args.write,
    limit: args.limit,
    session: args.all ? '' : (args.session || control.session_file || ''),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[wendkeep] Backfill falhou: ${error.message}\n`);
    process.exitCode = 1;
  }
}
