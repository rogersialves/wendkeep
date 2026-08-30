#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmExecutorSpec } from './release-plan.mjs';
import {
  evaluateReleaseProvenance,
  extractVerifiedNpmAttestation,
  packIntegrityInIsolatedCopy,
  packageHasSelfDependency,
} from '../src/release-provenance.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRE_PUBLISHED = process.argv.includes('--require-published');
const AS_JSON = process.argv.includes('--json');
const AUDIT_NPM_VERSION = '11.19.1';

function run(command, args, { shell = false } = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function runNpm(args) {
  const spec = npmExecutorSpec(args);
  return run(spec.command, spec.args, { shell: spec.shell });
}

function optional(execute) {
  try { return execute(); } catch { return ''; }
}

function packIntegrity() {
  return packIntegrityInIsolatedCopy(ROOT);
}

function verifiedPublishedAttestation({ name, version, integrity, repository, commit }) {
  const auditRoot = mkdtempSync(join(tmpdir(), 'wendkeep-release-audit-'));
  try {
    runNpm([
      'install', '--prefix', auditRoot, '--ignore-scripts', '--no-audit', '--no-fund',
      `${name}@${version}`,
    ]);
    const npx = npmExecutorSpec([
      'exec', '--yes', `npm@${AUDIT_NPM_VERSION}`, '--',
      'audit', 'signatures', '--prefix', auditRoot, '--json', '--include-attestations',
    ]);
    const audit = JSON.parse(run(npx.command, npx.args, { shell: npx.shell }));
    return extractVerifiedNpmAttestation(audit, {
      name, version, integrity, repository, commit,
    });
  } finally {
    rmSync(auditRoot, { recursive: true, force: true });
  }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
if (packageHasSelfDependency(pkg)) {
  console.error(`release provenance: ${pkg.name} não pode depender de si próprio.`);
  process.exit(1);
}

const tag = `v${pkg.version}`;
const headCommit = run('git', ['rev-parse', 'HEAD']);
const tagCommit = optional(() => run('git', ['rev-list', '-n', '1', `refs/tags/${tag}`]));
const publishedIntegrity = optional(() => runNpm([
  'view', `${pkg.name}@${pkg.version}`, 'dist.integrity', '--prefer-online',
]));
const localIntegrity = publishedIntegrity ? packIntegrity() : '';
const publishedAttestation = publishedIntegrity
  ? optional(() => verifiedPublishedAttestation({
    name: pkg.name,
    version: pkg.version,
    integrity: publishedIntegrity,
    repository: pkg.repository?.url || pkg.repository,
    commit: headCommit,
  })) || null
  : null;
const result = evaluateReleaseProvenance({
  name: pkg.name,
  version: pkg.version,
  headCommit,
  tagCommit,
  publishedIntegrity,
  localIntegrity,
  publishedAttestation,
  repository: pkg.repository?.url || pkg.repository,
  requirePublished: REQUIRE_PUBLISHED,
});

if (AS_JSON) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else process.stdout.write(`${result.ok ? '✓' : '✖'} ${result.message || `${result.tag} ${result.code}`}\n`);
if (!result.ok) process.exit(1);
