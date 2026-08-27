import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import {
  EVIDENCE_INDEX_FILE,
  EVIDENCE_INDEX_VERSION,
  loadEvidenceSearchState,
  refreshEvidenceSearchIndex,
  searchEvidenceCandidates,
} from '../hooks/evidence-recall.mjs';

export const DEFAULT_SCALE_ROWS = 100_000;
export const DEFAULT_SCALE_POSTING_BUDGET = 512;
export const DEFAULT_SCALE_CANDIDATE_LIMIT = 32;
export const SCALE_RARE_TOKEN = 'marcador-raro-escala-wendkeep';

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function normalizeInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const normalized = Number(value ?? fallback);
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    throw new RangeError(`benchmark integer must be between ${min} and ${max}`);
  }
  return normalized;
}

function normalizeSqliteMode(value) {
  const mode = String(value ?? 'off').trim().toLowerCase();
  if (!['auto', 'off', 'required'].includes(mode)) {
    throw new TypeError('benchmark sqlite mode must be auto, off, or required');
  }
  return mode;
}

export function createSyntheticEvidenceRows(count, {
  projectId = 'benchmark-evidence-search',
  rareIndex = 0,
} = {}) {
  const rowCount = normalizeInteger(count, DEFAULT_SCALE_ROWS, { max: 1_000_000 });
  if (!Number.isSafeInteger(rareIndex) || rareIndex < 0 || rareIndex >= rowCount) {
    throw new RangeError('benchmark rareIndex must identify one generated row');
  }

  const rows = new Array(rowCount);
  for (let index = 0; index < rowCount; index += 1) {
    const logicalPath = `02-Sessões/escala/${String(index).padStart(7, '0')}.md`;
    const rare = index === rareIndex ? ` ${SCALE_RARE_TOKEN}` : '';
    const content = [
      `registro-comum escala documento ${index}`,
      `grupo-${index % 257} bucket-${index % 997}`,
      rare,
    ].join(' ').trim();
    const contentHash = sha256(content);
    rows[index] = {
      index_version: EVIDENCE_INDEX_VERSION,
      project_id: projectId,
      logical_path: logicalPath,
      title: `Sessão sintética ${index}`,
      heading: 'Evidência de escala',
      change_slug: '',
      session_id: `scale-session-${index}`,
      work_session_id: '',
      observed_at: '2026-08-26T00:00:00.000Z',
      chunk_id: sha256(`${logicalPath}\u0000${contentHash}`),
      entity_type: 'session',
      authority: index === rareIndex ? 'verified' : 'reported',
      validity: 'active',
      ordinal: 0,
      content,
      content_hash: contentHash,
    };
  }
  return rows;
}

