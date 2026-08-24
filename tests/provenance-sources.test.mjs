import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import {
  collectCiObservation,
  collectGitHubReleaseObservation,
  collectGitSubject,
  collectNpmObservation,
  collectTagObservation,
  normalizeRepository,
  readJsonAtCommit,
  readTextAtCommit,
} from '../src/provenance-sources.mjs';

const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const REPOSITORY = 'rogersialves/wendkeep';
const PACKAGE = { name: 'wendkeep', version: '0.79.0' };
const NOTES = '- Add fresh provenance gates.';
const INTEGRITY = 'sha512-expected-artifact';

function executeMap(map, calls = []) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const key = `${command} ${args.join(' ')}`;
    const value = map instanceof Map ? map.get(key) : map[key];
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`unexpected command: ${key}`);
    return value;
  };
}

test('[req:PROV-5] repository normalization accepts only owner/repo or github.com transports', () => {
  for (const value of [
    'rogersialves/wendkeep',
    'https://github.com/rogersialves/wendkeep.git',
    'git@github.com:rogersialves/wendkeep.git',
    'ssh://git@github.com/rogersialves/wendkeep.git',
  ]) {
    assert.equal(normalizeRepository(value), REPOSITORY, value);
  }
  for (const value of [
    'git@gitlab.com:rogersialves/wendkeep.git',
    'https://gitlab.com/rogersialves/wendkeep.git',
    'https://api.github.com/rogersialves/wendkeep',
    'evil@github.com:rogersialves/wendkeep',
  ]) {
    assert.equal(normalizeRepository(value), '', value);
  }
});

test('[req:PROV-4] git subject derives package and changelog from target commit', () => {
  const calls = [];
  const execute = executeMap(new Map([
    ['git rev-parse --verify --end-of-options refs/heads/feature^{commit}', COMMIT],
    ['git rev-parse --verify --end-of-options refs/heads/main^{commit}', OTHER_COMMIT],
    [`git cat-file blob ${OTHER_COMMIT}:package.json`, JSON.stringify(PACKAGE)],
    [`git cat-file blob ${OTHER_COMMIT}:CHANGELOG.md`, `# Changelog\n\n## [0.79.0] — 2026-08-23\n${NOTES}\n`],
  ]), calls);

  const result = collectGitSubject({
    repoRoot: 'C:\\worktree',
    sourceRef: 'refs/heads/feature',
    targetRef: 'refs/heads/main',
    execute,
  });

  assert.equal(result.state, 'verified');
  assert.equal(result.ok, true);
  assert.equal(result.sourceCommit, COMMIT);
  assert.equal(result.targetCommit, OTHER_COMMIT);
  assert.deepEqual(result.package, PACKAGE);
  assert.equal(result.version, PACKAGE.version);
  assert.equal(result.name, PACKAGE.name);
  assert.match(result.changelog, /0\.79\.0/);
  assert.ok(calls.every(({ options }) => options.shell !== true));
});

test('[req:PROV-4] target subject is independent of the incidental worktree', () => {
  const execute = executeMap(new Map([
    ['git rev-parse --verify --end-of-options HEAD^{commit}', COMMIT],
    [`git cat-file blob ${COMMIT}:package.json`, JSON.stringify(PACKAGE)],
    [`git cat-file blob ${COMMIT}:CHANGELOG.md`, `## [0.79.0] — 2026-08-23\n${NOTES}`],
  ]));
  const result = collectGitSubject({ repoRoot: 'C:\\worktree', targetRef: 'HEAD', execute });
  assert.equal(result.targetCommit, COMMIT);
  assert.equal(result.state, 'verified');
});

test('[req:PROV-6] package target without its version section in CHANGELOG is unproven', () => {
  const execute = executeMap(new Map([
    ['git rev-parse --verify --end-of-options HEAD^{commit}', COMMIT],
    [`git cat-file blob ${COMMIT}:package.json`, JSON.stringify(PACKAGE)],
    [`git cat-file blob ${COMMIT}:CHANGELOG.md`, '# Changelog\n\n## [0.78.0] — 2026-08-20\n- Older release.\n'],
  ]));
  const result = collectGitSubject({ repoRoot: 'C:\\worktree', targetRef: 'HEAD', execute });
  assert.equal(result.state, 'unproven');
  assert.equal(result.ok, false);
  assert.ok(result.reasonCodes.includes('PROVENANCE_CHANGELOG_VERSION_MISSING'));
  assert.equal(result.version, PACKAGE.version);
});

