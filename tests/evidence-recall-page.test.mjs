import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EvidenceRecallBudgetError,
  EvidenceRecallCursorError,
  recallEvidence,
  recallEvidencePage,
} from '../hooks/evidence-recall.mjs';

const NOW = Date.parse('2026-08-26T12:00:00.000Z');

function evidenceRow(id, {
  authority = 'verified',
  validity = 'active',
  logicalPath = `docs/${String(id).padStart(2, '0')}.md`,
  observedAt = new Date(NOW - Number(id) * 86_400_000).toISOString(),
  content = `ledger evidence ${id} ${'detail '.repeat(Number(id) + 2)}`,
  projectId = 'project-a',
} = {}) {
  return {
    index_version: 1,
    project_id: projectId,
    logical_path: logicalPath,
    title: `Ledger ${id}`,
    change_slug: '',
    session_id: '',
    work_session_id: '',
    observed_at: observedAt,
    chunk_id: `chunk-${id}`,
    heading: `Ledger ${id}`,
    entity_type: 'evidence',
    authority,
    validity,
    ordinal: 0,
    content,
    content_hash: `content-${id}-${Buffer.byteLength(content, 'utf8')}`,
  };
}

function canonicalRows(rows) {
  return [...rows].sort((left, right) => left.logical_path.localeCompare(right.logical_path)
    || left.ordinal - right.ordinal || left.chunk_id.localeCompare(right.chunk_id));
}

test('recallEvidencePage paginates the deterministic ranking without hiding late evidence', () => {
  const rows = Array.from({ length: 7 }, (_, index) => evidenceRow(index));
  const expected = recallEvidence(canonicalRows(rows), 'ledger', {
    topK: rows.length,
    now: NOW,
  }).map((row) => row.chunk_id);
  const found = [];
  let cursor = null;
  let pageNumber = 0;
  do {
    const page = recallEvidencePage(pageNumber % 2 ? rows : [...rows].reverse(), 'ledger', {
      cursor,
      limit: 2,
      maxBytes: 128 * 1024,
      now: NOW,
    });
    assert.ok(page.returned_bytes <= page.max_bytes);
    assert.ok(page.results.every((row) => !Object.hasOwn(row, 'content')));
    found.push(...page.results.map((row) => row.chunk_id));
    cursor = page.next_cursor;
    pageNumber += 1;
  } while (cursor);

  assert.deepEqual(found, expected);
  assert.equal(found.at(-1), expected.at(-1));
});

test('recallEvidencePage binds cursors to normalized query, filters, and index state', () => {
  const rows = [
    evidenceRow(1, { authority: 'verified', logicalPath: 'docs/verified.md' }),
    evidenceRow(2, { authority: 'reported', logicalPath: 'docs/reported.md' }),
    evidenceRow(3, { authority: 'reported', logicalPath: 'docs/reported-two.md' }),
    evidenceRow(4, { authority: 'reported', logicalPath: 'sessions/reported.md' }),
  ];
  const first = recallEvidencePage(rows, 'ledger', {
    filters: { authority: 'reported', logical_path_prefix: 'docs/' },
    limit: 1,
    maxBytes: 128 * 1024,
    now: NOW,
  });
  assert.equal(first.results.length, 1);
  assert.equal(first.results[0].authority, 'reported');
  assert.ok(first.results[0].logical_path.startsWith('docs/'));

  assert.doesNotThrow(() => recallEvidencePage(rows, '  LEDGER  ', {
    cursor: first.next_cursor,
    filters: { logical_path_prefix: ['docs/'], authority: ['reported'] },
    maxBytes: 128 * 1024,
  }));
  assert.throws(() => recallEvidencePage(rows, 'different query', {
    cursor: first.next_cursor,
    filters: { authority: 'reported', logical_path_prefix: 'docs/' },
  }), EvidenceRecallCursorError);
  assert.throws(() => recallEvidencePage(rows, 'ledger', {
    cursor: first.next_cursor,
    filters: { authority: 'verified', logical_path_prefix: 'docs/' },
  }), EvidenceRecallCursorError);
  assert.throws(() => recallEvidencePage([
    ...rows,
    evidenceRow(5, { authority: 'reported', logicalPath: 'docs/new.md' }),
  ], 'ledger', {
    cursor: first.next_cursor,
    filters: { authority: 'reported', logical_path_prefix: 'docs/' },
  }), EvidenceRecallCursorError);
});

