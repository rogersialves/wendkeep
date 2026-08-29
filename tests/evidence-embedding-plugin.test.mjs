import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

import {
  EVIDENCE_EMBEDDING_PROTOCOL_VERSION,
  EvidenceEmbeddingBudgetError,
  EvidenceEmbeddingPluginError,
  EvidenceEmbeddingResponseError,
  buildEvidenceEmbeddingManifest,
  createEvidenceEmbeddingPlugin,
  evidenceEmbeddingManifestIntegrity,
  rerankEvidenceCandidatesWithEmbedding,
  verifyEvidenceEmbeddingPlugin,
} from '../packages/vault/src/evidence-embedding-plugin.mjs';

const MODEL_FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const TEST_DIR = dirname(fileURLToPath(import.meta.url));

function manifest(overrides = {}) {
  return buildEvidenceEmbeddingManifest({
    plugin_id: 'local.fake-embedding',
    plugin_version: '1.0.0',
    model_id: 'local.fake-model',
    model_revision: '2026.08.27',
    model_fingerprint: MODEL_FINGERPRINT,
    dimensions: 3,
    max_batch_size: 8,
    max_input_bytes: 64 * 1024,
    ...overrides,
  });
}

function rows() {
  return [
    {
      chunk_id: 'chunk-alpha',
      logical_path: '04-Decisões/ADR-alpha.md',
      title: 'Alpha',
      heading: 'Evidência',
      content: 'sinal alpha distante',
      authority: 'verified',
      validity: 'active',
    },
    {
      chunk_id: 'chunk-beta',
      logical_path: '04-Decisões/ADR-beta.md',
      title: 'Beta',
      heading: 'Evidência',
      content: 'sinal beta semanticamente próximo',
      authority: 'verified',
      validity: 'active',
    },
    {
      chunk_id: 'chunk-gamma',
      logical_path: '04-Decisões/ADR-gamma.md',
      title: 'Gamma',
      heading: 'Evidência',
      content: 'sinal gamma não processado',
      authority: 'reported',
      validity: 'active',
    },
  ];
}

function workingPlugin({ manifest: pluginManifest = manifest(), onEmbed } = {}) {
  return createEvidenceEmbeddingPlugin({
    manifest: pluginManifest,
    async embed(payload, context) {
      onEmbed?.(payload, context);
      return {
        schema_version: 1,
        model_fingerprint: pluginManifest.model_fingerprint,
        query_vector: [1, 0, 0],
        document_vectors: payload.documents.map((document) => ({
          id: document.id,
          vector: document.id === 'chunk-beta' ? [1, 0, 0] : [0, 1, 0],
        })),
      };
    },
  });
}

test('[req:RECALL-11] embedding manifest is local-only, integrity-bound, and dependency-free', () => {
  const value = manifest();
  assert.equal(value.schema_version, 1);
  assert.equal(value.protocol_version, EVIDENCE_EMBEDDING_PROTOCOL_VERSION);
  assert.equal(value.locality, 'local');
  assert.equal(value.transport, 'in-process');
  assert.equal(value.network, 'forbidden');
  assert.equal(value.retention, 'none');
  assert.equal(value.integrity, evidenceEmbeddingManifestIntegrity(value));
  assert.equal(Object.isFrozen(value), true);

  const plugin = workingPlugin({ manifest: value });
  assert.deepEqual(verifyEvidenceEmbeddingPlugin(plugin), {
    valid: true,
    errors: [],
    expected_integrity: value.integrity,
  });

  assert.throws(
    () => buildEvidenceEmbeddingManifest({
      ...value,
      plugin_id: 'local.remote-attempt',
      locality: 'remote',
    }),
    (error) => error instanceof EvidenceEmbeddingPluginError
      && error.errors.includes('locality'),
  );
});