test('[req:PROV-5] foreign CI URL is rejected before network execution', () => {
  let called = false;
  const result = collectCiObservation({
    locator: 'https://github.com/other/project/actions/runs/42',
    repository: REPOSITORY,
    expectedCommit: COMMIT,
    execute: () => { called = true; },
  });
  assert.equal(called, false);
  assert.equal(result.state, 'conflict');
  assert.ok(result.reasonCodes.includes('PROVENANCE_REPOSITORY_MISMATCH'));
});

test('[req:PROV-5] successful CI observation is bound to repository and SHA', () => {
  const calls = [];
  const result = collectCiObservation({
    locator: 'https://github.com/rogersialves/wendkeep/actions/runs/42',
    repository: REPOSITORY,
    expectedCommit: COMMIT,
    execute: executeMap({
      'gh api --hostname github.com /repos/rogersialves/wendkeep/actions/runs/42': JSON.stringify({
        head_sha: COMMIT,
        conclusion: 'success',
        status: 'completed',
        repository: { full_name: REPOSITORY },
      }),
    }, calls),
  });
  assert.equal(result.state, 'verified');
  assert.equal(result.commit, COMMIT);
  assert.equal(result.repository, REPOSITORY);
  assert.equal(result.status, 'success');
  assert.deepEqual(calls[0].args.slice(0, 3), ['api', '--hostname', 'github.com']);
  assert.equal(calls[0].options.shell, false);
});

test('[req:PROV-5] completed CI without an explicit successful conclusion is not verified', () => {
  const result = collectCiObservation({
    locator: 'https://github.com/rogersialves/wendkeep/actions/runs/42',
    repository: REPOSITORY,
    expectedCommit: COMMIT,
    execute: executeMap({
      'gh api --hostname github.com /repos/rogersialves/wendkeep/actions/runs/42': JSON.stringify({
        head_sha: COMMIT,
        status: 'completed',
        conclusion: null,
        repository: { full_name: REPOSITORY },
      }),
    }),
  });
  assert.equal(result.state, 'reported');
  assert.equal(result.ok, false);
  assert.ok(result.reasonCodes.includes('PROVENANCE_CI_CONCLUSION_UNOBSERVED'));
  assert.notEqual(result.conclusion, 'success');
});

test('[req:PROV-5] successful conclusion without completed status remains reported', () => {
  const result = collectCiObservation({
    locator: 'https://github.com/rogersialves/wendkeep/actions/runs/42',
    repository: REPOSITORY,
    expectedCommit: COMMIT,
    execute: executeMap({
      'gh api --hostname github.com /repos/rogersialves/wendkeep/actions/runs/42': JSON.stringify({
        head_sha: COMMIT,
        conclusion: 'success',
        repository: { full_name: REPOSITORY },
      }),
    }),
  });
  assert.equal(result.state, 'reported');
  assert.ok(result.reasonCodes.includes('PROVENANCE_CI_INCOMPLETE'));
});

test('[req:PROV-5] CI timeout/offline remains reported and sanitizes stderr', () => {
  const execute = () => {
    const error = new Error('network token=secret-token C:\\private\\vault');
    error.code = 'ETIMEDOUT';
    error.stderr = 'Authorization: Bearer secret-token';
    throw error;
  };
  const result = collectCiObservation({
    locator: 'https://github.com/rogersialves/wendkeep/actions/runs/42',
    repository: REPOSITORY,
    expectedCommit: COMMIT,
    execute,
  });
  assert.equal(result.state, 'reported');
  assert.doesNotMatch(JSON.stringify(result), /secret-token|private\\vault/);
});

