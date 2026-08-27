import {
  EVIDENCE_RECALL_DEFAULT_LIMIT,
  EVIDENCE_RECALL_DEFAULT_MAX_BYTES,
  EVIDENCE_RECALL_MAX_LIMIT,
  EvidenceRecallBudgetError,
  EvidenceRecallCursorError,
  recallEvidencePage,
} from '../../vault/src/evidence-recall-page.mjs';
import {
  EVIDENCE_SEARCH_DEFAULT_CANDIDATES,
  EVIDENCE_SEARCH_DEFAULT_POSTING_BUDGET,
  EVIDENCE_SEARCH_MAX_CANDIDATES,
  EVIDENCE_SEARCH_MAX_POSTING_BUDGET,
  searchEvidenceCandidates,
} from '../../vault/src/evidence-search-index.mjs';

export const MCP_EVIDENCE_RECALL_MAX_BYTES = 512 * 1024;

function integer(value, fallback, { min = 1, max } = {}) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new RangeError(`value must be an integer between ${min} and ${max}`);
  }
  return number;
}

function backend(value) {
  const normalized = String(value ?? 'auto').trim().toLowerCase();
  if (!['auto', 'sqlite', 'lexical'].includes(normalized)) {
    throw new TypeError('backend must be auto, sqlite, or lexical');
  }
  return normalized;
}

function logicalReference(result) {
  const { logical_path: logicalPath, ...rest } = result || {};
  return {
    ...rest,
    logical_ref: String(logicalPath || ''),
  };
}

function mappedError(error) {
  if (String(error?.code || '').startsWith('MCP_')) return error;
  let code = 'MCP_EVIDENCE_RECALL_FAILED';
  if (error instanceof EvidenceRecallCursorError
      || error?.code === 'EVIDENCE_RECALL_CURSOR_INVALID') {
    code = 'MCP_EVIDENCE_CURSOR_INVALID';
  } else if (error instanceof EvidenceRecallBudgetError
      || error?.code === 'EVIDENCE_RECALL_BUDGET_TOO_SMALL') {
    code = 'MCP_EVIDENCE_BUDGET_TOO_SMALL';
  } else if (error?.code === 'EVIDENCE_SEARCH_SQLITE_UNAVAILABLE'
      || error?.code === 'EVIDENCE_SEARCH_FTS5_UNAVAILABLE') {
    code = 'MCP_EVIDENCE_BACKEND_UNAVAILABLE';
  } else if (error?.code === 'VAULT_PATH_UNSAFE') {
    code = 'MCP_EVIDENCE_ARTIFACT_UNSAFE';
  } else if (error instanceof TypeError || error instanceof RangeError) {
    code = 'MCP_EVIDENCE_RECALL_INVALID';
  }
  return Object.assign(new Error(error?.message || 'evidence recall failed'), {
    code,
    cause: error,
  });
}

export function recallEvidenceForMcp(vaultBase, args = {}) {
  try {
    const query = String(args.query || '').trim();
    if (!query) {
      throw Object.assign(new Error('query is required'), {
        code: 'MCP_EVIDENCE_QUERY_REQUIRED',
      });
    }
    const limit = integer(args.limit, EVIDENCE_RECALL_DEFAULT_LIMIT, {
      max: EVIDENCE_RECALL_MAX_LIMIT,
    });
    const maxBytes = integer(args.max_bytes, EVIDENCE_RECALL_DEFAULT_MAX_BYTES, {
      min: 2,
      max: MCP_EVIDENCE_RECALL_MAX_BYTES,
    });
    const candidateLimit = integer(
      args.candidate_limit,
      Math.max(EVIDENCE_SEARCH_DEFAULT_CANDIDATES, limit),
      { max: EVIDENCE_SEARCH_MAX_CANDIDATES },
    );
    const postingBudget = integer(
      args.posting_budget,
      EVIDENCE_SEARCH_DEFAULT_POSTING_BUDGET,
      { max: EVIDENCE_SEARCH_MAX_POSTING_BUDGET },
    );
    const filters = args.filters && typeof args.filters === 'object' && !Array.isArray(args.filters)
      ? args.filters
      : {};
    const candidates = searchEvidenceCandidates(vaultBase, query, {
      candidateLimit,
      postingBudget,
      filters,
      backend: backend(args.backend),
      sqlite: 'auto',
    });
    const page = recallEvidencePage(candidates.rows, query, {
      cursor: args.cursor || null,
      filters,
      limit,
      maxBytes,
    });
    return {
      schema_version: 1,
      ...page,
      results: page.results.map(logicalReference),
      candidates: {
        backend: candidates.backend,
        count: candidates.candidate_count,
        posting_entries: candidates.posting_entries,
        has_more: candidates.has_more,
        rebuilt: candidates.rebuilt,
        fallback_reason: candidates.fallback_reason || '',
      },
      complete_candidate_set: candidates.has_more !== true,
    };
  } catch (error) {
    throw mappedError(error);
  }
}
