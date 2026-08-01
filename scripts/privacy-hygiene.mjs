#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OBSERVABILITY_DIAGNOSTIC_ALLOWLIST = new Set([
  'PARENT_META_INVALID',
  'CHILD_MISSING',
  'CHILD_META_INVALID',
  'ROOT_MISMATCH',
  'LEGACY_CHAIN_UNPROVEN',
  'DUPLICATE_ROLLOUT_ID',
  'GRAPH_LIMIT_EXCEEDED',
  'FALLBACK_LIMIT_EXCEEDED',
  'LIVE_BYTE_BUDGET_EXCEEDED',
  'LIVE_DEADLINE_EXCEEDED',
  'SOURCE_CHANGED_DURING_SCAN',
  'CACHE_INVALID',
  'STALE_FRONTIER',
  'MAIN_TRANSCRIPT_UNRESOLVED',
]);

const SENSITIVE_FIELDS = new Set([
  'NOTE',
  'SID',
  'SUMMARY',
  'canonicalConversationId',
  'context',
  'contexto',
  'identifier',
  'message',
  'noteRel',
  'objective',
  'path',
  'pedido',
  'projectId',
  'project_id',
  'prompt',
  'rawMessage',
  'raw_message',
  'sessionId',
  'sessionRel',
  'session_id',
  'summary',
  'title',
  'transcriptId',
  'transcript_id',
  'vault',
  'vaultName',
]);

const PROMPT_OR_MESSAGE_FIELDS = new Set([
  'context',
  'contexto',
  'message',
  'objective',
  'pedido',
  'prompt',
  'rawMessage',
  'raw_message',
  'summary',
  'title',
]);

const SAFE_RELATIVE_SEGMENTS = new Set([
  '.brain',
  '03-Sessões',
  '03-Sessions',
]);

const MEMORY_FIXTURE_SOURCES = new Set([
  'tests/memory-handoff.test.mjs',
  'tests/memory-hybrid-e2e.test.mjs',
  'tests/session-stop-memory.test.mjs',
  'tests/fixtures/synthetic-memory-lifecycle.mjs',
]);

const CHANGE_PREFIX = '.WendKeep-vault/08-Mudanças/codex-subagent-observability/';
const GENERATED_INTEGRITY_FIELDS = new Map([
  ['tasksHash', 12],
  ['effectiveSpecHash', 64],
]);

