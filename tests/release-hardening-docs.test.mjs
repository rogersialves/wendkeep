import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('package.json'));
const publicDomainSubpaths = Object.entries(manifest.exports)
  .filter(([key, target]) => /^\.\/[a-z-]+$/.test(key)
    && /^\.\/packages\/[a-z-]+\/src\/index\.mjs$/.test(String(target)))
  .map(([key]) => `wendkeep/${key.slice(2)}`)
  .sort();

function documentedSubpaths(section) {
  return [...new Set(section.match(/wendkeep\/[a-z-]+/g) || [])].sort();
}

test('[req:DOC-84-1] compatibility and support policies have semantic PT-BR/EN parity', () => {
  const docs = {
    compatibilityPt: read('docs/pt-BR/compatibility.md'),
    compatibilityEn: read('docs/en/compatibility.md'),
    supportPt: read('docs/pt-BR/support-policy.md'),
    supportEn: read('docs/en/support-policy.md'),
  };
  assert.match(docs.compatibilityPt, /Core[^]*Node\.js 18[^]*Node\.js 20/i);
  assert.match(docs.compatibilityEn, /Core[^]*Node\.js 18[^]*Node\.js 20/i);
  assert.match(docs.compatibilityPt, /Observer[^]*22\.13[^]*24[^]*Linux[^]*Windows[^]*macOS/i);
  assert.match(docs.compatibilityEn, /Observer[^]*22\.13[^]*24[^]*Linux[^]*Windows[^]*macOS/i);
  assert.match(docs.compatibilityPt, /0\.x[^]*(?:duas versões minor|dois minors)[^]*1\.0/i);
  assert.match(docs.compatibilityEn, /0\.x[^]*two minor releases[^]*1\.0/i);
  assert.match(docs.supportPt, /0\.90[^]*0\.89[^]*0\.88[^]*sem SLA/i);
  assert.match(docs.supportEn, /0\.90[^]*0\.89[^]*0\.88[^]*no SLA/i);
  for (const text of Object.values(docs)) assert.match(text, /local-first/i);
});

test('[req:DOC-84-2] migration and architecture docs describe public facades and recovery contract', () => {
  const migrationPt = read('docs/pt-BR/migrations.md');
  const migrationEn = read('docs/en/migrations.md');
  for (const text of [migrationPt, migrationEn]) {
    assert.match(text, /N-2[^]*N-1/);
    assert.match(text, /journal[^]*checksum[^]*backup[^]*rollback[^]*repair/i);
    assert.match(text, /Vault[^]*ledger[^]*active.contexts[^]*Observer[^]*portable/is);
    assert.match(text, /memory[^]*contracts[^]*evidence/is);
  }
  for (const path of ['docs/pt-BR/architecture.md', 'docs/en/architecture.md']) {
    const architecture = read(path);
    for (const surface of [
      'vault', 'harness', 'contracts', 'evidence', 'worktrees',
      'observer', 'sync', 'integrations', 'mcp', 'migrations',
    ]) {
      assert.match(architecture, new RegExp(`\\b${surface}\\b`, 'i'), `${path} misses ${surface}`);
    }
    assert.match(architecture, /composition root/i);
    assert.match(architecture, /acyclic|ac[ií]clic/i);
    const publicGraph = architecture.match(/## 0\.90[^]*?(?=\n## )/)?.[0] || '';
    assert.deepEqual(
      documentedSubpaths(publicGraph),
      publicDomainSubpaths,
      `${path} must document exactly the public domain exports`,
    );
    assert.doesNotMatch(publicGraph, /wendkeep\/integrations/);
  }
});

test('[req:CI-SC-8] required checks are versioned and rendered locally without changing GitHub', () => {
  const config = JSON.parse(read('.github/required-checks.json'));
  assert.equal(config.branch, 'main');
  assert.equal(config.strict, true);
  assert.deepEqual(config.checks, [
    'test / full',
    'security / codeql',
    'security / dependency-review',
  ]);
  const script = read('scripts/required-checks.mjs');
  assert.match(script, /required_status_checks/);
  assert.doesNotMatch(script, /gh\s+api|fetch\(|https\.request|execFile|spawn/);
});