test('[req:PROV-6] tag observation rejects a tag that points to another SHA', () => {
  const result = collectTagObservation({
    repoRoot: 'C:\\worktree',
    tag: 'v0.79.0',
    expectedCommit: COMMIT,
    execute: executeMap({
      'git rev-parse --verify --end-of-options refs/tags/v0.79.0^{commit}': OTHER_COMMIT,
    }),
  });
  assert.equal(result.state, 'conflict');
  assert.ok(result.reasonCodes.includes('PROVENANCE_COMMIT_MISMATCH'));
});

test('[req:PROV-6] npm observation compares the published integrity', () => {
  const result = collectNpmObservation({
    name: PACKAGE.name,
    version: PACKAGE.version,
    expectedIntegrity: INTEGRITY,
    expectedCommit: COMMIT,
    repository: REPOSITORY,
    execute: () => JSON.stringify({
        name: PACKAGE.name,
        version: PACKAGE.version,
        dist: { integrity: INTEGRITY },
        gitHead: COMMIT,
        repository: { url: 'https://github.com/rogersialves/wendkeep.git' },
      }),
  });
  assert.equal(result.state, 'verified');
  assert.equal(result.integrity, INTEGRITY);
  assert.equal(result.commit, COMMIT);
  assert.equal(result.repository, REPOSITORY);
});

test('[req:PROV-5] npm provenance pins official registry and removes its empty ephemeral cache', () => {
  let cachePath = '';
  const result = collectNpmObservation({
    name: PACKAGE.name,
    version: PACKAGE.version,
    expectedIntegrity: INTEGRITY,
    expectedCommit: COMMIT,
    repository: REPOSITORY,
    execute(command, args, options) {
      assert.match(command, /^npm(?:\.cmd)?$/);
      assert.ok(args.includes('--registry=https://registry.npmjs.org/'));
      assert.ok(args.includes('--fetch-retries=0'));
      const cacheIndex = args.indexOf('--cache');
      assert.ok(cacheIndex >= 0);
      cachePath = args[cacheIndex + 1];
      assert.equal(existsSync(cachePath), true);
      assert.equal(options.shell, false);
      return JSON.stringify({
        name: PACKAGE.name,
        version: PACKAGE.version,
        dist: { integrity: INTEGRITY },
        gitHead: COMMIT,
        repository: { url: 'git+https://github.com/rogersialves/wendkeep.git' },
      });
    },
  });
  assert.equal(result.state, 'verified');
  assert.equal(result.commit, COMMIT);
  assert.equal(result.repository, REPOSITORY);
  assert.equal(result.status, 'published');
  assert.ok(cachePath);
  assert.equal(existsSync(cachePath), false);
});

test('[req:PROV-5] npm response without commit/repository binding cannot be verified', () => {
  const result = collectNpmObservation({
    name: PACKAGE.name,
    version: PACKAGE.version,
    expectedIntegrity: INTEGRITY,
    expectedCommit: COMMIT,
    repository: REPOSITORY,
    execute: () => JSON.stringify({
      name: PACKAGE.name, version: PACKAGE.version, dist: { integrity: INTEGRITY },
    }),
  });
  assert.equal(result.state, 'reported');
  assert.equal(result.ok, false);
  assert.ok(result.reasonCodes.includes('PROVENANCE_NPM_BINDING_UNOBSERVED'));
});

test('[req:PROV-5] npm network failure stays reported and cannot fall back to a persistent cache', () => {
  let cachePath = '';
  const offline = new Error('network unavailable');
  offline.code = 'ETIMEDOUT';
  const result = collectNpmObservation({
    name: PACKAGE.name,
    version: PACKAGE.version,
    expectedIntegrity: INTEGRITY,
    expectedCommit: COMMIT,
    repository: REPOSITORY,
    execute(command, args) {
      cachePath = args[args.indexOf('--cache') + 1];
      assert.equal(existsSync(cachePath), true);
      throw offline;
    },
  });
  assert.equal(result.state, 'reported');
  assert.ok(result.reasonCodes.includes('PROVENANCE_SOURCE_TIMEOUT'));
  assert.ok(cachePath);
  assert.equal(existsSync(cachePath), false);
});

