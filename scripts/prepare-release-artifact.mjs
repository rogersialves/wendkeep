#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReleaseSbom, releaseSha256 } from './generate-sbom.mjs';
import { npmExecutorSpec } from './release-plan.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const outputIndex = process.argv.indexOf('--output');
const output = resolve(root, outputIndex >= 0 ? process.argv[outputIndex + 1] : 'artifacts');
mkdirSync(output, { recursive: true });

const run = (command, args, options = {}) => execFileSync(command, args, {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  ...options,
}).trim();

const commit = run('git', ['rev-parse', 'HEAD']);
const parent = run('git', ['rev-parse', 'HEAD^']);
run(process.execPath, [join(root, 'scripts', 'validate-commit-range.mjs'), '--base', parent, '--head', commit]);
const commitMessage = run('git', ['log', '-1', '--format=%B']);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const npm = npmExecutorSpec(['pack', '--json', '--pack-destination', output]);
const packedRaw = run(npm.command, npm.args, { shell: npm.shell });
const start = packedRaw.indexOf('[');
const end = packedRaw.lastIndexOf(']');
const packed = JSON.parse(packedRaw.slice(start, end + 1))[0];
const packedTarballPath = join(output, packed.filename);
const tarballPath = join(output, 'release-candidate.tgz');
rmSync(tarballPath, { force: true });
renameSync(packedTarballPath, tarballPath);
const tarballBytes = readFileSync(tarballPath);
const sbom = createReleaseSbom({ tarballPath, pkg, lock });
const sbomFile = `wendkeep-${pkg.version}.cdx.json`;
const sbomPath = join(output, sbomFile);
writeFileSync(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
const receipt = {
  schema_version: 1,
  status: 'candidate',
  package: { name: pkg.name, version: pkg.version },
  commit,
  commit_receipt: {
    policy: 'wendkeep-universal-commit-v1',
    validated: true,
    message_sha256: `sha256:${createHash('sha256').update(commitMessage).digest('hex')}`,
  },
  artifact: {
    file: basename(tarballPath),
    integrity: packed.integrity,
    sha256: releaseSha256(tarballBytes),
  },
  sbom: {
    file: sbomFile,
    sha256: releaseSha256(readFileSync(sbomPath)),
  },
};
writeFileSync(join(output, 'release-candidate.json'), `${JSON.stringify(receipt, null, 2)}\n`, {
  encoding: 'utf8', mode: 0o600,
});
process.stdout.write(`${JSON.stringify(receipt)}\n`);