test('recallEvidencePage rejects corrupted and unsupported cursors fail closed', () => {
  const rows = [evidenceRow(1), evidenceRow(2)];
  const first = recallEvidencePage(rows, 'ledger', { limit: 1, now: NOW });
  const last = first.next_cursor.at(-1);
  const corrupted = `${first.next_cursor.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;

  assert.throws(() => recallEvidencePage(rows, 'ledger', { cursor: corrupted }), (error) => {
    assert.ok(error instanceof EvidenceRecallCursorError);
    assert.equal(error.code, 'EVIDENCE_RECALL_CURSOR_INVALID');
    return true;
  });
  assert.throws(() => recallEvidencePage(rows, 'ledger', { cursor: 'not+a+base64url+cursor' }),
    EvidenceRecallCursorError);
});

test('recallEvidencePage pins recency ranking to the first page as_of timestamp', () => {
  const rows = [
    evidenceRow(1, { observedAt: '2026-08-25T12:00:00.000Z' }),
    evidenceRow(2, { observedAt: '2025-08-26T12:00:00.000Z' }),
    evidenceRow(3, { observedAt: '2024-08-26T12:00:00.000Z' }),
  ];
  const expected = recallEvidence(canonicalRows(rows), 'ledger', {
    topK: rows.length,
    now: NOW,
  }).map((row) => row.chunk_id);
  const first = recallEvidencePage(rows, 'ledger', { limit: 1, now: NOW });
  const second = recallEvidencePage(rows, 'ledger', {
    cursor: first.next_cursor,
    limit: 10,
    now: NOW + 10 * 365 * 86_400_000,
  });

  assert.equal(second.as_of, first.as_of);
  assert.deepEqual([
    ...first.results.map((row) => row.chunk_id),
    ...second.results.map((row) => row.chunk_id),
  ], expected);
});

test('recallEvidencePage truncates excerpts to the exact serialized byte budget', () => {
  const content = `ledger ${'á漢🙂'.repeat(900)}`;
  const row = evidenceRow(8, { content });
  const full = recallEvidencePage([row], 'ledger', { maxBytes: 128 * 1024, now: NOW });
  const minimum = [{
    ...full.results[0],
    excerpt: '',
    excerpt_truncated: true,
  }];
  const budget = Buffer.byteLength(JSON.stringify(minimum), 'utf8') + 24;
  const bounded = recallEvidencePage([row], 'ledger', { maxBytes: budget, now: NOW });

  assert.equal(bounded.returned_count, 1);
  assert.ok(bounded.returned_bytes <= budget);
  assert.equal(bounded.results[0].excerpt_truncated, true);
  assert.equal(bounded.results[0].content_bytes, Buffer.byteLength(content, 'utf8'));
  assert.equal(bounded.results[0].content_omitted, true);
  assert.ok(!Object.hasOwn(bounded.results[0], 'content'));
});

test('recallEvidencePage reports a typed error when metadata cannot fit the budget', () => {
  const row = evidenceRow(1);
  assert.throws(() => recallEvidencePage([row], 'ledger', { maxBytes: 2, now: NOW }), (error) => {
    assert.ok(error instanceof EvidenceRecallBudgetError);
    assert.equal(error.code, 'EVIDENCE_RECALL_BUDGET_TOO_SMALL');
    assert.ok(error.required_bytes > error.max_bytes);
    return true;
  });
});

test('legacy recallEvidence keeps returning raw content while paged recall stays compact', () => {
  const row = evidenceRow(1);
  const [legacy] = recallEvidence([row], 'ledger', { topK: 1, now: NOW });
  const page = recallEvidencePage([row], 'ledger', { limit: 1, now: NOW });

  assert.equal(legacy.content, row.content);
  assert.ok(!Object.hasOwn(page.results[0], 'content'));
});
