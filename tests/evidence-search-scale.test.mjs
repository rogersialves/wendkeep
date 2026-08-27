import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCALE_RARE_TOKEN,
  createSyntheticEvidenceRows,
  runEvidenceSearchScaleBenchmark,
} from '../scripts/benchmark-evidence-search.mjs';

const CI_SCALE_ROWS = 12_000;

test('[req:RECALL-9] synthetic scale fixture is deterministic and contains one old rare anchor', () => {
  const first = createSyntheticEvidenceRows(500, { rareIndex: 0 });
  const second = createSyntheticEvidenceRows(500, { rareIndex: 0 });
  assert.deepEqual(second, first);
  assert.equal(first.length, 500);
  assert.equal(first.filter((row) => row.content.includes(SCALE_RARE_TOKEN)).length, 1);
  assert.equal(first[0].logical_path, '02-Sessões/escala/0000000.md');
  assert.equal(first[0].authority, 'verified');
});

test('[req:RECALL-9] large lexical search remains bounded and warm state is reused', {
  timeout: 120_000,
}, () => {
  const result = runEvidenceSearchScaleBenchmark({
    rows: CI_SCALE_ROWS,
    postingBudget: 256,
    candidateLimit: 24,
    sqlite: 'off',
  });

  assert.equal(result.rows, CI_SCALE_ROWS);
  assert.equal(result.build.reused, false);
  assert.equal(result.build.lexical_written, true);
  assert.equal(result.warm_reuse.reused, true);
  assert.equal(result.warm_reuse.lexical_written, false);
  assert.equal(result.warm_reuse.sqlite_written, false);

  assert.equal(result.rare_query.backend, 'lexical-sidecar');
  assert.equal(result.rare_query.posting_entries, 1);
  assert.match(result.rare_query.found_path, /0000000\.md$/);

  assert.equal(result.common_query.backend, 'lexical-sidecar');
  assert.equal(result.common_query.posting_entries, 256);
  assert.equal(result.common_query.has_more, true);
  assert.ok(result.common_query.candidate_count <= 24);

  assert.deepEqual(result.contracts, {
    rare_evidence_found: true,
    postings_bounded: true,
    candidates_bounded: true,
    warm_state_reused: true,
  });
  assert.ok(result.bytes.evidence_authority > 0);
  assert.ok(result.bytes.lexical_artifact > result.bytes.evidence_authority);
});
