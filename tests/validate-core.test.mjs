// CORE.md memory-compaction validator (ported from NutriGym's validate-brain-core.js):
// cap 25 lines (soft 22), 3 required sections, no secrets/PII. Plus the seeded
// skeleton and the protocol doc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCore,
  renderCoreSkeleton,
  renderCompactionProtocol,
} from '../src/validate-core.mjs';

const SECTIONS = '## Preferências do Usuário\n- a\n\n## Padrões Ativos\n- b\n\n## Pendências Abertas\n- c\n';

test('validateCore: a small, well-formed CORE passes clean', () => {
  const r = validateCore(`# CORE\n\n${SECTIONS}`);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('validateCore: over 25 lines fails (hard limit)', () => {
  const filler = Array.from({ length: 30 }, (_, i) => `- item ${i}`).join('\n');
  const r = validateCore(`# CORE\n## Preferências do Usuário\n## Padrões Ativos\n## Pendências Abertas\n${filler}\n`);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /25/.test(e)), 'reports hard limit');
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

test('validateCore: 22..25 lines is OK but warns (soft limit)', () => {
  const filler = Array.from({ length: 18 }, (_, i) => `- item ${i}`).join('\n');
  const r = validateCore(`# CORE\n## Preferências do Usuário\n## Padrões Ativos\n## Pendências Abertas\n${filler}\n`);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.length >= 1, 'soft warning near the cap');
});

test('renderCoreSkeleton: the seeded CORE passes its own validator', () => {
  const r = validateCore(renderCoreSkeleton());
  assert.equal(r.ok, true, `skeleton must validate; errors=${r.errors}`);
});

test('renderCompactionProtocol: documents the protocol essentials', () => {
  const md = renderCompactionProtocol();
  assert.match(md, /cap 25|25 linhas/i);
  assert.match(md, /Preferências do Usuário/);
  assert.match(md, /wendkeep validate-memory/);
  assert.match(md, /DIGEST/);
});
