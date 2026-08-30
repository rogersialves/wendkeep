#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const digest = (algorithm, value, encoding = 'hex') => createHash(algorithm).update(value).digest(encoding);
const sha256 = (value) => `sha256:${digest('sha256', value)}`;

const packageName = (path, details) => {
  if (details?.name) return details.name;
  const marker = 'node_modules/';
  const index = path.lastIndexOf(marker);
  return index >= 0 ? path.slice(index + marker.length) : '';
};

const componentFor = (path, details, rootVersion) => {
  const name = packageName(path, details);
  const version = String(details?.version || (path.startsWith('packages/') ? rootVersion : ''));
  if (!name || !version) return null;
  return {
    type: 'library',
    'bom-ref': `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
    name,
    version,
    purl: `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
    properties: [{ name: 'wendkeep:source', value: path.startsWith('packages/') ? 'workspace' : 'runtime' }],
  };
};

export function createReleaseSbom({ tarballPath, pkg, lock }) {
  const bytes = readFileSync(tarballPath);
  const sha256Hex = digest('sha256', bytes);
  const sha512Hex = digest('sha512', bytes);
  const serialHex = sha256Hex.slice(0, 32);
  const serial = `${serialHex.slice(0, 8)}-${serialHex.slice(8, 12)}-4${serialHex.slice(13, 16)}`
    + `-a${serialHex.slice(17, 20)}-${serialHex.slice(20)}`;
  const components = Object.entries(lock?.packages || {})
    .filter(([path, details]) => path && details?.dev !== true)
    .map(([path, details]) => componentFor(path, details, pkg.version))
    .filter(Boolean)
    .filter((component, index, all) => all.findIndex((item) => item['bom-ref'] === component['bom-ref']) === index)
    .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${serial}`,
    version: 1,
    metadata: {
      component: {
        type: 'application',
        'bom-ref': `pkg:npm/${pkg.name}@${pkg.version}`,
        name: pkg.name,
        version: pkg.version,
        hashes: [
          { alg: 'SHA-256', content: sha256Hex },
          { alg: 'SHA-512', content: sha512Hex },
        ],
        properties: [{ name: 'wendkeep:artifact', value: basename(tarballPath) }],
      },
    },
    components,
  };
}

const releaseError = (code, message) => Object.assign(new Error(message), { code });

export function finalizeReleaseReceipt(candidate, published) {
  if (candidate?.commit_receipt?.policy !== 'wendkeep-universal-commit-v1'
    || candidate?.commit_receipt?.validated !== true) {
    throw releaseError('WENDKEEP_RELEASE_COMMIT_UNPROVEN', 'canonical commit receipt is not verified');
  }
  const matches = published?.ok === true
    && published?.code === 'verified'
    && published?.name === candidate?.package?.name
    && published?.version === candidate?.package?.version
    && published?.commit === candidate?.commit
    && published?.integrity === candidate?.artifact?.integrity
    && published?.attestation?.verified === true
    && published?.attestation?.commit === candidate?.commit;
  if (!matches) {
    throw releaseError('WENDKEEP_RELEASE_RECEIPT_MISMATCH', 'published provenance diverges from release candidate');
  }
  return {
    ...candidate,
    status: 'completed',
    published: {
      name: published.name,
      version: published.version,
      commit: published.commit,
      integrity: published.integrity,
      attestation: published.attestation,
    },
  };
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : '';
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const tarballPath = valueAfter('--tarball');
  const outputPath = valueAfter('--output');
  const packagePath = valueAfter('--package') || 'package.json';
  const lockPath = valueAfter('--lock') || 'package-lock.json';
  if (!tarballPath || !outputPath) {
    process.stderr.write('usage: generate-sbom --tarball <path> --output <path> [--package package.json] [--lock package-lock.json]\n');
    process.exit(2);
  }
  const sbom = createReleaseSbom({
    tarballPath,
    pkg: JSON.parse(readFileSync(packagePath, 'utf8')),
    lock: JSON.parse(readFileSync(lockPath, 'utf8')),
  });
  writeFileSync(outputPath, `${JSON.stringify(sbom, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export { sha256 as releaseSha256 };
