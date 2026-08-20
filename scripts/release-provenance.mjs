#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmExecutorSpec } from './release-plan.mjs';
import {
  evaluateReleaseProvenance,
  packageHasSelfDependency,
} from '../src/release-provenance.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRE_PUBLISHED = process.argv.includes('--require-published');
const AS_JSON = process.argv.includes('--json');

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
  const raw = runNpm(['pack', '--dry-run', '--json', '--ignore-scripts']);
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end < start) return '';
  return String(JSON.parse(raw.slice(start, end + 1))[0]?.integrity || '');
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
const result = evaluateReleaseProvenance({
  name: pkg.name,
  version: pkg.version,
  headCommit,
  tagCommit,
  publishedIntegrity,
  localIntegrity,
  requirePublished: REQUIRE_PUBLISHED,
});

if (AS_JSON) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else process.stdout.write(`${result.ok ? '✓' : '✖'} ${result.message || `${result.tag} ${result.code}`}\n`);
if (!result.ok) process.exit(1);