test('[req:RECALL-11] Core embedding contract has no provider, network, vector DB, or autoload dependency', () => {
  const modulePath = join(
    TEST_DIR,
    '..',
    'packages',
    'vault',
    'src',
    'evidence-embedding-plugin.mjs',
  );
  const source = readFileSync(modulePath, 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const imports = ast.body
    .filter((node) => node.type === 'ImportDeclaration')
    .map((node) => node.source.value);
  assert.deepEqual(imports, ['node:crypto']);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /\b(?:require|fetch|WebSocket|XMLHttpRequest)\s*\(/);

});

test('[req:RECALL-11] embedding reranker is disabled by default and never calls the plugin', async () => {
  let calls = 0;
  const original = rows();
  const result = await rerankEvidenceCandidatesWithEmbedding(
    original,
    'consulta beta',
    { plugin: workingPlugin({ onEmbed: () => { calls += 1; } }) },
  );
  assert.equal(calls, 0);
  assert.deepEqual(result.rows, original);
  assert.notEqual(result.rows, original);
  assert.deepEqual(result.metrics, {
    schema_version: 1,
    status: 'disabled',
    reason: 'disabled',
    plugin_id: '',
    plugin_version: '',
    model_id: '',
    model_revision: '',
    model_fingerprint: '',
    dimensions: 0,
    requested_candidates: 3,
    embedded_candidates: 0,
    skipped_candidates: 3,
    input_bytes: 0,
    scores: [],
  });
});

test('[req:RECALL-11] explicit local plugin reranks only a bounded candidate prefix and preserves provenance', async () => {
  let captured = null;
  const original = rows();
  const result = await rerankEvidenceCandidatesWithEmbedding(
    original,
    'consulta beta',
    {
      enabled: true,
      plugin: workingPlugin({ onEmbed: (payload) => { captured = payload; } }),
      maxCandidates: 2,
      maxInputBytes: 16 * 1024,
    },
  );

  assert.equal(captured.documents.length, 2);
  assert.equal(JSON.stringify(captured).includes('logical_path'), false);
  assert.equal(JSON.stringify(captured).includes('04-Decisões'), false);
  assert.equal(result.rows[0], original[1]);
  assert.equal(result.rows[1], original[0]);
  assert.equal(result.rows[2], original[2]);
  assert.equal(result.rows[0].logical_path, '04-Decisões/ADR-beta.md');
  assert.equal(result.rows[0].authority, 'verified');
  assert.equal(result.metrics.status, 'applied');
  assert.equal(result.metrics.plugin_id, 'local.fake-embedding');
  assert.equal(result.metrics.model_fingerprint, MODEL_FINGERPRINT);
  assert.equal(result.metrics.requested_candidates, 3);
  assert.equal(result.metrics.embedded_candidates, 2);
  assert.equal(result.metrics.skipped_candidates, 1);
  assert.ok(result.metrics.input_bytes > 0);
  assert.deepEqual(result.metrics.scores.map((item) => item.chunk_id), [
    'chunk-beta',
    'chunk-alpha',
  ]);
  assert.equal(result.metrics.scores[0].similarity, 1);
  assert.equal(result.metrics.scores[1].similarity, 0);
});

test('[req:RECALL-11] invalid or remote plugin falls back before receiving evidence', async () => {
  const valid = manifest();
  const remoteManifest = {
    ...valid,
    locality: 'remote',
  };
  remoteManifest.integrity = evidenceEmbeddingManifestIntegrity(remoteManifest);
  let calls = 0;
  const remotePlugin = {
    manifest: remoteManifest,
    async embed() {
      calls += 1;
      throw new Error('must not run');
    },
  };

  const optional = await rerankEvidenceCandidatesWithEmbedding(rows(), 'consulta', {
    enabled: true,
    plugin: remotePlugin,
  });
  assert.equal(calls, 0);
  assert.equal(optional.metrics.status, 'fallback');
  assert.equal(optional.metrics.reason, 'EVIDENCE_EMBEDDING_PLUGIN_INVALID');
  assert.deepEqual(optional.rows.map((row) => row.chunk_id), [
    'chunk-alpha', 'chunk-beta', 'chunk-gamma',
  ]);

  await assert.rejects(
    rerankEvidenceCandidatesWithEmbedding(rows(), 'consulta', {
      enabled: true,
      required: true,
      plugin: remotePlugin,
    }),
    (error) => error instanceof EvidenceEmbeddingPluginError
      && error.errors.includes('locality'),
  );
});

test('[req:RECALL-11] response dimensions, model identity, and finite values are fail-closed', async () => {
  const pluginManifest = manifest();
  const invalidPlugin = createEvidenceEmbeddingPlugin({
    manifest: pluginManifest,
    async embed(payload) {
      return {
        schema_version: 1,
        model_fingerprint: pluginManifest.model_fingerprint,
        query_vector: [1, 0],
        document_vectors: payload.documents.map(({ id }) => ({ id, vector: [1, 0, 0] })),
      };
    },
  });

  const optional = await rerankEvidenceCandidatesWithEmbedding(rows(), 'consulta', {
    enabled: true,
    plugin: invalidPlugin,
  });
  assert.equal(optional.metrics.status, 'fallback');
  assert.equal(optional.metrics.reason, 'EVIDENCE_EMBEDDING_RESPONSE_INVALID');

  await assert.rejects(
    rerankEvidenceCandidatesWithEmbedding(rows(), 'consulta', {
      enabled: true,
      required: true,
      plugin: invalidPlugin,
    }),
    (error) => error instanceof EvidenceEmbeddingResponseError,
  );
});

test('[req:RECALL-11] plugin and caller budgets cap evidence before execution', async () => {
  let captured = null;
  const limitedManifest = manifest({
    max_batch_size: 1,
    max_input_bytes: 8 * 1024,
  });
  const limited = await rerankEvidenceCandidatesWithEmbedding(rows(), 'consulta beta', {
    enabled: true,
    plugin: workingPlugin({
      manifest: limitedManifest,
      onEmbed: (payload) => { captured = payload; },
    }),
    maxCandidates: 10,
    maxInputBytes: 64 * 1024,
  });
  assert.equal(captured.documents.length, 1);
  assert.equal(limited.metrics.embedded_candidates, 1);
  assert.equal(limited.metrics.skipped_candidates, 2);

  const tinyManifest = manifest({ max_input_bytes: 64 });
  const optional = await rerankEvidenceCandidatesWithEmbedding(rows(), 'consulta beta', {
    enabled: true,
    plugin: workingPlugin({ manifest: tinyManifest }),
  });
  assert.equal(optional.metrics.status, 'fallback');
  assert.equal(optional.metrics.reason, 'EVIDENCE_EMBEDDING_BUDGET_EXCEEDED');

  await assert.rejects(
    rerankEvidenceCandidatesWithEmbedding(rows(), 'consulta beta', {
      enabled: true,
      required: true,
      plugin: workingPlugin({ manifest: tinyManifest }),
    }),
    (error) => error instanceof EvidenceEmbeddingBudgetError
      && error.max_bytes === 64,
  );
});

test('[req:RECALL-11] runtime plugin failure degrades to the original lexical order unless required', async () => {
  const pluginManifest = manifest();
  const failing = createEvidenceEmbeddingPlugin({
    manifest: pluginManifest,
    async embed() {
      throw new Error('private provider detail');
    },
  });

  const optional = await rerankEvidenceCandidatesWithEmbedding(rows(), 'consulta', {
    enabled: true,
    plugin: failing,
  });
  assert.equal(optional.metrics.status, 'fallback');
  assert.equal(optional.metrics.reason, 'EVIDENCE_EMBEDDING_EXECUTION_FAILED');
  assert.deepEqual(optional.rows.map((row) => row.chunk_id), [
    'chunk-alpha', 'chunk-beta', 'chunk-gamma',
  ]);

  await assert.rejects(
    rerankEvidenceCandidatesWithEmbedding(rows(), 'consulta', {
      enabled: true,
      required: true,
      plugin: failing,
    }),
    { code: 'EVIDENCE_EMBEDDING_EXECUTION_FAILED' },
  );
});
