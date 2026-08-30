import { createHash, randomBytes } from 'node:crypto';

const ROLES = new Set(['viewer', 'auditor', 'publisher', 'admin']);

export function hashObserverToken(token) {
  const value = String(token || '');
  if (!value) throw Object.assign(new Error('token vazio.'), { code: 'observer_token_invalid' });
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function json(value) { return JSON.stringify(value); }
function parse(value) { try { return JSON.parse(value || '[]'); } catch { return []; } }
function validTime(value, field) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw Object.assign(new Error(`${field} inválido.`), { code: 'observer_token_invalid' });
  return parsed.toISOString();
}

export function registerObserverToken(db, {
  tokenId = randomBytes(12).toString('hex'), token, role, projectIds = [], scopes = [],
  createdAt = new Date().toISOString(), expiresAt, rotatedFrom = null,
} = {}) {
  if (!ROLES.has(role)) throw Object.assign(new Error('role inválida.'), { code: 'observer_role_invalid' });
  if (!Array.isArray(projectIds) || projectIds.length === 0) throw Object.assign(new Error('projectIds é obrigatório.'), { code: 'observer_projects_invalid' });
  if (!Array.isArray(scopes) || scopes.length === 0) throw Object.assign(new Error('scopes é obrigatório.'), { code: 'observer_scopes_invalid' });
  const row = {
    token_id: String(tokenId), token_hash: hashObserverToken(token), role,
    project_ids_json: json([...new Set(projectIds.map(String))].sort()),
    scopes_json: json([...new Set(scopes.map(String))].sort()),
    created_at: validTime(createdAt, 'createdAt'), expires_at: validTime(expiresAt, 'expiresAt'),
    revoked_at: null, rotated_from: rotatedFrom ? String(rotatedFrom) : null,
  };
  db.prepare(`INSERT INTO observer_tokens(token_id, token_hash, role, project_ids_json, scopes_json, created_at, expires_at, revoked_at, rotated_from)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...Object.values(row));
  return { token_id: row.token_id, role, project_ids: parse(row.project_ids_json), scopes: parse(row.scopes_json), expires_at: row.expires_at, rotated_from: row.rotated_from };
}

export function resolveObserverPrincipal(db, token, { now = new Date().toISOString() } = {}) {
  let tokenHash;
  try { tokenHash = hashObserverToken(token); } catch { return { ok: false, code: 'observer_token_missing' }; }
  const row = db.prepare('SELECT * FROM observer_tokens WHERE token_hash = ?').get(tokenHash);
  if (!row) return { ok: false, code: 'observer_token_invalid' };
  const timestamp = new Date(now).getTime();
  if (row.revoked_at && new Date(row.revoked_at).getTime() <= timestamp) return { ok: false, code: 'observer_token_revoked', token_id: row.token_id };
  if (new Date(row.expires_at).getTime() <= timestamp) return { ok: false, code: 'observer_token_expired', token_id: row.token_id };
  return {
    ok: true, token_id: row.token_id, role: row.role,
    project_ids: parse(row.project_ids_json), scopes: parse(row.scopes_json), expires_at: row.expires_at,
  };
}

export function ensureObserverBootstrapToken(db, {
  token, tokenId = '', role, projectIds = [], scopes = [], expiresAt, createdAt = new Date().toISOString(), now = createdAt,
} = {}) {
  const tokenHash = hashObserverToken(token);
  const existing = db.prepare('SELECT * FROM observer_tokens WHERE token_hash = ?').get(tokenHash);
  if (existing) {
    const expired = new Date(existing.expires_at).getTime() <= new Date(validTime(now, 'now')).getTime();
    return {
      created: false,
      token_id: existing.token_id,
      role: existing.role,
      project_ids: parse(existing.project_ids_json),
      scopes: parse(existing.scopes_json),
      expires_at: existing.expires_at,
      revoked: Boolean(existing.revoked_at),
      expired,
    };
  }
  if (!Array.isArray(projectIds) || projectIds.length === 0 || projectIds.includes('*')) {
    throw Object.assign(new Error('bootstrap exige projectIds explícitos e não aceita wildcard.'), { code: 'observer_bootstrap_projects_invalid' });
  }
  const normalizedExpiry = validTime(expiresAt, 'expiresAt');
  if (new Date(normalizedExpiry).getTime() <= new Date(validTime(now, 'now')).getTime()) {
    throw Object.assign(new Error('bootstrap exige expiração futura.'), { code: 'observer_bootstrap_expired' });
  }
  const id = String(tokenId || `bootstrap-${tokenHash.slice(-24)}`);
  if (db.prepare('SELECT token_id FROM observer_tokens WHERE token_id = ?').get(id)) {
    throw Object.assign(new Error('tokenId de bootstrap já pertence a outra credencial.'), { code: 'observer_bootstrap_token_id_conflict' });
  }
  return {
    created: true,
    ...registerObserverToken(db, {
      tokenId: id,
      token,
      role,
      projectIds,
      scopes,
      createdAt,
      expiresAt: normalizedExpiry,
    }),
    revoked: false,
    expired: false,
  };
}

export function revokeObserverToken(db, { tokenId, revokedAt = new Date().toISOString() } = {}) {
  const result = db.prepare('UPDATE observer_tokens SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL')
    .run(validTime(revokedAt, 'revokedAt'), String(tokenId || ''));
  return { token_id: String(tokenId || ''), revoked: Number(result.changes) > 0 };
}

export function rotateObserverToken(db, {
  tokenId, newTokenId, newToken, rotatedAt = new Date().toISOString(), expiresAt,
} = {}) {
  const current = db.prepare('SELECT * FROM observer_tokens WHERE token_id = ?').get(String(tokenId || ''));
  if (!current || current.revoked_at) throw Object.assign(new Error('token não pode ser rotacionado.'), { code: 'observer_token_rotation_invalid' });
  db.exec('BEGIN IMMEDIATE');
  try {
    revokeObserverToken(db, { tokenId, revokedAt: rotatedAt });
    const created = registerObserverToken(db, {
      tokenId: newTokenId, token: newToken, role: current.role,
      projectIds: parse(current.project_ids_json), scopes: parse(current.scopes_json),
      createdAt: rotatedAt, expiresAt, rotatedFrom: tokenId,
    });
    db.exec('COMMIT');
    return created;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
