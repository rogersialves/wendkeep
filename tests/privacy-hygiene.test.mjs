import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectDiagnosticRecords,
  inspectFixtureSource,
  inspectStagedDiff,
  repositoryPrivacySources,
} from '../scripts/privacy-hygiene.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

test('[req:OBS-14] sensor schema fields are public config without bypassing unknown fields', () => {
  const sample = runtimeSamples();
  const longCommand = [
    'node --test tests/memory-activation.test.mjs',
    ' tests/session-stop-',
    'migration-lifecycle.test.mjs',
  ].join('');
  const sensor = {
    id: 'session-causality',
    name: 'Session causality',
    description: longCommand,
    severity: 'critical',
    type: 'command',
    command: longCommand,
  };

  assert.deepEqual(inspectFixtureSource(
    'wendkeep.sensors.json',
    JSON.stringify(sensor, null, 2),
  ), []);
  assert.deepEqual(inspectFixtureSource(
    'wendkeep.sensors.json',
    JSON.stringify({
      ...sensor,
      description: `Session causality ${sample.opaqueId}`,
      command: `node --test --session ${sample.opaqueId}`,
    }, null, 2),
  ), [
    'wendkeep.sensors.json:4:opaque-identifier',
    'wendkeep.sensors.json:7:opaque-identifier',
  ]);
  assert.deepEqual(inspectFixtureSource(
    'wendkeep.sensors.json',
    JSON.stringify({ ...sensor, session_id: sample.opaqueId }, null, 2),
  ), [
    'wendkeep.sensors.json:8:opaque-identifier',
    'wendkeep.sensors.json:8:unapproved-fixture-value',
  ]);
});

test('[req:MEM-STOP-7] privacy diagnostics never disclose rejected values', () => {
  const sample = runtimeSamples();
  const source = `const projectId = ${JSON.stringify(sample.consumerLabel)};`;
  const report = inspectFixtureSource('virtual.test.mjs', source).join('\n');

  assert.equal(report, 'virtual.test.mjs:1:unapproved-fixture-value');
  assert.equal(report.includes(sample.consumerLabel), false);
});

test('[req:MEM-STOP-7] versioned memory lifecycle fixtures contain only synthetic data', () => {
  const findings = repositoryPrivacySources(ROOT).flatMap((relativePath) => (
    inspectFixtureSource(relativePath, readFileSync(join(ROOT, relativePath), 'utf8'))
  ));
  if (findings.length) throw new Error(findings.join('\n'));
});

test('[req:OBS-14] generated verification hashes are allowed only in their structural fields', () => {
  const contentHash = 'a'.repeat(64);
  const generated = JSON.stringify({
    tasksHash: 'b'.repeat(12),
    effectiveSpecHash: contentHash,
  }, null, 2);

  assert.deepEqual(inspectFixtureSource(
    '.WendKeep-vault/08-Mudanças/codex-subagent-observability/verificacao.json',
    generated,
  ), []);
  assert.deepEqual(inspectFixtureSource(
    '.WendKeep-vault/08-Mudanças/codex-subagent-observability/evidencia.json',
    JSON.stringify({ transcriptId: contentHash }, null, 2),
  ), [
    '.WendKeep-vault/08-Mudanças/codex-subagent-observability/evidencia.json:2:opaque-identifier',
    '.WendKeep-vault/08-Mudanças/codex-subagent-observability/evidencia.json:2:unapproved-fixture-value',
  ]);
});

test('[req:OBS-14] generated verdict evidence allows only relative source locations', () => {
  const verdictPath = '.WendKeep-vault/08-Mudanças/codex-subagent-observability/verdict.json';
  const evidence = [
    'tests/session-observability-reconciliation.test.mjs:267',
    'hooks/session-observability.mjs:640',
  ].join('; ');

  assert.deepEqual(inspectFixtureSource(
    verdictPath,
    JSON.stringify({ evidence }, null, 2),
  ), []);
  assert.deepEqual(inspectFixtureSource(
    verdictPath,
    JSON.stringify({ evidence: `tests/${'a'.repeat(40)}` }, null, 2),
  ), [`${verdictPath}:2:opaque-identifier`]);
});

