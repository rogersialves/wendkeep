const IMPLEMENTATION_TYPES = new Set(['feat', 'fix', 'refactor', 'perf']);
const EVIDENCE_STATUSES = new Set(['fresh', 'verified']);
const EVIDENCE_KINDS = new Set(['adr', 'design', 'evidence', 'receipt', 'spec', 'task', 'verdict']);

const PRIVATE_PATH = /(?:^|[\\/])(?:\.[^\\/\s]+-vault|\.brain|02-Sess(?:ões|oes|ions)|SESSION_REGISTRY\.json)(?:[\\/]|$)/i;
const ABSOLUTE_PATH = /(?:^|[\s"'=(])(?:[a-z]:[\\/]|\\\\[^\\/]|\/(?!\/))/i;
const SECRET_PATTERNS = [
  /\b(?:gh[oprsu]|github_pat)_[A-Za-z0-9_]{16,}\b/,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{12,}/i,
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*\S+/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/,
  /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/,
  /(?:\+55\s*\(?\d{2}\)?\s*9\d{4}[-\s]\d{4}|\(\d{2}\)\s*9?\d{4}-\d{4})/,
];

export class CommitPolicyError extends Error {
  constructor(message, code = 'WENDKEEP_COMMIT_POLICY') {
    super(message);
    this.name = 'CommitPolicyError';
    this.code = code;
  }
}

function text(value, field, { required = true, max = 500 } = {}) {
  if (typeof value !== 'string') {
    if (!required && (value === undefined || value === null)) return '';
    throw new CommitPolicyError(`${field} must be a string`);
  }
  const normalized = value.trim().replace(/\r\n?/g, '\n');
  if (required && !normalized) throw new CommitPolicyError(`${field} is required`);
  if (normalized.includes('\n')) throw new CommitPolicyError(`${field} must be a single line`);
  if (normalized.length > max) throw new CommitPolicyError(`${field} exceeds ${max} characters`);
  assertPublicText(normalized, field);
  return normalized;
}

export function assertPublicText(value, field = 'value') {
  const source = String(value ?? '');
  if (PRIVATE_PATH.test(source) || ABSOLUTE_PATH.test(source)) {
    throw new CommitPolicyError(`${field} contains a private or absolute path`, 'WENDKEEP_COMMIT_PRIVATE_PATH');
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(source))) {
    throw new CommitPolicyError(`${field} contains a possible secret`, 'WENDKEEP_COMMIT_SECRET');
  }
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, 'en'));
}

function assertKnownFields(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new CommitPolicyError(`${field} has unsupported field(s): ${unknown.join(', ')}`);
}

function stringList(value, field, { required = true } = {}) {
  if (!Array.isArray(value)) throw new CommitPolicyError(`${field} must be an array`);
  const normalized = uniqueSorted(value.map((item, index) => text(item, `${field}[${index}]`)));
  if (required && !normalized.length) throw new CommitPolicyError(`${field} must not be empty`);
  return normalized;
}

function normalizeSubject(subject) {
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)) {
    throw new CommitPolicyError('subject must be an object');
  }
  assertKnownFields(subject, ['type', 'scope', 'summary'], 'subject');
  const type = text(subject.type, 'subject.type').toLowerCase();
  if (!IMPLEMENTATION_TYPES.has(type)) {
    throw new CommitPolicyError(`subject.type must be one of ${[...IMPLEMENTATION_TYPES].join(', ')}`);
  }
  const scope = text(subject.scope, 'subject.scope', { required: false, max: 40 });
  if (scope && !/^[a-z0-9][a-z0-9._/-]*$/.test(scope)) {
    throw new CommitPolicyError('subject.scope must use lowercase Conventional Commit characters');
  }
  const summary = text(subject.summary, 'subject.summary', { max: 120 });
  if (/\.$/.test(summary)) throw new CommitPolicyError('subject.summary must not end with a period');
  return { type, ...(scope ? { scope } : {}), summary };
}

