#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyReleaseCandidateBytes } from '../src/release-candidate.mjs';
import { npmExecutorSpec } from './release-plan.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const requestedTarball = process.argv[2] || join(root, 'artifacts', 'release-candidate.tgz');
const tarballPath = isAbsolute(requestedTarball) ? requestedTarball : resolve(root, requestedTarball);
const receiptPath = join(root, 'artifacts', 'release-candidate.json');
const verified = verifyReleaseCandidateBytes({ tarballPath, receiptPath });
const temporary = mkdtempSync(join(tmpdir(), 'wendkeep-release-consumer-'));
try {
  writeFileSync(join(temporary, 'package.json'), '{"private":true,"type":"module"}\n', {
    encoding: 'utf8', mode: 0o600,
  });
  const npm = npmExecutorSpec([
    'install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath,
  ]);
  execFileSync(npm.command, npm.args, {
    cwd: temporary, encoding: 'utf8', shell: npm.shell,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  execFileSync(process.execPath, ['--input-type=module', '--eval', [
    "import assert from 'node:assert/strict';",
    "const integrations = await import('wendkeep/integrations');",
    "const mcp = await import('wendkeep/mcp');",
    "assert.equal(integrations.hookCommand('session-stop'), 'npx --no-install wendkeep hook session-stop');",
    "const codex = integrations.codexHookEntry({ name: 'session-stop', timeout: 60 });",
    "assert.equal(codex.command, 'npx --no-install wendkeep hook session-stop');",
    "assert.equal(typeof mcp.createNativeMcpServer, 'function');",
  ].join('\n')], {
    cwd: temporary, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    artifact: tarballPath,
    integrity: verified.integrity,
    consumers: ['claude', 'codex', 'mcp'],
  })}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
