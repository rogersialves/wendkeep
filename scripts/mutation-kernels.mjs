#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CRITICAL_MUTANTS = Object.freeze([
  Object.freeze({
    id: 'task-requirement-parser-bypass',
    domain: 'contracts', package: '@wendkeep/contracts',
    file: 'packages/contracts/src/task-parser.mjs',
    search: "if (reqs.length) text = text.replace(reqReG, '');",
    replacement: "if (false) text = text.replace(reqReG, '');",
    tests: ['tests/task-contracts.test.mjs'],
  }),
  Object.freeze({
    id: 'evidence-binding-bypass',
    domain: 'evidence', package: '@wendkeep/evidence',
    file: 'packages/evidence/src/provenance-gate.mjs',
    search: "if (binding?.state === 'bound') {",
    replacement: 'if (false) {',
    tests: ['tests/provenance-gate.test.mjs'],
  }),
  Object.freeze({
    id: 'migration-checksum-bypass',
    domain: 'migrations', package: '@wendkeep/migrations',
    file: 'packages/migrations/src/runner.mjs',
    search: "if (!journalStep.expected_after_sha256\n        || hashMigrationState(state) !== journalStep.expected_after_sha256) {",
    replacement: 'if (false) {',
    tests: ['tests/migration-crash-repair.test.mjs'],
  }),
  Object.freeze({
    id: 'observer-project-authz-bypass',
    domain: 'observer', package: '@wendkeep/observer',
    file: 'packages/observer/src/authz.mjs',
    search: "if (!principal.project_ids?.includes('*') && !principal.project_ids?.includes(projectId)) {",
    replacement: 'if (false) {',
    tests: ['tests/observer-authz.test.mjs'],
  }),
  Object.freeze({
    id: 'bridge-adapter-contract-bypass',
    domain: 'integrations', package: '@wendkeep/integrations',
    file: 'packages/integrations/src/bridge-contract.mjs',
    search: 'if (value?.origin?.tool !== SPEC_PROJECTION_ADAPTER || value?.origin?.version !== value?.adapter_version',
    replacement: 'if (false || value?.origin?.version !== value?.adapter_version',
    tests: ['tests/ecosystem-bridge-contract.test.mjs'],
  }),
  Object.freeze({
    id: 'canonical-message-preservation-bypass',
    domain: 'commit', package: '@wendkeep/commit',
    file: 'packages/commit/src/commit-message.mjs',
    search: "if (source || /^WendKeep-Commit:\\s*v1$/m.test(existing)) return existing;",
    replacement: 'if (source) return existing;',
    tests: ['tests/commit-message.test.mjs'],
  }),
  Object.freeze({
    id: 'private-sync-payload-validation-bypass',
    domain: 'sync', package: '@wendkeep/sync',
    file: 'packages/sync/src/sync-protocol.mjs',
    search: "if (privacy === 'private') validatePrivatePayload(payload);",
    replacement: 'if (false) validatePrivatePayload(payload);',
    tests: ['tests/sync-protocol.test.mjs'],
  }),
  Object.freeze({
    id: 'vault-secret-validation-bypass',
    domain: 'vault', package: '@wendkeep/vault',
    file: 'packages/vault/src/core-validator.mjs',
    search: 'if (match) errors.push(`Possível ${name} detectado: "${match[0].slice(0, 30)}..." — substituir por [REDACTED_SECRET].`);',
    replacement: 'if (false) errors.push(name);',
    tests: ['tests/validate-core.test.mjs'],
  }),
  Object.freeze({
    id: 'adaptive-profile-validation-bypass',
    domain: 'harness', package: '@wendkeep/harness',
    file: 'packages/harness/src/operating-profile.mjs',
    search: 'if (ADAPTIVE_PROFILE_SET.has(profile)) return profile;',
    replacement: 'if (false) return profile;',
    tests: ['tests/operating-profile.test.mjs'],
  }),
  Object.freeze({
    id: 'mcp-client-validation-bypass',
    domain: 'mcp', package: '@wendkeep/mcp',
    file: 'packages/mcp/src/config.mjs',
    search: "if (!['generic', 'claude', 'cursor'].includes(selected)) {",
    replacement: 'if (false) {',
    tests: ['tests/mcp-config-boundary.test.mjs'],
  }),
  Object.freeze({
    id: 'worktree-composition-authority-bypass',
    domain: 'worktrees', package: '@wendkeep/worktrees',
    file: 'packages/worktrees/src/worktree-cleanup.mjs',
    search: 'if (!controlPlaneComposition) {',
    replacement: 'if (false) {',
    tests: ['tests/worktree-cleanup.test.mjs'],
  }),
]);

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));

function materializeWorkingTree(checkout) {
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (listed.status !== 0) throw new Error(`cannot inventory mutation checkout: ${listed.stderr}`);
  for (const relativeFile of listed.stdout.split('\0').filter(Boolean)) {
    const source = resolve(root, relativeFile);
    const fromRoot = relative(root, source);
    if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
      throw new Error(`unsafe mutation path: ${relativeFile}`);
    }
    if (!existsSync(source)) continue;
    const destination = join(checkout, relativeFile);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}

function runMutant(mutant) {
  const temporary = mkdtempSync(join(tmpdir(), 'wendkeep-mutant-'));
  const checkout = join(temporary, 'checkout');
  try {
    mkdirSync(checkout);
    materializeWorkingTree(checkout);
    const path = join(checkout, ...mutant.file.split('/'));
    const source = readFileSync(path, 'utf8');
    const occurrences = source.split(mutant.search).length - 1;
    if (occurrences !== 1) throw new Error(`${mutant.id}: expected one mutation site, found ${occurrences}`);
    writeFileSync(path, source.replace(mutant.search, mutant.replacement), 'utf8');
    const result = spawnSync(process.execPath, ['--test', ...mutant.tests], {
      cwd: checkout, encoding: 'utf8', timeout: 180_000,
    });
    if (result.status === 0) {
      const error = new Error(`${mutant.id} survived its discriminating tests`);
      error.code = 'WENDKEEP_MUTANT_SURVIVED';
      throw error;
    }
    return { id: mutant.id, status: 'killed' };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--list')) {
    process.stdout.write(`${JSON.stringify(CRITICAL_MUTANTS, null, 2)}\n`);
    process.exit(0);
  }
  const requested = process.argv.includes('--scope')
    ? process.argv[process.argv.indexOf('--scope') + 1]
    : '';
  const mutants = requested
    ? CRITICAL_MUTANTS.filter((mutant) => mutant.domain === requested)
    : CRITICAL_MUTANTS;
  if (!mutants.length) {
    process.stderr.write(`unknown mutation scope: ${requested}\n`);
    process.exit(2);
  }
  const results = mutants.map(runMutant);
  process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`);
}
