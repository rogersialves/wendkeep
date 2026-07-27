// Deterministic cost reconstruction for historical sessions.
// Registry is authoritative: session_file <-> transcript_path. Dry-run restores every note.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSessionRegistry } from '../hooks/obsidian-common.mjs';
import { updateSessionObservability } from '../hooks/session-observability.mjs';
import { assertVaultPathSafe } from '../hooks/vault-path-safety.mjs';

export function rebuildSessionCosts(vaultBase, { apply = false, session = '', limit = 0 } = {}) {
  const registry = readSessionRegistry(vaultBase);
  const report = { version: 1, generatedAt: new Date().toISOString(), mode: apply ? 'apply' : 'dry-run', scanned: 0, changed: 0, unchanged: 0, missing: [], errors: [], sessions: [] };
  const entries = Object.entries(registry.sessions || {}).map(([sessionId, value]) => ({ sessionId, ...value }))
    .filter((e) => e.session_file)
    .filter((e) => !session || e.sessionId === session || e.session_file === session);
  for (const entry of entries) {
    if (limit && report.scanned >= limit) break;
    report.scanned += 1;
    const checkedNote = assertVaultPathSafe(vaultBase, join(vaultBase, entry.session_file), {
      expectedType: 'file', label: 'nota de sessão do rebuild de custos',
    });
    const note = checkedNote.target;
    if (!entry.transcript_path || !checkedNote.exists || !existsSync(entry.transcript_path)) {
      report.missing.push({ sessionId: entry.sessionId, session: entry.session_file, note: checkedNote.exists, transcript: !!entry.transcript_path && existsSync(entry.transcript_path), transcriptPath: entry.transcript_path || '' });
      continue;
    }
    const before = readFileSync(note, 'utf8');
    try {
      updateSessionObservability({
        vaultBase, sessionPath: note, transcriptPath: entry.transcript_path,
        caller: 'cost-rebuild', canonicalConversationId: entry.sessionId,
      });
      const after = readFileSync(note, 'utf8');
      const changed = before !== after;
      if (changed) report.changed += 1; else report.unchanged += 1;
      report.sessions.push({ sessionId: entry.sessionId, session: entry.session_file, transcript: entry.transcript_path, changed });
      if (!apply && changed) writeFileSync(note, before, 'utf8');
    } catch (error) {
      if (!apply) writeFileSync(note, before, 'utf8');
      report.errors.push({ sessionId: entry.sessionId, session: entry.session_file, error: error.message });
    }
  }
  report.ok = report.errors.length === 0 && report.missing.length === 0;
  if (apply) writeFileSync(join(vaultBase, '.brain', 'COST_REBUILD.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}
