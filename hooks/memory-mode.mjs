import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { classifySharedMemory } from './memory-schema.mjs';

export const LEGACY_MEMORY_WARNING = 'Vault legado: CORE+DIGEST permanece ativo; execute `wendkeep memory migrate --apply` quando a curadoria estiver pronta.';

function readText(path) {
  if (!existsSync(path)) return { exists: false, content: '', error: null };
  try { return { exists: true, content: readFileSync(path, 'utf8'), error: null }; }
  catch (error) { return { exists: true, content: '', error }; }
}

function hasOutboxEvidence(path) {
  if (!existsSync(path)) return false;
  try { return readdirSync(path, { withFileTypes: true }).some((entry) => entry.isFile()); }
  catch { return true; }
}

/** A single, read-only mode decision shared by injection, health and SessionStop. */
export function detectMemoryMode(vaultBase) {
  const brain = join(vaultBase, '.brain');
  const shared = readText(join(brain, 'SHARED_MEMORY.md'));
  if (shared.error) return { mode: 'v2', reason: 'shared-unreadable' };
  const classified = classifySharedMemory(shared.content);
  if (classified.mode === 'v2') return classified;

  const ledger = readText(join(brain, 'MEMORY_EVENTS.jsonl'));
  if (ledger.error) return { mode: 'v2', reason: 'ledger-unreadable' };
  const candidates = readText(join(brain, 'MEMORY_CANDIDATES.jsonl'));
  if (candidates.error) return { mode: 'v2', reason: 'candidates-unreadable' };
  const ledgerHasEvents = ledger.content.trim().length > 0;
  const candidatesHaveEntries = candidates.content.trim().length > 0;
  const outboxHasEvents = hasOutboxEvidence(join(brain, 'memory-outbox'));
  if (ledgerHasEvents || candidatesHaveEntries || outboxHasEvents) {
    return { mode: 'v2', reason: 'operational-evidence' };
  }
  return classified;
}
