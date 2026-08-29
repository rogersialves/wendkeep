import assert from 'node:assert/strict';
import test from 'node:test';

import * as vault from 'wendkeep/vault';

test('[req:RECALL-11] public Vault package exports the optional embedding protocol on Node 18+', () => {
  for (const name of [
    'buildEvidenceEmbeddingManifest',
    'createEvidenceEmbeddingPlugin',
    'verifyEvidenceEmbeddingPlugin',
    'rerankEvidenceCandidatesWithEmbedding',
  ]) {
    assert.equal(typeof vault[name], 'function', `${name} must be public`);
  }
  assert.equal(vault.EVIDENCE_EMBEDDING_PROTOCOL_VERSION, 1);
});
