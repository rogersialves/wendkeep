// Tarball smoke test (debt fix 3a): assert the published npm package actually
// ships every file the hooks need. Catches a future .npmignore / rename / files[]
// edit that would publish a package whose hooks fail at `import` after install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_FILES } from '../src/taxonomy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const OBSERVABILITY_HOOK_MODULES = Object.freeze([
  'codex-rollout-meta.mjs',
  'codex-subagent-graph.mjs',
  'session-observability-state.mjs',
  'session-observability-store.mjs',
  'session-observability-lifecycle.mjs',
]);

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

test('[req:OBS-3] [req:OBS-11] [req:OBS-12] Codex observability modules ship together', () => {
  const published = publishedFiles();
  for (const file of OBSERVABILITY_HOOK_MODULES) {
    assert.ok(published.has(`hooks/${file}`), `missing observability module: hooks/${file}`);
  }
});

test('[req:OBS-14] published tarball excludes local vault and runtime state', () => {
  const published = [...publishedFiles()];
  const forbidden = published.filter((path) => (
    /(^|\/)\.brain(?:\/|$)/i.test(path)
    || /(^|\/)\.[^/]+-vault(?:\/|$)/i.test(path)
    || /(^|\/)(?:SESSION_REGISTRY\.json|CURRENT_SESSION\.md|MEMORY_EVENTS\.jsonl|SHARED_MEMORY\.md)$/i.test(path)
  ));

  assert.deepEqual(forbidden, []);
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

test('[req:MOD-4] [req:MOD-8] [req:MOD-10] [req:MOD-11] [req:MOD-12] [req:MOD-13] [req:MOD-16] [req:MOD-19] [req:MOD-20] [req:MOD-22] published tarball contains the modular surfaces', () => {
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
    'packages/mcp/src/config.mjs',
    'packages/mcp/src/index.mjs',
    'packages/integrations/package.json',
    'packages/integrations/src/capabilities.mjs',
    'packages/integrations/src/bridge-config.mjs',
    'packages/integrations/src/bridge-contract.mjs',
    'packages/integrations/src/bridge-diagnostics.mjs',
    'packages/integrations/src/ecosystem-bridge.mjs',
    'packages/integrations/src/hook-envelope.mjs',
    'packages/integrations/src/host-hooks.mjs',
    'packages/integrations/src/index.mjs',
    'packages/integrations/src/prompt-content.mjs',
    'packages/integrations/src/session-identity.mjs',
    'packages/integrations/src/transcript-usage.mjs',
    'packages/integrations/src/transcripts.mjs',
    'packages/integrations/src/spec-kit-adapter.mjs',
    'packages/integrations/src/superpowers-adapter.mjs',
    'schema/ecosystem-bridge-v1.schema.json',
    'src/ecosystem-bridges.mjs',
    'packages/pi/package.json',
    'packages/pi/src/index.mjs',
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

test('[req:COMMIT-20] published tarball contains the commit kernel, hooks, schema, gate and bilingual docs', () => {
  const published = publishedFiles();
  for (const path of [
    '.githooks/prepare-commit-msg',
    '.githooks/commit-msg',
    'packages/commit/package.json',
    'packages/commit/src/index.mjs',
    'packages/commit/src/commit-input.mjs',
    'packages/commit/src/commit-message.mjs',
    'packages/commit/src/commit-policy.mjs',
    'packages/commit/src/git-runtime.mjs',
    'schema/commit-message-v1.schema.json',
    'scripts/validate-commit-range.mjs',
    'docs/pt-BR/commands/commit.md',
    'docs/en/commands/commit.md',
  ]) assert.ok(published.has(path), `missing commit policy file from package: ${path}`);
});

test('[req:PROV-8] published tarball contains provenance gates, archive lock, sources, ledger, and receipt schema', () => {
  const published = publishedFiles();
  for (const path of [
    'src/provenance-gate.mjs',
    'src/archive-operation-lock.mjs',
    'src/provenance-sources.mjs',
    'src/receipt-ledger.mjs',
    'schema/wendkeep.provenance-receipt-v2.schema.json',
  ]) assert.ok(published.has(path), `missing provenance file from package: ${path}`);
});

test('[req:HOST-13] published tarball contains host coverage runtime, CLI and schemas', () => {
  const published = publishedFiles();
  for (const path of [
    'src/capabilities.mjs',
    'src/host-capabilities.mjs',
    'schema/host-capability-manifest-v1.schema.json',
    'schema/host-coverage-v1.schema.json',
  ]) assert.ok(published.has(path), `missing host capability file from package: ${path}`);
});

test('[req:MOD-14] [req:MOD-16] CLI workspace declares its private runtime without publishing wendkeep/cli', () => {
  const root = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  const cli = JSON.parse(readFileSync(join(pkgRoot, 'packages', 'cli', 'package.json'), 'utf8'));

  assert.equal(cli.private, true);
  assert.equal(cli.exports, './src/index.mjs');
  assert.equal(Object.hasOwn(root.exports, './cli'), false);
});

test('[req:MOD-17] [req:MOD-19] MCP workspace declares its private kernel without publishing wendkeep/mcp', () => {
  const root = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  const mcp = JSON.parse(readFileSync(join(pkgRoot, 'packages', 'mcp', 'package.json'), 'utf8'));

  assert.equal(mcp.private, true);
  assert.equal(mcp.exports, './src/index.mjs');
  assert.equal(Object.hasOwn(root.exports, './mcp'), false);
  assert.match(root.scripts.check, /node --check packages\/mcp\/src\/config\.mjs/);
  assert.match(root.scripts.check, /node --check packages\/mcp\/src\/index\.mjs/);
});

test('[req:MOD-20] [req:MOD-22] Integrations workspace is packaged privately without a public subpath', () => {
  const root = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  const integrations = JSON.parse(readFileSync(
    join(pkgRoot, 'packages', 'integrations', 'package.json'),
    'utf8',
  ));

  assert.equal(integrations.name, '@wendkeep/integrations');
  assert.equal(integrations.private, true);
  assert.equal(integrations.exports, './src/index.mjs');
  assert.equal(Object.hasOwn(root.exports, './integrations'), false);
  assert.equal(Object.hasOwn(root.exports, './*'), false);
  const publicPackageTargets = new Set([
    './packages/commit/src/index.mjs',
    './packages/harness/src/index.mjs',
    './packages/vault/src/index.mjs',
  ]);
  assert.equal(
    Object.entries(root.exports).some(([key, target]) => (
      key.startsWith('./packages')
      || (String(target).startsWith('./packages') && !publicPackageTargets.has(target))
    )),
    false,
  );
});

test('[req:MOD-4] [req:MOD-6] [req:MOD-9] [req:MOD-10] [req:MOD-11] [req:MOD-12] [req:MOD-13] [req:MOD-16] [req:MOD-18] [req:MOD-19] [req:MOD-20] [req:MOD-21] [req:MOD-22] installed tarball exposes strict canonical, public, and legacy identities', () => {
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
      "const installedChange = await import('wendkeep/src/change.mjs');",
      "const installedChangeCore = await import('wendkeep/hooks/change-core.mjs');",
      "const installedSpecCore = await import('wendkeep/hooks/spec-core.mjs');",
      "for (const name of ['archiveChange', 'archiveChangeMutation', 'recoverArchiveSpecPromotion', 'applySpecPromotionPlan', 'promoteSpecs']) {",
      "  if (name in installedChange || name in installedChangeCore || name in installedSpecCore) process.exit(34);",
      "}",
      "if (Object.keys(installedChange).join(',') !== 'runChange') process.exit(35);",
      "const path = await import('node:path');",
      "const { pathToFileURL } = await import('node:url');",
      "const installedRoot = path.join(process.cwd(), 'node_modules', 'wendkeep');",
      "const internal = (...parts) => import(pathToFileURL(path.join(installedRoot, ...parts)).href);",
      "const canonicalMcp = await internal('packages', 'mcp', 'src', 'index.mjs');",
      "const canonicalIntegrations = await internal('packages', 'integrations', 'src', 'index.mjs');",
      "const canonicalLocale = await internal('packages', 'vault', 'src', 'locale.mjs');",
      "const canonicalFlowStore = await internal('packages', 'harness', 'src', 'flow-store.mjs');",
      "const legacyLocale = await import('wendkeep/hooks/locale.mjs');",
      "const legacy = await import('wendkeep/hooks/vault-path-safety.mjs');",
      "const legacyStore = await import('wendkeep/hooks/memory-store.mjs');",
      "const legacyFlowStore = await import('wendkeep/hooks/vault-runtime-store.mjs');",
      "const legacyProfile = await import('wendkeep/src/operating-profile.mjs');",
      "const legacySensors = await import('wendkeep/hooks/sensors-core.mjs');",
      "const legacyTaxonomy = await import('wendkeep/src/taxonomy.mjs');",
      "const legacyCommon = await import('wendkeep/hooks/obsidian-common.mjs');",
      "const legacyUsage = await import('wendkeep/hooks/token-usage.mjs');",
      "const legacySessionStop = await import('wendkeep/hooks/session-stop.mjs');",
      `const observabilitySpecifiers = ${JSON.stringify(
        OBSERVABILITY_HOOK_MODULES.map((file) => `wendkeep/hooks/${file}`),
      )};`,
      "for (const specifier of observabilitySpecifiers) await import(specifier);",
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
      "if (canonicalMcp.MCP_SERVER_KEY !== legacyTaxonomy.MCP_SERVER_KEY) process.exit(27);",
      "if (canonicalMcp.mcpServerEntry !== legacyTaxonomy.mcpServerEntry) process.exit(28);",
      "const mcpMerged = canonicalMcp.mergeMcpConfig({ mcpServers: { user: { command: 'user' } } }, { vaultPath: 'C:/vault' });",
      "if (mcpMerged.mcpServers.user.command !== 'user') process.exit(29);",
      "if (mcpMerged.mcpServers['wendkeep-vault'].args.at(-1) !== 'C:/vault') process.exit(30);",
      "const integrationsFacades = [",
      "  [legacyTaxonomy, ['SESSION_HOOKS', 'CHANGE_NUDGE_HOOKS', 'CHANGE_GATE_HOOKS',",
      "    'CODEX_MATCHER_EVENTS', 'hookCommand', 'hookCommandLocal',",
      "    'hookCommandLocalLegacy', 'codexHookSpecs', 'codexHookEntry']],",
      "  [legacyCommon, ['salvageTruncatedJson', 'extractHookPrompt', 'isBootstrapPrompt',",
      "    'redactSecrets', 'transcriptsMatch']],",
      "  [legacyUsage, ['emptyTokenUsage', 'normalizeCodexUsage', 'normalizeClaudeUsage', 'addUsage']],",
      "  [legacySessionStop, ['resolveTurnIdentity']],",
      "];",
      "for (const [facade, names] of integrationsFacades) {",
      "  for (const name of names) {",
      "    if (!(name in canonicalIntegrations) || canonicalIntegrations[name] !== facade[name]) {",
      "      throw new Error(`missing or non-identical installed Integrations facade: ${name}`);",
      "    }",
      "  }",
      "}",
      "for (const specifier of [",
      "  'wendkeep/mcp', '@wendkeep/mcp', 'wendkeep/integrations', '@wendkeep/integrations',",
      "  'wendkeep/packages/mcp/src/index.mjs', 'wendkeep/packages/harness/src/index.mjs',",
      "  'wendkeep/packages/vault/src/index.mjs', 'wendkeep/packages/integrations',",
      "  'wendkeep/packages/integrations/src/index.mjs', 'wendkeep/%70ackages/integrations/src/index.mjs',",
      "]) {",
      "  try { await import(specifier); process.exit(32); } catch (error) {",
      "    if (!['ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code)) process.exit(33);",
      "  }",
      "}",
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

    const installedProject = join(consumer, 'mcp-init-project');
    const installedVault = join(installedProject, '.Vault');
    mkdirSync(installedProject);
    writeFileSync(join(installedProject, '.mcp.json'), JSON.stringify({
      custom: { keep: true },
      mcpServers: {
        user: { type: 'stdio', command: 'user', args: [] },
      },
    }, null, 2));
    const installedInit = spawnSync(process.execPath, [
      join(consumer, 'node_modules', 'wendkeep', 'bin', 'wendkeep.mjs'),
      'init',
      '--project', installedProject,
      '--vault', installedVault,
      '--no-companions',
      '--no-colors',
      '--yes',
    ], { cwd: consumer, encoding: 'utf8' });
    assert.equal(installedInit.status, 0, `installed init failed:\n${installedInit.stderr}`);
    const installedMcp = JSON.parse(readFileSync(join(installedProject, '.mcp.json'), 'utf8'));
    assert.deepEqual(installedMcp.custom, { keep: true });
    assert.equal(installedMcp.mcpServers.user.command, 'user');
    assert.deepEqual(
      installedMcp.mcpServers['wendkeep-vault'].args,
      ['--no-install', 'wendkeep', 'mcp', 'serve', '--vault', installedVault],
    );
    const installedMcpServer = spawnSync(process.execPath, [
      join(consumer, 'node_modules', 'wendkeep', 'bin', 'wendkeep.mjs'),
      'mcp', 'serve', '--vault', installedVault,
    ], {
      cwd: installedProject,
      encoding: 'utf8',
      input: `${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      })}\n`,
    });
    assert.equal(installedMcpServer.status, 0, installedMcpServer.stderr);
    assert.equal(JSON.parse(installedMcpServer.stdout).result.serverInfo.name, 'wendkeep-native');
    assert.doesNotMatch(installedMcpServer.stderr, /npm|latest|download/i);

    const installedCodexConfig = spawnSync(process.execPath, [
      join(consumer, 'node_modules', 'wendkeep', 'bin', 'wendkeep.mjs'),
      'mcp', 'config', '--client', 'codex', '--vault', installedVault,
    ], { cwd: installedProject, encoding: 'utf8' });
    assert.equal(installedCodexConfig.status, 0, installedCodexConfig.stderr);
    assert.match(installedCodexConfig.stdout, /^\[mcp_servers\.wendkeep-vault\]/m);

    const installedHookProjection = spawnSync(process.execPath, ['--input-type=module', '--eval', [
      "import assert from 'node:assert/strict';",
      "import { readFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "import { pathToFileURL } from 'node:url';",
      `const project = ${JSON.stringify(installedProject)};`,
      "const installedRoot = join(process.cwd(), 'node_modules', 'wendkeep');",
      "const kernel = await import(pathToFileURL(join(installedRoot, 'packages', 'integrations', 'src', 'index.mjs')).href);",
      "const specs = [...kernel.SESSION_HOOKS, ...kernel.CHANGE_NUDGE_HOOKS, ...kernel.CHANGE_GATE_HOOKS]",
      "  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));",
      "const claude = JSON.parse(readFileSync(join(project, '.claude', 'settings.json'), 'utf8'));",
      "const claudeManaged = Object.values(claude.hooks).flatMap((groups) => groups)",
      "  .flatMap((group) => group.hooks || []).filter((entry) => entry.command?.startsWith('npx --no-install wendkeep hook '));",
      "assert.equal(claudeManaged.length, specs.length);",
      "for (const spec of specs) {",
      "  const group = (claude.hooks[spec.event] || []).find((candidate) =>",
      "    (candidate.hooks || []).some((entry) => entry.command === kernel.hookCommand(spec.name)));",
      "  assert.ok(group, `missing installed Claude projection: ${spec.name}`);",
      "  const entry = group.hooks.find((candidate) => candidate.command === kernel.hookCommand(spec.name));",
      "  assert.equal(entry.timeout, spec.timeout);",
      "  assert.equal(entry.statusMessage, spec.statusMessage);",
      "  if (spec.matcher) assert.equal(group.matcher, spec.matcher);",
      "}",
      "const codex = JSON.parse(readFileSync(join(project, '.codex', 'hooks.json'), 'utf8'));",
      "const codexSpecs = kernel.codexHookSpecs(specs).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));",
      "const codexManaged = Object.values(codex.hooks).flatMap((groups) => groups)",
      "  .flatMap((group) => group.hooks || []).filter((entry) => entry.command?.startsWith('npx --no-install wendkeep hook '));",
      "assert.equal(codexManaged.length, codexSpecs.length);",
      "for (const spec of codexSpecs) {",
      "  const expected = kernel.codexHookEntry(spec);",
      "  const group = (codex.hooks[spec.event] || []).find((candidate) =>",
      "    (candidate.hooks || []).some((entry) => entry.command === expected.command));",
      "  assert.ok(group, `missing installed Codex projection: ${spec.name}`);",
      "  assert.deepEqual(group.hooks.find((entry) => entry.command === expected.command), expected);",
      "  if (kernel.CODEX_MATCHER_EVENTS.has(spec.event) && spec.matcher) assert.equal(group.matcher, spec.matcher);",
      "  else assert.equal(Object.hasOwn(group, 'matcher'), false);",
      "}",
    ].join('\n')], { cwd: consumer, encoding: 'utf8' });
    assert.equal(
      installedHookProjection.status,
      0,
      `installed Claude/Codex hook projection failed:\n${installedHookProjection.stderr}`,
    );

    const installedBin = join(
      consumer,
      'node_modules',
      'wendkeep',
      'bin',
      'wendkeep.mjs',
    );
    const installedSessionId = '019d0000-0000-7000-8000-000000000022';
    const installedTranscript = join(installedProject, 'installed-hook.jsonl');
    writeFileSync(installedTranscript, `${JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'installed-hook-transcript',
        session_id: installedSessionId,
        model_provider: 'openai',
      },
    })}\n`);
    const wrongGlobalVault = join(consumer, 'wrong-global-vault');
    const installedHookEnv = {
      ...process.env,
      HOME: consumer,
      USERPROFILE: consumer,
      OBSIDIAN_VAULT_PATH: wrongGlobalVault,
    };
    for (const key of [
      'CLAUDECODE',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_PROJECT_DIR',
      'CODEX_THREAD_ID',
      'NODE_PATH',
      'WENDKEEP_DEBUG',
    ]) delete installedHookEnv[key];
    const installedHookInput = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: installedSessionId,
      transcript_path: installedTranscript,
      prompt: 'installed hook runtime',
    });
    const installedHook = spawnSync(process.execPath, [
      installedBin,
      'hook',
      'session-ensure',
    ], {
      cwd: installedProject,
      env: installedHookEnv,
      input: installedHookInput,
      encoding: 'utf8',
    });
    assert.equal(
      installedHook.status,
      0,
      `installed session-ensure hook failed:\n${installedHook.stderr}`,
    );
    const installedHookOutput = JSON.parse(installedHook.stdout);
    assert.equal(installedHookOutput.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(installedHookOutput.hookSpecificOutput.additionalContext, /<obsidian_session>/);
    assert.match(installedHookOutput.systemMessage, /Sessão Obsidian criada/);
    const installedRegistry = JSON.parse(readFileSync(
      join(installedVault, '.brain', 'SESSION_REGISTRY.json'),
      'utf8',
    ));
    const installedEntry = installedRegistry.sessions[installedSessionId];
    assert.equal(installedEntry.provider, 'codex');
    assert.equal(installedEntry.transcript_path, installedTranscript);
    assert.equal(installedEntry.transcript_id, 'installed-hook-transcript');
    assert.equal(installedEntry.status, 'active');
    assert.ok(installedEntry.session_file);
    assert.ok(existsSync(join(installedVault, installedEntry.session_file)));
    assert.match(
      readFileSync(join(installedVault, installedEntry.session_file), 'utf8'),
      /installed hook runtime/i,
    );
    assert.equal(existsSync(wrongGlobalVault), false);

    const installedEnvelope = join(
      consumer,
      'node_modules',
      'wendkeep',
      'packages',
      'integrations',
      'src',
      'hook-envelope.mjs',
    );
    const disabledEnvelope = `${installedEnvelope}.disabled`;
    renameSync(installedEnvelope, disabledEnvelope);
    try {
      const brokenInstalledHook = spawnSync(process.execPath, [
        installedBin,
        'hook',
        'session-ensure',
      ], {
        cwd: installedProject,
        env: installedHookEnv,
        input: installedHookInput,
        encoding: 'utf8',
      });
      assert.notEqual(
        brokenInstalledHook.status,
        0,
        'installed hook must not fall back to the source checkout when its kernel is absent',
      );
      assert.match(brokenInstalledHook.stderr, /hook-envelope\.mjs|ERR_MODULE_NOT_FOUND/);
    } finally {
      renameSync(disabledEnvelope, installedEnvelope);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
