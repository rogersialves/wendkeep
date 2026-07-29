// Tarball smoke test (debt fix 3a): assert the published npm package actually
// ships every file the hooks need. Catches a future .npmignore / rename / files[]
// edit that would publish a package whose hooks fail at `import` after install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_FILES } from '../src/taxonomy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

// Files that `npm publish` would include, per `npm pack`.
// Command is a single string with shell:true (npm is a .cmd shim on Windows); this
// also avoids DEP0190, which only fires when an args array is combined with shell.
function publishedFiles() {
  const r = spawnSync('npm pack --dry-run --json', {
    cwd: pkgRoot,
    encoding: 'utf8',
    shell: true,
  });
  assert.equal(r.status, 0, `npm pack failed:\n${r.stderr}`);
  const raw = r.stdout.slice(r.stdout.indexOf('['), r.stdout.lastIndexOf(']') + 1);
  const meta = JSON.parse(raw);
  return new Set((meta[0]?.files || []).map((f) => f.path.replace(/\\/g, '/')));
}

// Relative ESM specifiers (static + dynamic) referenced by a source file.
function relativeImports(code) {
  const specifiers = [];
  const re = /(?:from|import)\s*(?:\(\s*)?['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(code)) !== null) specifiers.push(m[1]);
  return specifiers;
}

test('every HOOK_FILES entry is in the published tarball', () => {
  const published = publishedFiles();
  for (const f of HOOK_FILES) {
    assert.ok(published.has(`hooks/${f}`), `missing from package: hooks/${f}`);
  }
});

test('every relative import in hooks/ resolves to a published file', () => {
  const published = publishedFiles();
  const hooksDir = join(pkgRoot, 'hooks');
  const mjs = readdirSync(hooksDir).filter((f) => f.endsWith('.mjs'));

  for (const file of mjs) {
    const code = readFileSync(join(hooksDir, file), 'utf8');
    for (const spec of relativeImports(code)) {
      // resolve spec relative to hooks/<file>, expressed as a posix package path
      const target = posix.normalize(posix.join('hooks', posix.dirname(file), spec));
      assert.ok(
        published.has(target),
        `${file} imports "${spec}" -> ${target}, not in published package`,
      );
    }
  }
});

test('every published hook passes node --check (no broken syntax shipped)', () => {
  const hooksDir = join(pkgRoot, 'hooks');
  const mjs = readdirSync(hooksDir).filter((f) => f.endsWith('.mjs'));
  for (const file of mjs) {
    const r = spawnSync(process.execPath, ['--check', join(hooksDir, file)], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `node --check failed for ${file}:\n${r.stderr}`);
  }
});

test('[req:MOD-4] [req:MOD-8] [req:MOD-10] [req:MOD-11] [req:MOD-12] [req:MOD-13] [req:MOD-16] published tarball contains the modular surfaces', () => {
  const published = publishedFiles();
  for (const path of [
    'packages/cli/package.json',
    'packages/cli/src/index.mjs',
    'packages/harness/package.json',
    'packages/harness/src/flow-store.mjs',
    'packages/harness/src/index.mjs',
    'packages/harness/src/operating-profile.mjs',
    'packages/harness/src/sensors-core.mjs',
    'packages/mcp/package.json',
    'packages/integrations/package.json',
    'packages/pi/package.json',
    'packages/vault/package.json',
    'packages/vault/src/index.mjs',
    'packages/vault/src/locale.mjs',
    'packages/vault/src/memory-handoff.mjs',
    'packages/vault/src/memory-mode.mjs',
    'packages/vault/src/memory-schema.mjs',
    'packages/vault/src/memory-store.mjs',
    'packages/vault/src/project-vault.mjs',
    'packages/vault/src/validate-core.mjs',
    'packages/vault/src/validate-memory.mjs',
    'packages/vault/src/vault-path-safety.mjs',
  ]) {
    assert.ok(published.has(path), `missing modular file from package: ${path}`);
  }
});

test('[req:MOD-14] [req:MOD-16] CLI workspace declares its private runtime without publishing wendkeep/cli', () => {
  const root = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  const cli = JSON.parse(readFileSync(join(pkgRoot, 'packages', 'cli', 'package.json'), 'utf8'));

  assert.equal(cli.private, true);
  assert.equal(cli.exports, './src/index.mjs');
  assert.equal(Object.hasOwn(root.exports, './cli'), false);
});

test('[req:MOD-4] [req:MOD-6] [req:MOD-9] [req:MOD-10] [req:MOD-11] [req:MOD-12] [req:MOD-13] [req:MOD-16] installed tarball exposes strict canonical, public, and legacy identities', () => {
  const temp = mkdtempSync(join(tmpdir(), 'wendkeep-installed-tarball-'));
  try {
    const packed = spawnSync(`npm pack --json --pack-destination "${temp}"`, {
      cwd: pkgRoot,
      encoding: 'utf8',
      shell: true,
    });
    assert.equal(packed.status, 0, `npm pack failed:\n${packed.stderr}`);
    const meta = JSON.parse(packed.stdout.slice(
      packed.stdout.indexOf('['),
      packed.stdout.lastIndexOf(']') + 1,
    ));
    const tarball = join(temp, meta[0].filename);
    const consumer = join(temp, 'consumer');
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
    const installed = spawnSync(`npm install --ignore-scripts --no-audit --no-fund "${tarball}"`, [], {
      cwd: consumer,
      encoding: 'utf8',
      shell: true,
    });
    assert.equal(installed.status, 0, `npm install failed:\n${installed.stderr}`);

    const imported = spawnSync(process.execPath, ['--input-type=module', '--eval', [
      "const vault = await import('wendkeep/vault');",
      "const harness = await import('wendkeep/harness');",
      "const canonicalLocale = await import('wendkeep/packages/vault/src/locale.mjs');",
      "const canonicalFlowStore = await import('wendkeep/packages/harness/src/flow-store.mjs');",
      "const legacyLocale = await import('wendkeep/hooks/locale.mjs');",
      "const legacy = await import('wendkeep/hooks/vault-path-safety.mjs');",
      "const legacyStore = await import('wendkeep/hooks/memory-store.mjs');",
      "const legacyFlowStore = await import('wendkeep/hooks/vault-runtime-store.mjs');",
      "const legacyProfile = await import('wendkeep/src/operating-profile.mjs');",
      "const legacySensors = await import('wendkeep/hooks/sensors-core.mjs');",
      "if (typeof vault.resolveProjectVault !== 'function') process.exit(11);",
      "if (typeof legacy.assertVaultPathSafe !== 'function') process.exit(12);",
      "const shared = vault.renderSharedMemory({ updatedAt: '2026-07-28T00:00:00.000Z', reviewAfter: '2026-08-04T00:00:00.000Z' });",
      "if (!vault.validateSharedMemory(shared).ok) process.exit(13);",
      "if (!vault.validateCore(vault.renderCoreSkeleton()).ok) process.exit(14);",
      "if (legacyStore.MemoryEventCollision !== vault.MemoryEventCollision) process.exit(15);",
      "if (legacyStore.MEMORY_LOCK_BUSY !== vault.MEMORY_LOCK_BUSY) process.exit(16);",
      "if (harness.normalizeOperatingProfile !== legacyProfile.normalizeOperatingProfile) process.exit(17);",
      "if (harness.OPERATING_PROFILE_POLICIES !== legacyProfile.OPERATING_PROFILE_POLICIES) process.exit(18);",
      "if (harness.runSensors !== legacySensors.runSensors) process.exit(19);",
      "if (harness.sensorProcessEnv !== legacySensors.sensorProcessEnv) process.exit(20);",
      "const off = harness.operatingProfilePolicy('OFF');",
      "if (off.keepCore !== true || off.harness !== false || off.contract !== 'native') process.exit(21);",
      "if (vault.canonicalMemoryJson({ z: 1, a: 2 }) !== '{\"a\":2,\"z\":1}') process.exit(22);",
      "for (const [name, value] of Object.entries(canonicalLocale)) {",
      "  if (vault[name] !== value || legacyLocale[name] !== value) process.exit(23);",
      "}",
      "for (const [name, value] of Object.entries(canonicalFlowStore)) {",
      "  if (harness[name] !== value || legacyFlowStore[name] !== value) process.exit(24);",
      "}",
      "const { join } = await import('node:path');",
      "const { mkdirSync } = await import('node:fs');",
      "const runtimeVault = join(process.cwd(), 'consumer-vault');",
      "mkdirSync(runtimeVault, { recursive: true });",
      "const contract = (flowId, sessionId) => ({",
      "  schema_version: 1, flow_id: flowId, session_id: sessionId,",
      "  session_file: '02-Sessões/installed.md', slug: `slug-${flowId}`, profile: 'FLOW',",
      "  started_at: '2026-07-28T12:00:00.000Z', reason: 'installed tarball proof',",
      "  spec_impact: 'none', project_rel: '.', protected_roots: [],",
      "  allowed_paths: ['src/a.mjs'], sensor_ids: ['tests'], sensor_definition_hash: 'hash',",
      "  baseline: { schema_version: 1, root: 'C:/consumer', head: 'abc', fingerprints: {},",
      "    git_metadata_fingerprint: 'a'.repeat(64), hidden_index_paths: [],",
      "    unsafe_git_metadata_paths: [], unsafe_worktree_paths: [] },",
      "});",
      "const finishedContract = contract('flow-finished', 'session-finished');",
      "canonicalFlowStore.createFlowContract(runtimeVault, finishedContract);",
      "canonicalFlowStore.appendFlowAttempt(runtimeVault, 'session-finished', 'flow-finished', {",
      "  schema_version: 1, attempt_id: 'attempt-1', status: 'red',",
      "  recorded_at: '2026-07-28T12:01:00.000Z', failures: ['expected red'],",
      "  changed_paths: ['src/a.mjs'], evidence: [{ id: 'tests', status: 'red',",
      "    ts: '2026-07-28T12:01:00.000Z', severity: 'critical' }],",
      "});",
      "canonicalFlowStore.writeFlowReceipt(runtimeVault, 'session-finished', 'flow-finished', {",
      "  schema_version: 1, flow_id: 'flow-finished', status: 'finished',",
      "  finished_at: '2026-07-28T12:02:00.000Z', reason: finishedContract.reason,",
      "  allowed_paths: finishedContract.allowed_paths, sensor_ids: finishedContract.sensor_ids,",
      "  changed_paths: ['src/a.mjs'], evidence: [{ id: 'tests', status: 'green',",
      "    ts: '2026-07-28T12:02:00.000Z', severity: 'critical' }],",
      "  baseline_head: 'abc', final_head: 'abc',",
      "});",
      "const finished = canonicalFlowStore.readFlow(runtimeVault, { sessionId: 'session-finished', flowId: 'flow-finished' });",
      "if (finished.state !== 'finished' || finished.attempts.length !== 1) process.exit(25);",
      "const promotedContract = contract('flow-promoted', 'session-promoted');",
      "canonicalFlowStore.createFlowContract(runtimeVault, promotedContract);",
      "canonicalFlowStore.reserveFlowPromotion(runtimeVault, 'session-promoted', 'flow-promoted', {",
      "  schema_version: 1, flow_id: 'flow-promoted', status: 'promoting',",
      "  reserved_at: '2026-07-28T12:03:00.000Z', change_slug: 'installed-change',",
      "  change_rel: '08-Mudanças/installed-change', origin: { schema_version: 1,",
      "    flow_id: 'flow-promoted', promoted_at: '2026-07-28T12:03:00.000Z',",
      "    contract: promotedContract, attempts: [], observed_git: { baseline_head: 'abc',",
      "      current_head: 'abc', head_changed: false, changed_paths: ['src/a.mjs'] } },",
      "});",
      "canonicalFlowStore.writeFlowPromotion(runtimeVault, 'session-promoted', 'flow-promoted', {",
      "  schema_version: 1, flow_id: 'flow-promoted', status: 'promoted',",
      "  promoted_at: '2026-07-28T12:03:00.000Z', change_slug: 'installed-change',",
      "  change_rel: '08-Mudanças/installed-change',",
      "  origin_file: '08-Mudanças/installed-change/flow-origin.json',",
      "  changed_paths: ['src/a.mjs'], baseline_head: 'abc', current_head: 'abc',",
      "});",
      "const promoted = canonicalFlowStore.readFlow(runtimeVault, { sessionId: 'session-promoted', flowId: 'flow-promoted' });",
      "if (promoted.state !== 'promoted' || canonicalFlowStore.listFlows(runtimeVault).length !== 2) process.exit(26);",
    ].join('\n')], { cwd: consumer, encoding: 'utf8' });
    assert.equal(imported.status, 0, `installed imports failed:\n${imported.stderr}`);

    const cli = spawnSync(process.execPath, [
      join(consumer, 'node_modules', 'wendkeep', 'bin', 'wendkeep.mjs'),
      '--help',
    ], { cwd: consumer, encoding: 'utf8' });
    assert.equal(cli.status, 0, `installed CLI failed:\n${cli.stderr}`);
    assert.match(cli.stdout, /wendkeep/);

    const installedVersion = JSON.parse(readFileSync(
      join(consumer, 'node_modules', 'wendkeep', 'package.json'),
      'utf8',
    )).version;
    for (const alias of ['wendkeep', 'wk']) {
      const executable = join(consumer, 'node_modules', '.bin', alias);
      const versionResult = spawnSync(`"${executable}" --version`, {
        cwd: consumer,
        encoding: 'utf8',
        shell: true,
      });
      assert.equal(versionResult.status, 0, `${alias} failed:\n${versionResult.stderr}`);
      assert.equal(versionResult.stdout.trim(), installedVersion);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
