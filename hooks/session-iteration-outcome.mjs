import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from '../packages/integrations/src/prompt-content.mjs';
import {
  assertVaultPathSafe,
  VAULT_LOCK_BUSY,
  withVaultPathLock,
  writeVaultFileAtomic,
} from '../packages/vault/src/vault-path-safety.mjs';

export const ITERATION_OUTCOME_LEDGER = '.brain/SESSION_ITERATION_OUTCOMES.jsonl';
export const OUTCOME_RESULTS = Object.freeze([
  'inserted', 'duplicate', 'ambiguous', 'aborted', 'skipped', 'busy', 'failed',
  'published', 'degraded', 'stale', 'missing', 'conflict',
]);

const RESULT_SET = new Set(OUTCOME_RESULTS);
const STAGES = new Set(['iteration', 'observability']);
const LOCK_STATUSES = new Set(['acquired', 'busy', 'not_required', 'unknown']);

function safeId(value, fallback = 'unknown') {
  const clean = String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
  return clean || fallback;
}
function safeReason(value) {
  return redactSecrets(String(value ?? ''))
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function safeTimestamp(value) {
  const candidate = String(value ?? '').trim();
  if (candidate && !Number.isNaN(Date.parse(candidate))) return new Date(candidate).toISOString();
  return new Date().toISOString();
}

function safeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function iterationOutcomePath(vaultBase) {
  return join(vaultBase, ITERATION_OUTCOME_LEDGER);
}

export function outcomeKey(input = {}) {
  return [
    safeId(input.session_id),
    safeId(input.turn_id),
    STAGES.has(input.stage) ? input.stage : 'iteration',
  ].join(':');
}

export function normalizeIterationOutcome(input = {}) {
  const sessionId = safeId(input.session_id);
  const turnId = safeId(input.turn_id);
  const stage = STAGES.has(input.stage) ? input.stage : 'iteration';
  const result = RESULT_SET.has(input.result) ? input.result : 'failed';
  const lockStatus = LOCK_STATUSES.has(input.lock_status) ? input.lock_status : 'unknown';
  const normalized = {
    schema_version: 1,
    outcome_id: `${sessionId}:${turnId}:${stage}`,
    session_id: sessionId,
    transcript_id: safeId(input.transcript_id, ''),
    turn_id: turnId,
    turn_sequence: safeInteger(input.turn_sequence),
    hook: safeId(input.hook, 'Stop'),
    stage,
    result,
    lock_status: lockStatus,
    duration_ms: safeInteger(input.duration_ms),
    occurred_at: safeTimestamp(input.occurred_at),
    reason: safeReason(input.reason),
  };
  if (!normalized.transcript_id) delete normalized.transcript_id;
  return normalized;
}

function readRawLedger(vaultBase) {
  const path = iterationOutcomePath(vaultBase);
  const checked = assertVaultPathSafe(vaultBase, path, {
    expectedType: 'file', label: 'SESSION_ITERATION_OUTCOMES.jsonl',
  });
  return checked.exists ? readFileSync(checked.target, 'utf8') : '';
}

function parseLedger(raw) {
  return String(raw || '').split('\n').filter(Boolean).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === 'object' ? [value] : [];
    } catch {
      return [];
    }
  });
}

export function readIterationOutcomes(vaultBase) {
  return parseLedger(readRawLedger(vaultBase));
}

function appendOnce(vaultBase, outcome, timeoutMs) {
  const path = iterationOutcomePath(vaultBase);
  const result = withVaultPathLock(vaultBase, path, () => {
    const raw = readRawLedger(vaultBase);
    const existing = parseLedger(raw);
    const duplicate = existing.find((entry) => entry.outcome_id === outcome.outcome_id);
    if (duplicate) {
      return { written: false, result: 'duplicate', reason: 'already-recorded', outcome: duplicate };
    }
    const separator = raw && !raw.endsWith('\n') ? '\n' : '';
    writeVaultFileAtomic(vaultBase, path, `${raw}${separator}${JSON.stringify(outcome)}\n`, 'utf8', {
      label: 'SESSION_ITERATION_OUTCOMES.jsonl',
    });
    return { written: true, result: outcome.result, reason: 'ok', outcome };
  }, { timeoutMs });
  if (result === VAULT_LOCK_BUSY) return null;
  return result;
}

export function appendIterationOutcome(vaultBase, input, {
  timeoutMs = 50,
  retries = 2,
} = {}) {
  const outcome = normalizeIterationOutcome(input);
  const maxAttempts = Math.max(1, Number(retries) + 1);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = appendOnce(vaultBase, outcome, timeoutMs);
    if (result) return result;
  }
  return {
    written: false,
    result: 'busy',
    reason: 'ledger-lock-busy',
    outcome: { ...outcome, result: 'busy', lock_status: 'busy' },
  };
}
