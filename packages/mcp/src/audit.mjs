import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertVaultPathSafe,
  mkdirVaultPath,
  VAULT_LOCK_BUSY,
  withVaultPathLock,
  writeVaultFileAtomic,
} from '../../vault/src/vault-path-safety.mjs';

const OUTCOMES = new Set(['success', 'error']);
const EFFECTS = new Set(['read', 'write', 'destructive', 'unknown']);

function safeText(value, maximum = 160) {
  return String(value || '').replace(/[\r\n\t]/g, ' ').slice(0, maximum);
}

export function createMcpAuditor(vaultBase, { now = () => new Date() } = {}) {
  const runtime = join(vaultBase, '.brain', 'runtime');
  const path = join(runtime, 'MCP_AUDIT.jsonl');
  return async function auditToolCall(event = {}) {
    mkdirVaultPath(vaultBase, runtime, { label: 'runtime da auditoria MCP' });
    const record = {
      schema_version: 1,
      observed_at: now().toISOString(),
      tool: safeText(event.tool, 120),
      effect: EFFECTS.has(event.effect) ? event.effect : 'unknown',
      capability: safeText(event.capability, 120),
      outcome: OUTCOMES.has(event.outcome) ? event.outcome : 'error',
      error_code: safeText(event.error_code, 120),
      duration_ms: Math.max(0, Math.min(Number(event.duration_ms) || 0, 86_400_000)),
    };
    const outcome = withVaultPathLock(vaultBase, path, () => {
      const checked = assertVaultPathSafe(vaultBase, path, {
        expectedType: 'file', label: 'ledger de auditoria MCP',
      });
      const previous = checked.exists ? readFileSync(checked.target, 'utf8') : '';
      writeVaultFileAtomic(vaultBase, path, `${previous}${JSON.stringify(record)}\n`, 'utf8', {
        label: 'ledger de auditoria MCP',
      });
      return record;
    }, { code: 'MCP_AUDIT_LOCK_BUSY' });
    if (outcome === VAULT_LOCK_BUSY) {
      throw Object.assign(new Error('MCP audit ledger is busy'), { code: 'MCP_AUDIT_LOCK_BUSY' });
    }
    return outcome;
  };
}