test('[req:PROV-6] npm integrity divergence is a conflict', () => {
  const result = collectNpmObservation({
    name: PACKAGE.name,
    version: PACKAGE.version,
    expectedIntegrity: INTEGRITY,
    expectedCommit: COMMIT,
    repository: REPOSITORY,
    execute: () => JSON.stringify({
      name: PACKAGE.name,
      version: PACKAGE.version,
      dist: { integrity: 'sha512-other' },
      gitHead: COMMIT,
      repository: { url: 'https://github.com/rogersialves/wendkeep.git' },
    }),
  });
  assert.equal(result.state, 'conflict');
  assert.ok(result.reasonCodes.includes('PROVENANCE_INTEGRITY_MISMATCH'));
});

test('[req:PROV-6] GitHub Release verifies tag, commit, version and notes', () => {
  const result = collectGitHubReleaseObservation({
    repository: REPOSITORY,
    tag: 'v0.79.0',
    expectedCommit: COMMIT,
    expectedVersion: PACKAGE.version,
    expectedNotes: NOTES,
    execute: executeMap({
      'gh api --hostname github.com /repos/rogersialves/wendkeep/releases/tags/v0.79.0': JSON.stringify({
        tag_name: 'v0.79.0',
        target_commitish: COMMIT,
        body: NOTES,
        repository: { full_name: REPOSITORY },
      }),
      'gh api --hostname github.com /repos/rogersialves/wendkeep/git/ref/tags/v0.79.0': JSON.stringify({
        object: { type: 'commit', sha: COMMIT },
      }),
    }),
  });
  assert.equal(result.state, 'verified');
  assert.equal(result.commit, COMMIT);
  assert.equal(result.version, PACKAGE.version);
  assert.equal(result.status, 'published');
});

test('[req:PROV-6] symbolic target_commitish is verified through the authoritative tag ref', () => {
  const result = collectGitHubReleaseObservation({
    repository: REPOSITORY,
    tag: 'v0.79.0',
    expectedCommit: COMMIT,
    expectedVersion: PACKAGE.version,
    expectedNotes: NOTES,
    execute: executeMap({
      'gh api --hostname github.com /repos/rogersialves/wendkeep/releases/tags/v0.79.0': JSON.stringify({
        tag_name: 'v0.79.0',
        target_commitish: 'main',
        body: NOTES,
        repository: { full_name: REPOSITORY },
      }),
      'gh api --hostname github.com /repos/rogersialves/wendkeep/git/ref/tags/v0.79.0': JSON.stringify({
        object: { type: 'commit', sha: COMMIT },
      }),
    }),
  });
  assert.equal(result.state, 'verified');
  assert.equal(result.commit, COMMIT);
  assert.equal(result.target_commitish, 'main');
});

test('[req:PROV-5] unavailable tag ref leaves a symbolic GitHub Release reported', () => {
  const offline = new Error('offline');
  offline.code = 'ETIMEDOUT';
  const result = collectGitHubReleaseObservation({
    repository: REPOSITORY,
    tag: 'v0.79.0',
    expectedCommit: COMMIT,
    expectedVersion: PACKAGE.version,
    expectedNotes: NOTES,
    execute: executeMap({
      'gh api --hostname github.com /repos/rogersialves/wendkeep/releases/tags/v0.79.0': JSON.stringify({
        tag_name: 'v0.79.0', target_commitish: 'main', body: NOTES,
      }),
      'gh api --hostname github.com /repos/rogersialves/wendkeep/git/ref/tags/v0.79.0': offline,
    }),
  });
  assert.equal(result.state, 'reported');
  assert.equal(result.ok, false);
  assert.ok(result.reasonCodes.includes('PROVENANCE_SOURCE_TIMEOUT'));
});