function normalizeEvidence(value, { resolved = true } = {}) {
  if (!Array.isArray(value) || !value.length) {
    throw new CommitPolicyError('evidence must be a non-empty array');
  }
  const normalized = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new CommitPolicyError(`evidence[${index}] must be an object`);
    }
    assertKnownFields(item, resolved ? ['kind', 'ref', 'status'] : ['kind', 'ref'], `evidence[${index}]`);
    const kind = text(item.kind, `evidence[${index}].kind`).toLowerCase();
    const ref = text(item.ref, `evidence[${index}].ref`);
    if (!EVIDENCE_KINDS.has(kind)) throw new CommitPolicyError(`evidence[${index}].kind is unsupported`);
    if (!resolved) return { kind, ref };
    const status = text(item.status, `evidence[${index}].status`).toLowerCase();
    if (!EVIDENCE_STATUSES.has(status)) {
      throw new CommitPolicyError(`evidence[${index}].status must be derived as fresh or verified`);
    }
    return { kind, ref, status };
  });
  const keyed = new Map(normalized.map((item) => [`${item.status || ''}\0${item.kind}\0${item.ref}`, item]));
  return [...keyed.values()].sort((a, b) => (
    `${a.status}\0${a.kind}\0${a.ref}`.localeCompare(`${b.status}\0${b.kind}\0${b.ref}`, 'en')
  ));
}

function normalizeStagedDiff(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CommitPolicyError('staged_diff must be an object');
  }
  assertKnownFields(value, ['sha256', 'files'], 'staged_diff');
  const sha256 = text(value.sha256, 'staged_diff.sha256').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new CommitPolicyError('staged_diff.sha256 must be a SHA-256 digest');
  const files = stringList(value.files, 'staged_diff.files').map((file) => file.replaceAll('\\', '/'));
  for (const [index, file] of files.entries()) assertPublicText(file, `staged_diff.files[${index}]`);
  return { sha256, files: uniqueSorted(files) };
}

function normalizeIdentity(value) {
  if (!value) return { agent: '' };
  if (typeof value !== 'object' || Array.isArray(value)) throw new CommitPolicyError('identity must be an object');
  assertKnownFields(value, ['agent'], 'identity');
  const agent = text(value.agent, 'identity.agent', { required: false, max: 80 });
  return { agent };
}

function normalizeAuthority(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CommitPolicyError('authority must be an object');
  }
  const kind = text(value.kind, 'authority.kind').toLowerCase();
  if (kind === 'adr') {
    assertKnownFields(value, ['kind', 'adr', 'ref', 'issue'], 'authority');
    const adr = text(value.adr, 'authority.adr').toUpperCase();
    if (!/^ADR-\d{4,}$/.test(adr)) throw new CommitPolicyError('authority.adr must match ADR-NNNN');
    const ref = text(value.ref, 'authority.ref').replaceAll('\\', '/');
    const issue = text(value.issue, 'authority.issue', { required: false, max: 40 });
    if (issue && !/^#\d+$/.test(issue)) throw new CommitPolicyError('authority.issue must match #NNN');
    return { kind, adr, ref, ...(issue ? { issue } : {}) };
  }
  if (kind === 'native') {
    assertKnownFields(value, ['kind', 'issue', 'design'], 'authority');
    const issue = text(value.issue, 'authority.issue', { max: 40 });
    if (!/^#\d+$/.test(issue)) throw new CommitPolicyError('authority.issue must match #NNN');
    const design = text(value.design, 'authority.design').replaceAll('\\', '/');
    const segments = design.split('/');
    if (!/^(?:docs\/superpowers\/specs|plans)\/[a-zA-Z0-9._/-]+\.md$/.test(design)
      || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new CommitPolicyError('authority.design must be a versioned design under docs/superpowers/specs or plans');
    }
    return { kind, issue, design };
  }
  throw new CommitPolicyError('authority.kind must be adr or native');
}

export function normalizeCommitInput(input, { resolved = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CommitPolicyError('commit input must be an object');
  }
  assertKnownFields(input, [
    'schema_version', 'subject', 'capability', 'authority', 'staged_diff',
    'evidence', ...(resolved ? ['tasks', 'tests'] : []), 'limits', 'identity',
  ], 'commit input');
  if (input.schema_version !== 1) throw new CommitPolicyError('schema_version must be 1');
  return {
    schema_version: 1,
    subject: normalizeSubject(input.subject),
    capability: text(input.capability, 'capability'),
    authority: normalizeAuthority(input.authority),
    staged_diff: normalizeStagedDiff(input.staged_diff),
    evidence: normalizeEvidence(input.evidence, { resolved }),
    ...(resolved ? {
      tasks: stringList(input.tasks, 'tasks'),
      tests: stringList(input.tests, 'tests'),
    } : {}),
    limits: stringList(input.limits ?? [], 'limits', { required: false }),
    identity: normalizeIdentity(input.identity),
  };
}

export const COMMIT_INPUT_SCHEMA_VERSION = 1;