function normalizeRelativePath(path) {
  return String(path).split(sep).join('/').replace(/^\.\//, '');
}

function finding(relativePath, line, category) {
  return `${normalizeRelativePath(relativePath)}:${Math.max(1, Number(line) || 1)}:${category}`;
}

function decodeLiteral(raw, quote) {
  if (quote === '"') {
    try { return JSON.parse(`${quote}${raw}${quote}`); } catch { return raw; }
  }
  return raw
    .replaceAll('\\\\', '\\')
    .replaceAll(`\\${quote}`, quote)
    .replaceAll('\\n', '\n')
    .replaceAll('\\r', '\r')
    .replaceAll('\\t', '\t');
}

function literalsOnLine(line) {
  const literals = [];
  const pattern = /(["'`])((?:\\.|(?!\1).)*)\1/g;
  for (const match of line.matchAll(pattern)) {
    literals.push({
      column: match.index ?? 0,
      value: decodeLiteral(match[2], match[1]),
    });
  }
  return literals;
}

function allowedFixtureValue(value) {
  if (!value) return true;
  if (/^\[wk-fixture\]/.test(value)) return true;
  if (/^\.?wk-fixture-[a-z0-9-]+(?:\.[a-z0-9]+)?$/i.test(value)) return true;

  const segments = value.split(/[\\/]/).filter(Boolean);
  return segments.length > 0 && segments.every((segment) => (
    SAFE_RELATIVE_SEGMENTS.has(segment)
    || /^\.?wk-fixture-[a-z0-9-]+(?:\.[a-z0-9]+)?$/i.test(segment)
  ));
}

function fieldBefore(line, column) {
  const prefix = line.slice(0, column);
  const match = prefix.match(/(?:^\s*|[,{;]\s*|\bconst\s+)["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*[:=]\s*$/);
  return match?.[1] ?? '';
}

function allowedGeneratedIntegrityHash(relativePath, field, value) {
  const expectedLength = GENERATED_INTEGRITY_FIELDS.get(field);
  if (!expectedLength) return false;
  const path = normalizeRelativePath(relativePath);
  return path.startsWith(CHANGE_PREFIX)
    && /\/(?:verificacao|verdict)\.json$/i.test(path)
    && String(value).length === expectedLength
    && /^[0-9a-f]+$/i.test(String(value));
}

function allowedGeneratedEvidence(relativePath, field, value) {
  const path = normalizeRelativePath(relativePath);
  if (field !== 'evidence'
    || !path.startsWith(CHANGE_PREFIX)
    || !/\/verdict\.json$/i.test(path)) return false;
  const references = String(value).split('; ');
  return references.length > 0 && references.every((reference) => (
    /^(?:tests|hooks|src|scripts|packages|docs)\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:mjs|js|json|md):[1-9]\d*$/.test(reference)
  ));
}

function allowedSyntheticLifecyclePath(relativePath, value) {
  if (!MEMORY_FIXTURE_SOURCES.has(normalizeRelativePath(relativePath))) return false;
  const expanded = String(value).replaceAll(
    '${SYNTHETIC_MEMORY.changeSlug}',
    'wk-fixture-example-change',
  );
  if (expanded.includes('${')) return false;
  return /^04-Decisões\/ADR-\d{4}-wk-fixture-[a-z0-9-]+\.md$/i.test(expanded)
    || /^08-Mudanças\/_arquivo\/wk-fixture-[a-z0-9-]+\/verdict\.json$/i.test(expanded);
}

function structuralCategories(value) {
  const categories = [];
  const text = String(value ?? '');
  if (/^[A-Za-z]:[\\/]/.test(text)
    || /^\/(?:Users|home)\//.test(text)
    || /^\\\\[^\\/]+[\\/][^\\/]+/.test(text)) {
    categories.push('absolute-local-path');
  }
  if (/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i.test(text)
    || /\b[0-9a-f]{24,}\b/i.test(text)
    || /\b[A-Za-z0-9_-]{32,}\b/.test(text)) {
    if (!allowedFixtureValue(text)) categories.push('opaque-identifier');
  }
  return categories;
}

function categoriesForLiteral(value, field, relativePath) {
  const categories = structuralCategories(value).filter((category) => (
    category !== 'opaque-identifier'
    || (!allowedGeneratedIntegrityHash(relativePath, field, value)
      && !allowedGeneratedEvidence(relativePath, field, value))
  ));
  const approvedFixtureValue = allowedFixtureValue(value)
    || allowedSyntheticLifecyclePath(relativePath, value);
  if (SENSITIVE_FIELDS.has(field) && !approvedFixtureValue) {
    categories.push('unapproved-fixture-value');
    if (PROMPT_OR_MESSAGE_FIELDS.has(field)) categories.push('prompt-or-message-content');
  }
  return categories;
}

function unescapedBackticks(line) {
  let found = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== '`') continue;
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) slashes += 1;
    if (slashes % 2 === 0) found += 1;
  }
  return found;
}

function staticDiagnosticCode(line) {
  const match = line.match(/\bcode\s*:\s*["']([A-Z][A-Z0-9_]+)["']/);
  return match?.[1] ?? '';
}

function staticDiagnosticFields(line) {
  const object = line.match(/\{\s*code\s*:[^}]*\}/)?.[0] ?? '';
  if (!object) return [];
  return [...object.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((match) => match[1]);
}

export function inspectFixtureSource(relativePath, source) {
  const findings = new Set();
  const lines = String(source).replaceAll('\r\n', '\n').split('\n');
  let insideTemplate = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const code = staticDiagnosticCode(line);
    if (code && !OBSERVABILITY_DIAGNOSTIC_ALLOWLIST.has(code)) {
      findings.add(finding(relativePath, index + 1, 'diagnostic-code-not-allowlisted'));
    }
    const diagnosticFields = staticDiagnosticFields(line);
    if (diagnosticFields.some((field) => field !== 'code' && field !== 'count')) {
      findings.add(finding(relativePath, index + 1, 'diagnostic-unapproved-field'));
    }
    if (diagnosticFields.some((field) => PROMPT_OR_MESSAGE_FIELDS.has(field))) {
      findings.add(finding(relativePath, index + 1, 'diagnostic-prompt-or-message'));
    }
    if (insideTemplate) {
      for (const category of structuralCategories(line)) {
        findings.add(finding(relativePath, index + 1, category));
      }
    }
    for (const literal of literalsOnLine(line)) {
      const field = fieldBefore(line, literal.column);
      for (const category of categoriesForLiteral(literal.value, field, relativePath)) {
        findings.add(finding(relativePath, index + 1, category));
      }
    }
    if (unescapedBackticks(line) % 2 === 1) insideTemplate = !insideTemplate;
  }
  return [...findings].sort();
}

export function inspectDiagnosticRecords(relativePath, records) {
  if (!Array.isArray(records)) {
    return [finding(relativePath, 1, 'diagnostic-invalid-shape')];
  }

  const findings = new Set();
  records.forEach((record, index) => {
    const line = index + 1;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      findings.add(finding(relativePath, line, 'diagnostic-invalid-shape'));
      return;
    }

    const keys = Object.keys(record);
    if (keys.some((key) => key !== 'code' && key !== 'count')) {
      findings.add(finding(relativePath, line, 'diagnostic-unapproved-field'));
    }
    if (!OBSERVABILITY_DIAGNOSTIC_ALLOWLIST.has(record.code)) {
      findings.add(finding(relativePath, line, 'diagnostic-code-not-allowlisted'));
    }
    if (!Number.isSafeInteger(record.count) || record.count < 0) {
      findings.add(finding(relativePath, line, 'diagnostic-invalid-count'));
    }

    for (const [key, value] of Object.entries(record)) {
      for (const category of structuralCategories(value)) {
        findings.add(finding(relativePath, line, category));
      }
      if (PROMPT_OR_MESSAGE_FIELDS.has(key)) {
        findings.add(finding(relativePath, line, 'diagnostic-prompt-or-message'));
      }
    }
  });
  return [...findings].sort();
}

export function inspectStagedDiff(diff) {
  const findings = new Set();
  let relativePath = '';
  let destinationLine = 0;

  for (const line of String(diff).replaceAll('\r\n', '\n').split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      relativePath = target === '/dev/null' ? '' : target.replace(/^b\//, '');
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      destinationLine = Number(hunk[1]);
      continue;
    }
    if (!relativePath || line.startsWith('diff --git ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) {
      for (const item of inspectFixtureSource(relativePath, line.slice(1))) {
        const category = item.slice(item.lastIndexOf(':') + 1);
        findings.add(finding(relativePath, destinationLine, category));
      }
      destinationLine += 1;
      continue;
    }
    if (!line.startsWith('-') && !line.startsWith('\\')) destinationLine += 1;
  }

  return [...findings].sort();
}

function walkFiles(root, directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(root, absolute));
    else if (entry.isFile()) files.push(normalizeRelativePath(relative(root, absolute)));
  }
  return files;
}

function isPrivacySurface(relativePath) {
  const path = normalizeRelativePath(relativePath);
  const changeArtifact = path.startsWith(CHANGE_PREFIX)
    && /\/(?:evidencia|verificacao|verdict)\.json$/i.test(path);
  return MEMORY_FIXTURE_SOURCES.has(path)
    || /^tests\/fixtures\/.*(?:observability|subagent).*$/i.test(path)
    || changeArtifact
    || /^\.github\/(?:PULL_REQUEST_TEMPLATE|ISSUE_TEMPLATE)(?:\/|\.|$)/i.test(path)
    || /^(?:RELEASE_NOTES|release-notes)(?:\.|$)/.test(path);
}

export function repositoryPrivacySources(root) {
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (listed.status !== 0) return [];

  const discovered = listed.stdout.split('\0').filter(Boolean);
  const changeFiles = walkFiles(root, join(root, ...CHANGE_PREFIX.slice(0, -1).split('/')));
  return [...new Set([...discovered, ...changeFiles].filter(isPrivacySurface))].sort();
}

export function scanRepositoryPrivacy(root) {
  const findings = new Set();
  for (const relativePath of repositoryPrivacySources(root)) {
    try {
      const source = readFileSync(join(root, ...relativePath.split('/')), 'utf8');
      for (const item of inspectFixtureSource(relativePath, source)) findings.add(item);
    } catch {
      findings.add(finding(relativePath, 1, 'scan-read-error'));
    }
  }

  const staged = spawnSync('git', ['diff', '--cached', '--no-ext-diff', '--unified=0', '--'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (staged.status !== 0) findings.add(finding('git-staged-diff', 1, 'scan-read-error'));
  else for (const item of inspectStagedDiff(staged.stdout)) findings.add(item);
  return [...findings].sort();
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const root = resolve(dirname(currentFile), '..');
  const findings = scanRepositoryPrivacy(root);
  if (findings.length) {
    process.stderr.write(`${findings.join('\n')}\n`);
    process.exitCode = 1;
  }
}
