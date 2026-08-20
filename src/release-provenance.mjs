import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const DEPENDENCY_FIELDS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]);

export function parsePackIntegrity(raw) {
  const text = String(raw || '');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) return '';
  try {
    return String(JSON.parse(text.slice(start, end + 1))[0]?.integrity || '');
  } catch {
    return '';
  }
}

export function packIntegrityInIsolatedCopy(root, { execute = execFileSync } = {}) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'wendkeep-release-pack-'));
  const packageRoot = join(tempRoot, 'package');
  const ignored = new Set(['.git', 'node_modules']);
  try {
    const binding = JSON.parse(readFileSync(join(root, '.wendkeep.json'), 'utf8'));
    const vault = String(binding.vault || '');
    if (vault && !vault.includes('/') && !vault.includes('\\')) ignored.add(vault);
  } catch { /* unbound package: nothing else to exclude */ }
  try {
    cpSync(root, packageRoot, {
      recursive: true,
      filter(source) {
        if (source === root) return true;
        const relativeName = basename(source);
        return !ignored.has(relativeName);
      },
    });
    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const raw = execute(command, ['pack', '--dry-run', '--json'], {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parsePackIntegrity(raw);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function packageHasSelfDependency(pkg = {}) {
  const name = String(pkg.name || '');
  if (!name) return false;
  return DEPENDENCY_FIELDS.some((field) => Object.hasOwn(pkg[field] || {}, name));
}

export function evaluateReleaseProvenance({
  name,
  version,
  headCommit,
  tagCommit = '',
  publishedIntegrity = '',
  localIntegrity = '',
  requirePublished = false,
} = {}) {
  const tag = `v${version}`;
  if (tagCommit && tagCommit !== headCommit) {
    return {
      ok: false,
      code: 'tag_commit_mismatch',
      message: `${tag} aponta para ${tagCommit.slice(0, 7)}, não para ${headCommit.slice(0, 7)}. Bump a versão antes de alterar a árvore publicada.`,
    };
  }
  if (publishedIntegrity && !tagCommit) {
    return {
      ok: false,
      code: 'published_tag_missing',
      message: `${name}@${version} está publicado, mas ${tag} não comprova o commit correspondente.`,
    };
  }
  if (requirePublished && !publishedIntegrity) {
    return {
      ok: false,
      code: 'published_artifact_missing',
      message: `${name}@${version} ainda não possui integridade consultável no npm.`,
    };
  }
  if (publishedIntegrity && localIntegrity && publishedIntegrity !== localIntegrity) {
    return {
      ok: false,
      code: 'tarball_integrity_mismatch',
      message: `o tarball de ${tag} diverge do artefato publicado no npm.`,
    };
  }
  if (publishedIntegrity && !localIntegrity) {
    return {
      ok: false,
      code: 'local_integrity_missing',
      message: `não foi possível calcular a integridade do tarball de ${tag}.`,
    };
  }
  return {
    ok: true,
    code: publishedIntegrity ? 'verified' : 'release_candidate',
    name,
    version,
    tag,
    commit: headCommit,
    integrity: publishedIntegrity || localIntegrity || '',
  };
}