test('[req:PROV-6] tag ref resolving to another commit conflicts even when target_commitish is symbolic', () => {
  const result = collectGitHubReleaseObservation({
    repository: REPOSITORY,
    tag: 'v0.79.0',
    expectedCommit: COMMIT,
    expectedVersion: PACKAGE.version,
    expectedNotes: NOTES,
    execute: executeMap({
      'gh api --hostname github.com /repos/rogersialves/wendkeep/releases/tags/v0.79.0': JSON.stringify({
        tag_name: 'v0.79.0', target_commitish: 'main', body: NOTES,
      }),
      'gh api --hostname github.com /repos/rogersialves/wendkeep/git/ref/tags/v0.79.0': JSON.stringify({
        object: { type: 'commit', sha: OTHER_COMMIT },
      }),
    }),
  });
  assert.equal(result.state, 'conflict');
  assert.ok(result.reasonCodes.includes('PROVENANCE_COMMIT_MISMATCH'));
});

test('[req:PROV-6] annotated GitHub tags are dereferenced until the commit object', () => {
  const tagObject = 'c'.repeat(40);
  const result = collectGitHubReleaseObservation({
    repository: REPOSITORY,
    tag: 'v0.79.0',
    expectedCommit: COMMIT,
    expectedVersion: PACKAGE.version,
    expectedNotes: NOTES,
    execute: executeMap({
      'gh api --hostname github.com /repos/rogersialves/wendkeep/releases/tags/v0.79.0': JSON.stringify({
        tag_name: 'v0.79.0', target_commitish: 'main', body: NOTES,
      }),
      'gh api --hostname github.com /repos/rogersialves/wendkeep/git/ref/tags/v0.79.0': JSON.stringify({
        object: { type: 'tag', sha: tagObject },
      }),
      [`gh api --hostname github.com /repos/rogersialves/wendkeep/git/tags/${tagObject}`]: JSON.stringify({
        object: { type: 'commit', sha: COMMIT },
      }),
    }),
  });
  assert.equal(result.state, 'verified');
  assert.equal(result.commit, COMMIT);
});

test('[req:PROV-6] GitHub Release notes/version mismatch is a conflict', () => {
  const result = collectGitHubReleaseObservation({
    repository: REPOSITORY,
    tag: 'v0.79.0',
    expectedCommit: COMMIT,
    expectedVersion: PACKAGE.version,
    expectedNotes: NOTES,
    execute: executeMap({
      'gh api --hostname github.com /repos/rogersialves/wendkeep/releases/tags/v0.79.0': JSON.stringify({
        tag_name: 'v0.79.1',
        target_commitish: COMMIT,
        body: 'different notes',
      }),
    }),
  });
  assert.equal(result.state, 'conflict');
  assert.ok(result.reasonCodes.includes('PROVENANCE_TAG_MISMATCH'));
  assert.ok(result.reasonCodes.includes('PROVENANCE_NOTES_MISMATCH'));
});

test('[req:PROV-5] missing external evidence is unproven and never verified', () => {
  assert.equal(collectCiObservation({ repository: REPOSITORY, expectedCommit: COMMIT }).state, 'unproven');
  assert.equal(collectNpmObservation({ name: PACKAGE.name, version: PACKAGE.version }).state, 'unproven');
});

test('[req:PROV-6] git helpers use one argument per path and cannot inject shell syntax', () => {
  const calls = [];
  const execute = executeMap(new Map([
    ['git cat-file blob abc123:package.json', '{"name":"x"}'],
    ['git cat-file blob abc123:CHANGELOG.md', 'notes'],
  ]), calls);
  assert.deepEqual(readJsonAtCommit('C:\\worktree', 'abc123', 'package.json', { execute }), { name: 'x' });
  assert.equal(readTextAtCommit('C:\\worktree', 'abc123', 'CHANGELOG.md', { execute }), 'notes');
  assert.equal(calls[0].args.some((arg) => arg.includes(';')), false);
  assert.equal(calls[0].options.shell, false);
});

test('[req:PROV-6] tracked text reads the immutable blob without textconv or worktree config filters', () => {
  const calls = [];
  const text = readTextAtCommit('C:\\worktree', COMMIT, 'CHANGELOG.md', {
    execute(command, args, options) {
      calls.push({ command, args, options });
      return 'raw blob bytes';
    },
  });
  assert.equal(text, 'raw blob bytes');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'git');
  assert.deepEqual(calls[0].args, ['cat-file', 'blob', `${COMMIT}:CHANGELOG.md`]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].args.includes('--textconv'), false);
});
