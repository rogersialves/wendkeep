import { createHash } from 'node:crypto';
import { sanitizeObserverAuditMetadata } from './redaction.mjs';

const ROLE_CAPABILITIES = {
  viewer: new Set(['project:read', 'usage:summary:read', 'usage:breakdown:read', 'memory:metadata:read', 'sync:read']),
  auditor: new Set(['project:read', 'usage:summary:read', 'usage:breakdown:read', 'usage:calls:read', 'transcript:read', 'memory:metadata:read', 'memory:content:read', 'audit:read', 'sync:read']),
  publisher: new Set(['project:read', 'project:write', 'ingest:write', 'memory:write', 'snapshot:write', 'sync:write']),
  admin: new Set(['*']),
};

function scopeMatches(scopes, capability) {
  return scopes.includes('*') || scopes.includes(capability)
    || scopes.some((scope) => scope.endsWith(':*') && capability.startsWith(scope.slice(0, -1)));
}

export function authorizeObserverPrincipal(principal, { projectId, capability } = {}) {
  if (!principal?.ok) return { ok: false, status: 401, code: principal?.code || 'observer_auth_required' };
  if (!principal.project_ids?.includes('*') && !principal.project_ids?.includes(projectId)) {
    return { ok: false, status: 403, code: 'observer_project_forbidden' };
  }
  const grants = ROLE_CAPABILITIES[principal.role] || new Set();
  if (!grants.has('*') && !grants.has(capability)) return { ok: false, status: 403, code: 'observer_role_forbidden' };
  if (!scopeMatches(principal.scopes || [], capability)) return { ok: false, status: 403, code: 'observer_scope_forbidden' };
  return { ok: true, status: 200, code: 'observer_authorized' };
}

export function recordObserverAudit(db, {
  auditId, projectId, tokenId = '', capability, outcome, occurredAt = new Date().toISOString(), metadata = {},
} = {}) {
  const safeMetadata = sanitizeObserverAuditMetadata(metadata);
  const id = String(auditId || createHash('sha256').update(JSON.stringify({ projectId, tokenId, capability, outcome, occurredAt, safeMetadata })).digest('hex').slice(0, 32));
  const persistedTokenId = tokenId && db.prepare('SELECT token_id FROM observer_tokens WHERE token_id = ?').get(tokenId)
    ? tokenId
    : null;
  db.prepare(`INSERT OR IGNORE INTO observer_access_audit(audit_id, project_id, token_id, capability, outcome, occurred_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, projectId, persistedTokenId, capability, outcome, new Date(occurredAt).toISOString(), JSON.stringify(safeMetadata));
  return { audit_id: id, project_id: projectId, token_id: tokenId, capability, outcome, occurred_at: new Date(occurredAt).toISOString(), metadata: safeMetadata };
}
