import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReceiptRecord,
  receiptGenesisHash,
  verifyReceiptChain,
} from '../src/receipt-ledger.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const HASH = /^sha256:[a-f0-9]{64}$/;

// The package intentionally has no runtime JSON-schema dependency. Keep this
// small instance check aligned with the public schema so the contract test
// exercises both a producer-shaped record and its negative cases.
function schemaErrors(schema, value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['root:type'];
  const properties = schema.properties || {};
  for (const field of schema.required || []) {
    if (!Object.hasOwn(value, field)) errors.push(`required:${field}`);
  }
  if (schema.additionalProperties === false) {
    for (const field of Object.keys(value)) {
      if (!Object.hasOwn(properties, field)) errors.push(`additional:${field}`);
    }
  }
  for (const [field, definition] of Object.entries(properties)) {
    if (!Object.hasOwn(value, field)) continue;
    const actual = value[field];
    if (definition.const !== undefined && actual !== definition.const) errors.push(`const:${field}`);
    if (definition.type === 'integer' && (!Number.isInteger(actual) || !Number.isSafeInteger(actual))) errors.push(`integer:${field}`);
    if (definition.type === 'object' && (!actual || typeof actual !== 'object' || Array.isArray(actual))) errors.push(`object:${field}`);
    if (definition.type === 'string' && typeof actual !== 'string') errors.push(`string:${field}`);
    if (definition.minimum !== undefined && (typeof actual !== 'number' || actual < definition.minimum)) errors.push(`minimum:${field}`);
    if (definition.pattern && (typeof actual !== 'string' || !new RegExp(definition.pattern).test(actual))) errors.push(`pattern:${field}`);
    if (definition.format === 'date-time' && (typeof actual !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(actual) || !Number.isFinite(Date.parse(actual)))) {
      errors.push(`format:${field}`);
    }
  }
  return errors;
}

function receiptFixture() {
  return buildReceiptRecord({
    kind: 'delivery.completed',
    subject: {
      delivery_id: 'delivery-schema',
      source_commit: 'a'.repeat(40),
      target: 'main',
      target_commit: 'a'.repeat(40),
    },
    claims: {
      work_kind: 'delivery',
      capabilities: ['git:push'],
    },
    observations: {
      git_subject: { state: 'verified', commit: 'a'.repeat(40) },
      ci: { state: 'reported', commit: 'a'.repeat(40) },
    },
    recorded_at: '2026-08-23T12:00:00.000Z',
  }, { sequence: 1, previousHash: receiptGenesisHash() });
}

test('[req:PROV-7] [req:PROV-8] public receipt v2 schema fixes the hash-chain contract', () => {
  const schema = JSON.parse(readFileSync(
    join(ROOT, 'schema', 'wendkeep.provenance-receipt-v2.schema.json'),
    'utf8',
  ));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  for (const field of [
    'schema_version', 'sequence', 'receipt_id', 'previous_hash', 'receipt_hash',
    'kind', 'subject', 'claims', 'observations', 'recorded_at',
  ]) assert.ok(schema.required.includes(field), `required ausente: ${field}`);
  assert.deepEqual(schema.properties.schema_version, { const: 2 });
  assert.equal(schema.properties.sequence.minimum, 1);
  for (const field of ['receipt_id', 'previous_hash', 'receipt_hash']) {
    assert.equal(schema.properties[field].pattern, '^sha256:[a-f0-9]{64}$');
  }
  assert.equal(schema.properties.observations.type, 'object');
  assert.equal(schema.properties.recorded_at.format, 'date-time');
});

test('[req:PROV-7] schema accepts a producer-shaped receipt and the ledger verifies it', () => {
  const schema = JSON.parse(readFileSync(
    join(ROOT, 'schema', 'wendkeep.provenance-receipt-v2.schema.json'),
    'utf8',
  ));
  const receipt = receiptFixture();
  assert.deepEqual(schemaErrors(schema, receipt), []);
  assert.doesNotThrow(() => verifyReceiptChain({ records: [receipt] }));
  assert.equal(typeof receipt.observations, 'object');
  assert.equal(Array.isArray(receipt.observations), false);
});

test('[req:PROV-7] schema and chain reject invalid fields, types, hashes and sequence', () => {
  const schema = JSON.parse(readFileSync(
    join(ROOT, 'schema', 'wendkeep.provenance-receipt-v2.schema.json'),
    'utf8',
  ));
  const valid = receiptFixture();
  const invalid = [
    ['unknown field', { ...valid, unexpected: true }, 'additional:unexpected'],
    ['schema version', { ...valid, schema_version: 1 }, 'const:schema_version'],
    ['sequence type', { ...valid, sequence: '1' }, 'integer:sequence'],
    ['sequence minimum', { ...valid, sequence: 0 }, 'minimum:sequence'],
    ['receipt id', { ...valid, receipt_id: 'not-a-hash' }, 'pattern:receipt_id'],
    ['previous hash', { ...valid, previous_hash: 'not-a-hash' }, 'pattern:previous_hash'],
    ['receipt hash', { ...valid, receipt_hash: 'not-a-hash' }, 'pattern:receipt_hash'],
    ['kind pattern', { ...valid, kind: 'INVALID KIND' }, 'pattern:kind'],
    ['subject type', { ...valid, subject: [] }, 'object:subject'],
    ['claims type', { ...valid, claims: [] }, 'object:claims'],
    ['observations type', { ...valid, observations: [] }, 'object:observations'],
    ['recorded timestamp', { ...valid, recorded_at: 'today' }, 'format:recorded_at'],
  ];
  for (const [label, candidate, expected] of invalid) {
    assert.ok(schemaErrors(schema, candidate).includes(expected), `${label} deve falhar no schema`);
  }
  assert.throws(() => verifyReceiptChain({
    records: [{ ...valid, receipt_hash: `sha256:${'0'.repeat(64)}` }],
  }), /receipt_hash inválido/);
  assert.throws(() => verifyReceiptChain({
    records: [{ ...valid, sequence: 2 }],
  }), /sequência monotônica/);
});
