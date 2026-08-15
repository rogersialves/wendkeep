import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REVIEW_FILES = [
  'roadmap.md',
  'analise-hooks.md',
  'evidencias-sessao.md',
  'plano-implementacao.md',
];

const CONSUMER_PROJECT = ['Observatorio', 'Politico'].join('');
const LOCAL_PATH = /(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home)\/)/;
const OPAQUE_ID = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i;
const TRANSCRIPT_PATH = /(?:\.codex[\\/]sessions|rollout-)/i;

test('[sensor:review-docs-sanitization] docs/revisão não expõe origem local ou consumidor', () => {
  const findings = [];
  for (const file of REVIEW_FILES) {
    const relative = `docs/revisão/${file}`;
    const source = readFileSync(join(ROOT, relative), 'utf8');
    if (LOCAL_PATH.test(source)) findings.push(`${relative}:absolute-local-path`);
    if (OPAQUE_ID.test(source)) findings.push(`${relative}:opaque-identifier`);
    if (TRANSCRIPT_PATH.test(source)) findings.push(`${relative}:transcript-path`);
    if (source.includes(CONSUMER_PROJECT)) findings.push(`${relative}:consumer-project`);
  }
  assert.deepEqual(findings, []);
});
