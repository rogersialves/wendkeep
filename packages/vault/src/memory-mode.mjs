import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { classifySharedMemory } from './memory-schema.mjs';
import { assertVaultPathSafe } from './vault-path-safety.mjs';

export const LEGACY_MEMORY_WARNING = 'Vault legado: CORE+DIGEST permanece ativo; execute `wendkeep memory migrate --apply` quando a curadoria estiver pronta.';

function aliasBoundaryError(error) {
  return error?.code === 'VAULT_PATH_UNSAFE'
    && /link simbólico|junction|reparse|hardlink|nlink|redirecion|escapa logicamente/i
      .test(String(error?.message || error));
}

function readText(vaultBase, path, label) {
  try {
    let checked = assertVaultPathSafe(vaultBase, path, { expectedType: 'file', label });
    if (!checked.exists) return { exists: false, content: '', error: null };
    checked = assertVaultPathSafe(vaultBase, checked.target, {
      allowMissing: false, expectedType: 'file', label,
    });
    return { exists: true, content: readFileSync(checked.target, 'utf8'), error: null };
  }
  catch (error) {
    if (aliasBoundaryError(error)) throw error;
    return { exists: true, content: '', error };
  }
}

function hasOutboxEvidence(vaultBase, path) {
  try {
    let checked = assertVaultPathSafe(vaultBase, path, {
      expectedType: 'directory', label: 'outbox de memória',
    });
    if (!checked.exists) return false;
    checked = assertVaultPathSafe(vaultBase, checked.target, {
      allowMissing: false, expectedType: 'directory', label: 'outbox de memória',
    });
    const entries = readdirSync(checked.target, { withFileTypes: true });
    for (const entry of entries) {
      assertVaultPathSafe(vaultBase, join(checked.target, entry.name), {
        allowMissing: false, label: `entrada ${entry.name} da outbox de memória`,
      });
    }
    return entries.some((entry) => entry.isFile());
  }
  catch (error) {
    if (aliasBoundaryError(error)) throw error;
    return true;
  }
}

function preflightOptionalMemoryFile(vaultBase, path, label) {
  try { assertVaultPathSafe(vaultBase, path, { expectedType: 'file', label }); }
  catch (error) {
    if (aliasBoundaryError(error)) throw error;
    // Ordinary unreadable/wrong-type layers preserve the existing degraded-mode contract.
  }
}

/** A single, read-only mode decision shared by injection, health and SessionStop. */
export function detectMemoryMode(vaultBase) {
  const brain = join(vaultBase, '.brain');
  assertVaultPathSafe(vaultBase, brain, {
    expectedType: 'directory', label: 'raiz .brain da memória',
  });
  // Preflight the layers consumed immediately after mode detection by injection and Stop.
  for (const name of ['CORE.md', 'PROJECT.json', 'DIGEST.md']) {
    preflightOptionalMemoryFile(vaultBase, join(brain, name), `camada de memória ${name}`);
  }
  const shared = readText(vaultBase, join(brain, 'SHARED_MEMORY.md'), 'camada SHARED_MEMORY.md');
  if (shared.error) return { mode: 'v2', reason: 'shared-unreadable' };
  const classified = classifySharedMemory(shared.content);
  if (classified.mode === 'v2') return classified;

  const ledger = readText(vaultBase, join(brain, 'MEMORY_EVENTS.jsonl'), 'ledger MEMORY_EVENTS.jsonl');
  if (ledger.error) return { mode: 'v2', reason: 'ledger-unreadable' };
  const candidates = readText(
    vaultBase, join(brain, 'MEMORY_CANDIDATES.jsonl'), 'sidecar MEMORY_CANDIDATES.jsonl',
  );
  if (candidates.error) return { mode: 'v2', reason: 'candidates-unreadable' };
  const ledgerHasEvents = ledger.content.trim().length > 0;
  const candidatesHaveEntries = candidates.content.trim().length > 0;
  const outboxHasEvents = hasOutboxEvidence(vaultBase, join(brain, 'memory-outbox'));
  if (ledgerHasEvents || candidatesHaveEntries || outboxHasEvents) {
    return { mode: 'v2', reason: 'operational-evidence' };
  }
  return classified;
}
