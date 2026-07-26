import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_SOURCES = new Set([
  'tests/memory-handoff.test.mjs',
  'tests/memory-hybrid-e2e.test.mjs',
  'tests/session-stop-memory.test.mjs',
  'tests/fixtures/synthetic-memory-lifecycle.mjs',
]);

const SENSITIVE_FIELDS = new Set([
  'NOTE',
  'SID',
  'SUMMARY',
  'canonicalConversationId',
  'context',
  'contexto',
  'message',
  'noteRel',
  'objective',
  'pedido',
  'projectId',
  'project_id',
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

const SAFE_RELATIVE_SEGMENTS = new Set([
  '.brain',
  '03-Sessões',
  '03-Sessions',
]);

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
      raw: match[0],
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

function sensitiveFieldBefore(line, column) {
  const prefix = line.slice(0, column);
  const match = prefix.match(/(?:^|[,{;]\s*|\bconst\s+)["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*[:=]\s*$/);
  return match && SENSITIVE_FIELDS.has(match[1]) ? match[1] : '';
}

function structuralCategories(value) {
  const categories = [];
  if (/^[A-Za-z]:[\\/]/.test(value)
    || /^\/(?:Users|home)\//.test(value)
    || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value)) {
    categories.push('absolute-local-path');
  }
  if (/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i.test(value)
    || /\b[0-9a-f]{24,}\b/i.test(value)
    || /\b[A-Za-z0-9_-]{32,}\b/.test(value)) {
    if (!allowedFixtureValue(value)) categories.push('opaque-identifier');
  }
  return categories;
}

function categoriesForLiteral(value, field) {
  const categories = structuralCategories(value);
  if (field && !allowedFixtureValue(value)) categories.push('unapproved-fixture-value');
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

export function inspectFixtureSource(relativePath, source) {
  const findings = new Set();
  const lines = String(source).replaceAll('\r\n', '\n').split('\n');
  let insideTemplate = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (insideTemplate) {
      for (const category of structuralCategories(line)) {
        findings.add(`${relativePath}:${index + 1}:${category}`);
      }
    }
    for (const literal of literalsOnLine(line)) {
      const field = sensitiveFieldBefore(line, literal.column);
      for (const category of categoriesForLiteral(literal.value, field)) {
        findings.add(`${relativePath}:${index + 1}:${category}`);
      }
    }
    if (unescapedBackticks(line) % 2 === 1) insideTemplate = !insideTemplate;
  }
  return [...findings].sort();
}

function repositoryFixtureSources() {
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout.split('\0').filter((relativePath) => FIXTURE_SOURCES.has(relativePath));
}

function runtimeSamples() {
  const slash = '\\';
  return {
    homePath: ['C:', slash, 'Users', slash, 'consumer-placeholder', slash, 'repo'].join(''),
    uncPath: [slash, slash, 'server', slash, 'share', slash, 'repo'].join(''),
    opaqueId: ['11111111', '2222', '3333', '4444', '555555555555'].join('-'),
    consumerLabel: ['consumer', 'placeholder'].join('-'),
  };
}

test('[req:MEM-STOP-7] privacy scanner rejects local paths and unapproved identifiers', () => {
  const sample = runtimeSamples();
  const source = [
    `const home = ${JSON.stringify(sample.homePath)};`,
    `const network = ${JSON.stringify(sample.uncPath)};`,
    `const SID = ${JSON.stringify(sample.opaqueId)};`,
    `const projectId = ${JSON.stringify(sample.consumerLabel)};`,
    'const note = `',
    sample.homePath,
    '`;',
  ].join('\n');

  assert.deepEqual(inspectFixtureSource('virtual.test.mjs', source), [
    'virtual.test.mjs:1:absolute-local-path',
    'virtual.test.mjs:2:absolute-local-path',
    'virtual.test.mjs:3:opaque-identifier',
    'virtual.test.mjs:3:unapproved-fixture-value',
    'virtual.test.mjs:4:unapproved-fixture-value',
    'virtual.test.mjs:6:absolute-local-path',
  ]);
});

test('[req:MEM-STOP-7] privacy scanner accepts only the synthetic fixture namespace', () => {
  const source = [
    "const projectId = 'wk-fixture-example-project';",
    "const sessionRel = '03-Sessões/wk-fixture-example-session.md';",
    "const summary = '[wk-fixture] artificial lifecycle summary';",
  ].join('\n');

  assert.deepEqual(inspectFixtureSource('virtual.test.mjs', source), []);
});

test('[req:MEM-STOP-7] privacy diagnostics never disclose rejected values', () => {
  const sample = runtimeSamples();
  const source = `const projectId = ${JSON.stringify(sample.consumerLabel)};`;
  const report = inspectFixtureSource('virtual.test.mjs', source).join('\n');

  assert.equal(report, 'virtual.test.mjs:1:unapproved-fixture-value');
  assert.equal(report.includes(sample.consumerLabel), false);
});

test('[req:MEM-STOP-7] versioned memory lifecycle fixtures contain only synthetic data', () => {
  const findings = repositoryFixtureSources().flatMap((relativePath) => (
    inspectFixtureSource(relativePath, readFileSync(join(ROOT, relativePath), 'utf8'))
  ));
  if (findings.length) throw new Error(findings.join('\n'));
});