test('[req:MEM-STOP-7] lifecycle paths allow only the declared synthetic interpolation', () => {
  const interpolation = ['${', 'SYNTHETIC_MEMORY.changeSlug', '}'].join('');
  const privateInterpolation = ['${', 'runtimeProject.changeSlug', '}'].join('');
  const syntheticSource = [
    `const evidence = { path: \`04-Decisões/ADR-0001-${interpolation}.md\` };`,
    `const verdict = { path: \`08-Mudanças/_arquivo/${interpolation}/verdict.json\` };`,
  ].join('\n');

  assert.deepEqual(inspectFixtureSource('tests/memory-handoff.test.mjs', syntheticSource), []);
  assert.deepEqual(inspectFixtureSource(
    'tests/memory-handoff.test.mjs',
    `const evidence = { path: \`04-Decisões/ADR-0001-${privateInterpolation}.md\` };`,
  ), ['tests/memory-handoff.test.mjs:1:unapproved-fixture-value']);
});

test('[req:OBS-14] diagnostics reject unknown codes, extra fields and sensitive values', () => {
  const sample = runtimeSamples();
  const pathField = ['pa', 'th'].join('');
  const promptField = ['pro', 'mpt'].join('');
  const sessionField = ['session', 'Id'].join('');
  const records = [
    { code: ['NOT', 'ALLOWLISTED'].join('_'), count: 1 },
    { code: 'CHILD_MISSING', count: 1, [pathField]: sample.homePath },
    { code: 'CHILD_MISSING', count: 1, [promptField]: ['raw', ' prompt'].join('') },
    { code: 'CHILD_MISSING', count: 1, [sessionField]: sample.opaqueId },
  ];

  assert.deepEqual(inspectDiagnosticRecords('virtual.json', records), [
    'virtual.json:1:diagnostic-code-not-allowlisted',
    'virtual.json:2:absolute-local-path',
    'virtual.json:2:diagnostic-unapproved-field',
    'virtual.json:3:diagnostic-prompt-or-message',
    'virtual.json:3:diagnostic-unapproved-field',
    'virtual.json:4:diagnostic-unapproved-field',
    'virtual.json:4:opaque-identifier',
  ]);
});

test('[req:OBS-14] staged diff scans only added content and reports destination line numbers', () => {
  const sample = runtimeSamples();
  const diff = [
    'diff --git a/tests/fixtures/wk-fixture-observability.mjs b/tests/fixtures/wk-fixture-observability.mjs',
    '--- a/tests/fixtures/wk-fixture-observability.mjs',
    '+++ b/tests/fixtures/wk-fixture-observability.mjs',
    '@@ -1,2 +1,2 @@',
    `-const projectId = ${JSON.stringify(sample.consumerLabel)};`,
    "+const projectId = 'wk-fixture-example-project';",
    `+const transcriptId = ${JSON.stringify(sample.opaqueId)};`,
  ].join('\n');

  assert.deepEqual(inspectStagedDiff(diff), [
    'tests/fixtures/wk-fixture-observability.mjs:2:opaque-identifier',
    'tests/fixtures/wk-fixture-observability.mjs:2:unapproved-fixture-value',
  ]);
});

test('[req:OBS-14] every privacy diagnostic is redacted to file line and category', () => {
  const sample = runtimeSamples();
  const pathField = ['pa', 'th'].join('');
  const report = [
    ...inspectFixtureSource('virtual.test.mjs', `const message = ${JSON.stringify(sample.consumerLabel)};`),
    ...inspectDiagnosticRecords('virtual.json', [
      { code: 'CHILD_MISSING', count: 1, [pathField]: sample.homePath },
    ]),
  ].join('\n');

  assert.match(report, /^(?:[^:\r\n]+(?:[/\\][^:\r\n]+)*:\d+:[a-z-]+)(?:\n[^:\r\n]+(?:[/\\][^:\r\n]+)*:\d+:[a-z-]+)*$/);
  assert.equal(report.includes(sample.consumerLabel), false);
  assert.equal(report.includes(sample.homePath), false);
});
