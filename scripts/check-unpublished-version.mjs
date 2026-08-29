import { readFileSync } from 'node:fs';
import { get } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function semverParts(value) {
  const match = String(value || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) throw new TypeError(`invalid semantic version: ${value}`);
  return match.slice(1).map(Number);
}

function compareSemver(left, right) {
  const a = semverParts(left);
  const b = semverParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function assessUnpublishedPackageVersion({ packageVersion, publishedVersion }) {
  const comparison = compareSemver(packageVersion, publishedVersion);
  return {
    ok: comparison > 0,
    package_version: String(packageVersion),
    published_version: String(publishedVersion),
    status: comparison > 0 ? 'unpublished' : comparison === 0 ? 'already-published' : 'package-behind',
  };
}

export function fetchPublishedVersion({
  packageName = 'wendkeep',
  timeoutMs = 15_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const request = get(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
      { headers: { accept: 'application/json', 'user-agent': 'wendkeep-release-preflight' } },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          try {
            if (response.statusCode !== 200) {
              throw new Error(`npm registry returned HTTP ${response.statusCode}`);
            }
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(String(payload.version || ''));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error('npm registry request timed out')));
    request.on('error', reject);
  });
}

async function main() {
  const packageJson = JSON.parse(readFileSync(join(SCRIPT_DIR, '..', 'package.json'), 'utf8'));
  const publishedVersion = await fetchPublishedVersion({ packageName: packageJson.name });
  const result = assessUnpublishedPackageVersion({
    packageVersion: packageJson.version,
    publishedVersion,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write(`check-unpublished-version: ${error.message}\n`);
    process.exitCode = 1;
  });
}
