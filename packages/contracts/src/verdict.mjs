import { createHash } from 'node:crypto';

export function tasksHashOf(md) {
  return `sha256:${createHash('sha256').update(String(md).replace(/\r\n?/g, '\n')).digest('hex')}`;
}

export function evaluateVerdict(verdict, reqIds, {
  tasksHash, effectiveSpecHash, evidenceEnvelopeId, evidenceBinding,
} = {}) {
  const ids = reqIds || [];
  if (ids.length === 0 && !evidenceEnvelopeId) return { ok: true, missing: [] };
  if (!verdict || verdict.ok !== true) return { ok: false, missing: [] };
  if (evidenceEnvelopeId && verdict.evidenceEnvelopeId !== evidenceEnvelopeId) {
    return { ok: false, missing: [], stale: true };
  }
  if (evidenceBinding && (!verdict.evidenceBinding || Object.entries(evidenceBinding).some(
    ([key, value]) => verdict.evidenceBinding[key] !== value,
  ))) return { ok: false, missing: [], stale: true };
  if (ids.length === 0) return { ok: true, missing: [] };
  if (tasksHash && verdict.tasksHash && verdict.tasksHash !== tasksHash) {
    return { ok: false, missing: [], stale: true };
  }
  if (effectiveSpecHash && verdict.effectiveSpecHash && verdict.effectiveSpecHash !== effectiveSpecHash) {
    return { ok: false, missing: [], stale: true };
  }
  const covered = new Set((verdict.coverage || []).filter((item) => item.covered).map((item) => item.req));
  const missing = ids.filter((requirement) => !covered.has(requirement));
  return { ok: missing.length === 0, missing };
}