function createBenchmarkVault(projectId) {
  const vault = mkdtempSync(join(tmpdir(), 'wk-evidence-scale-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  writeFileSync(
    join(vault, '.brain', 'PROJECT.json'),
    `${JSON.stringify({ projectId }, null, 2)}\n`,
  );
  return vault;
}

function writeEvidenceAuthority(vault, rows) {
  const content = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  const path = join(vault, '.brain', EVIDENCE_INDEX_FILE);
  writeFileSync(path, content);
  return { path, bytes: Buffer.byteLength(content, 'utf8') };
}

function artifactBytes(vault, artifact) {
  if (!artifact?.path) return 0;
  return Number(statSync(join(vault, '.brain', ...artifact.path.split('/'))).size);
}

function elapsed(startedAt) {
  return Math.round((performance.now() - startedAt) * 1000) / 1000;
}

export function runEvidenceSearchScaleBenchmark({
  rows: requestedRows = DEFAULT_SCALE_ROWS,
  postingBudget: requestedPostingBudget = DEFAULT_SCALE_POSTING_BUDGET,
  candidateLimit: requestedCandidateLimit = DEFAULT_SCALE_CANDIDATE_LIMIT,
  sqlite: requestedSqlite = 'off',
  keepVault = false,
} = {}) {
  const rowCount = normalizeInteger(requestedRows, DEFAULT_SCALE_ROWS, { max: 1_000_000 });
  const postingBudget = normalizeInteger(
    requestedPostingBudget,
    DEFAULT_SCALE_POSTING_BUDGET,
    { max: 1_048_576 },
  );
  const candidateLimit = normalizeInteger(
    requestedCandidateLimit,
    DEFAULT_SCALE_CANDIDATE_LIMIT,
    { max: 4096 },
  );
  const sqlite = normalizeSqliteMode(requestedSqlite);
  const projectId = `benchmark-evidence-search-${rowCount}`;
  const vault = createBenchmarkVault(projectId);
  const rssBefore = process.memoryUsage().rss;

  try {
    const generationStarted = performance.now();
    const evidenceRows = createSyntheticEvidenceRows(rowCount, {
      projectId,
      rareIndex: 0,
    });
    const generationMs = elapsed(generationStarted);
    const authority = writeEvidenceAuthority(vault, evidenceRows);

    const buildStarted = performance.now();
    const built = refreshEvidenceSearchIndex(vault, evidenceRows, {
      force: true,
      sqlite,
    });
    const buildMs = elapsed(buildStarted);

    const reuseStarted = performance.now();
    const reused = refreshEvidenceSearchIndex(vault, evidenceRows, { sqlite });
    const reuseMs = elapsed(reuseStarted);

    const rareStarted = performance.now();
    const rare = searchEvidenceCandidates(vault, SCALE_RARE_TOKEN, {
      backend: 'lexical',
      sqlite: 'off',
      candidateLimit,
      postingBudget,
      filters: { authority: 'verified' },
    });
    const rareQueryMs = elapsed(rareStarted);

    const commonStarted = performance.now();
    const common = searchEvidenceCandidates(vault, 'registro-comum', {
      backend: 'lexical',
      sqlite: 'off',
      candidateLimit,
      postingBudget,
    });
    const commonQueryMs = elapsed(commonStarted);

    const state = loadEvidenceSearchState(vault);
    const result = {
      schema_version: 1,
      rows: rowCount,
      posting_budget: postingBudget,
      candidate_limit: candidateLimit,
      sqlite_mode: sqlite,
      timings_ms: {
        generation: generationMs,
        build: buildMs,
        reuse: reuseMs,
        rare_query: rareQueryMs,
        common_query: commonQueryMs,
      },
      bytes: {
        evidence_authority: authority.bytes,
        lexical_artifact: artifactBytes(vault, state?.lexical),
        sqlite_artifact: artifactBytes(vault, state?.sqlite),
      },
      memory: {
        rss_before: rssBefore,
        rss_after: process.memoryUsage().rss,
      },
      build: {
        reused: built.reused,
        lexical_written: built.lexical_written,
        sqlite_available: built.sqlite_available,
        sqlite_reason: built.sqlite_reason,
      },
      warm_reuse: {
        reused: reused.reused,
        lexical_written: reused.lexical_written,
        sqlite_written: reused.sqlite_written,
      },
      rare_query: {
        backend: rare.backend,
        candidate_count: rare.candidate_count,
        posting_entries: rare.posting_entries,
        has_more: rare.has_more,
        found_path: rare.rows[0]?.logical_path || '',
      },
      common_query: {
        backend: common.backend,
        candidate_count: common.candidate_count,
        posting_entries: common.posting_entries,
        has_more: common.has_more,
      },
      contracts: {
        rare_evidence_found: rare.rows[0]?.content?.includes(SCALE_RARE_TOKEN) === true,
        postings_bounded: common.posting_entries <= postingBudget,
        candidates_bounded: common.candidate_count <= candidateLimit,
        warm_state_reused: reused.reused === true
          && reused.lexical_written === false
          && reused.sqlite_written === false,
      },
      ...(keepVault ? { vault } : {}),
    };
    result.memory.rss_delta = result.memory.rss_after - result.memory.rss_before;
    return result;
  } finally {
    if (!keepVault) rmSync(vault, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new TypeError(`missing value for ${arg}`);
      return argv[index];
    };
    if (arg === '--rows') options.rows = next();
    else if (arg === '--posting-budget') options.postingBudget = next();
    else if (arg === '--candidate-limit') options.candidateLimit = next();
    else if (arg === '--sqlite') options.sqlite = next();
    else if (arg === '--keep-vault') options.keepVault = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new TypeError(`unknown benchmark option: ${arg}`);
  }
  return options;
}

const HELP = `Evidence search scale benchmark\n\nUsage:\n  node scripts/benchmark-evidence-search.mjs [options]\n\nOptions:\n  --rows <n>             Synthetic evidence rows (default: ${DEFAULT_SCALE_ROWS})\n  --posting-budget <n>   Maximum postings visited per query (default: ${DEFAULT_SCALE_POSTING_BUDGET})\n  --candidate-limit <n>  Maximum candidates returned (default: ${DEFAULT_SCALE_CANDIDATE_LIMIT})\n  --sqlite <mode>        off, auto, or required (default: off)\n  --keep-vault           Preserve the generated temporary Vault\n  --help                 Show this help\n`;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(HELP);
    else process.stdout.write(`${JSON.stringify(runEvidenceSearchScaleBenchmark(options), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 2;
  }
}
