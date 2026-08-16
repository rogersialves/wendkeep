// CORE.md memory-compaction validator (ported from NutriGym's validate-brain-core.js):
// cap 40 lines (soft 35), 4 KiB/320 chars per line, 3 required sections, no secrets/PII. Plus the seeded
// skeleton and the protocol doc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCore,
  renderCoreSkeleton,
  renderCompactionProtocol,
} from '../src/validate-core.mjs';

const SECTIONS = '## Preferências do Usuário\n- a\n\n## Padrões Ativos\n- b\n\n## Pendências Abertas\n- c\n';

function coreWithFiller(itemCount, item = (index) => `- item ${index}`) {
  const filler = Array.from({ length: itemCount }, (_, index) => item(index)).join('\n');
  return `# CORE\n## Preferências do Usuário\n## Padrões Ativos\n## Pendências Abertas\n${filler}\n`;
}

test('validateCore: a small, well-formed CORE passes clean', () => {
  const r = validateCore(`# CORE\n\n${SECTIONS}`);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('validateCore: 41 lines fails (hard limit)', () => {
  const r = validateCore(coreWithFiller(37));
  assert.equal(r.ok, false);
  assert.equal(r.lineCount, 41);
  assert.ok(r.errors.some((e) => /41.*40|40.*linhas/.test(e)), 'reports hard limit');
});

test('validateCore: missing a required section fails', () => {
  const r = validateCore('# CORE\n## Preferências do Usuário\n- a\n## Padrões Ativos\n- b\n');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /Pend/i.test(e)), 'flags missing Pendências');
});

test('validateCore: a real secret is rejected', () => {
  const secret = `sk_live_${'a'.repeat(24)}`;
  const r = validateCore(`# CORE\n${SECTIONS}- token ${secret}\n`);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /Stripe/i.test(e)));
});

test('validateCore: a real PII email is rejected', () => {
  const r = validateCore(`# CORE\n${SECTIONS}- contato real@gmail.com\n`);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /email/i.test(e)));
});

test('validateCore: 35 lines is OK but warns (soft limit)', () => {
  const r = validateCore(coreWithFiller(31));
  assert.equal(r.ok, true);
  assert.equal(r.lineCount, 35);
  assert.ok(r.warnings.length >= 1, 'soft warning near the cap');
});

test('validateCore: exactly 40 lines is valid', () => {
  const r = validateCore(coreWithFiller(36));
  assert.equal(r.ok, true);
  assert.equal(r.lineCount, 40);
  assert.ok(r.warnings.length >= 1, 'warns at the upper edge');
});

test('validateCore: preserves byte and line-character budgets', () => {
  const overBytes = validateCore(coreWithFiller(36, () => `- ${'x'.repeat(320)}`));
  assert.equal(overBytes.ok, false);
  assert.ok(overBytes.errors.some((e) => /bytes/i.test(e)), 'reports byte budget');

  const overLineChars = validateCore(coreWithFiller(1, () => `- ${'x'.repeat(320)}`));
  assert.equal(overLineChars.ok, false);
  assert.ok(overLineChars.errors.some((e) => /caracteres|characters/i.test(e)), 'reports line-character budget');
});

test('renderCoreSkeleton: the seeded CORE passes its own validator', () => {
  const r = validateCore(renderCoreSkeleton());
  assert.equal(r.ok, true, `skeleton must validate; errors=${r.errors}`);
});

test('renderCompactionProtocol: documents the protocol essentials', () => {
  const md = renderCompactionProtocol();
  assert.match(md, /cap 40|40 linhas/i);
  assert.match(md, /Preferências do Usuário/);
  assert.match(md, /wendkeep validate-memory/);
  assert.match(md, /DIGEST/);
});
