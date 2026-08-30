import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { evaluateReleaseChain } from './provenance-gate.mjs';

const DEPENDENCY_FIELDS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]);
const SLSA_PROVENANCE_V1 = 'https://slsa.dev/provenance/v1';
const IN_TOTO_PAYLOAD = 'application/vnd.in-toto+json';

function normalizedRepository(value) {
  const raw = String(value || '').trim().replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/$/, '');
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.hostname.toLowerCase() !== 'github.com') return '';
    return parsed.pathname.replace(/^\//, '').toLowerCase();
  } catch {
    return /^[\w.-]+\/[\w.-]+$/.test(raw) ? raw.toLowerCase() : '';
  }
}

function sha512HexFromIntegrity(integrity) {
  const token = String(integrity || '').split(/\s+/).find((value) => value.startsWith('sha512-')) || '';
  if (!token) return '';
  try {
    const bytes = Buffer.from(token.slice('sha512-'.length), 'base64');
    return bytes.length === 64 ? bytes.toString('hex') : '';
  } catch {
    return '';
  }
}

function collectVerifiedEnvelopes(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectVerifiedEnvelopes(item, output);
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  if (value.dsseEnvelope?.payload) output.push(value.dsseEnvelope);
  for (const nested of Object.values(value)) collectVerifiedEnvelopes(nested, output);
  return output;
}

/**
 * Consume only attestations that npm has placed under its cryptographically
 * verified result. The decoded statement is then bound to the exact registry
 * subject digest and GitHub source commit used by this release.
 */
export function extractVerifiedNpmAttestation(audit, {
  name,
  version,
  integrity,
  repository,
  commit,
  workflow = '.github/workflows/auto-tag.yml',
} = {}) {
  if (!Array.isArray(audit?.verified)) return null;
  const expectedDigest = sha512HexFromIntegrity(integrity);
  const expectedRepository = normalizedRepository(repository);
  if (!expectedDigest || !expectedRepository || !/^[0-9a-f]{40}$/i.test(String(commit || ''))) return null;
  const expectedSubject = `pkg:npm/${name}@${version}`;
  for (const envelope of collectVerifiedEnvelopes(audit.verified)) {
    if (envelope.payloadType && envelope.payloadType !== IN_TOTO_PAYLOAD) continue;
    let statement;
    try {
      statement = JSON.parse(Buffer.from(String(envelope.payload), 'base64').toString('utf8'));
    } catch {
      continue;
    }
    if (statement?.predicateType !== SLSA_PROVENANCE_V1
      || !Array.isArray(statement.subject) || statement.subject.length !== 1
      || statement.subject[0]?.name !== expectedSubject
      || String(statement.subject[0]?.digest?.sha512 || '').toLowerCase() !== expectedDigest) continue;
    const build = statement.predicate?.buildDefinition;
    const source = build?.externalParameters?.workflow;
    const sourceRepository = normalizedRepository(source?.repository);
    const dependency = Array.isArray(build?.resolvedDependencies)
      ? build.resolvedDependencies.find((candidate) => (
        normalizedRepository(String(candidate?.uri || '').split('@refs/')[0]) === expectedRepository
        && String(candidate?.digest?.gitCommit || '').toLowerCase() === String(commit).toLowerCase()
      ))
      : null;
    if (sourceRepository !== expectedRepository
      || source?.path !== workflow
      || source?.ref !== 'refs/heads/main'
      || !dependency) continue;
    return {
      verified: true,
      subjectSha512: expectedDigest,
      repository: expectedRepository,
      commit: String(commit).toLowerCase(),
      workflow,
    };
  }
  return null;
}

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

/**
 * Calculate the publishable tarball from an immutable target commit. A local,
 * detached clone keeps lifecycle mutations and an incidental worktree out of
 * the observation.
 */
export function collectArtifactAtCommit({
  repoRoot,
  targetCommit,
  execute = execFileSync,
} = {}) {
  if (!repoRoot || !/^[0-9a-f]{40}$/i.test(String(targetCommit || ''))) {
    return { ok: false, state: 'unproven', reasonCodes: ['PROVENANCE_COMMIT_MISSING'] };
  }
  const tempRoot = mkdtempSync(join(tmpdir(), 'wendkeep-release-target-'));
  const targetRoot = join(tempRoot, 'target');
  try {
    execute('git', ['clone', '--quiet', '--no-checkout', '--local', repoRoot, targetRoot], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    });
    execute('git', ['checkout', '--quiet', '--detach', targetCommit], {
      cwd: targetRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    });
    const integrity = packIntegrityInIsolatedCopy(targetRoot, { execute });
    if (!integrity) return {
      ok: false, state: 'unproven', commit: targetCommit,
      reasonCodes: ['PROVENANCE_INTEGRITY_UNOBSERVED'],
    };
    return {
      ok: true,
      state: 'verified',
      commit: targetCommit,
      integrity,
      reasonCodes: [],
    };
  } catch {
    return {
      ok: false, state: 'reported', commit: targetCommit,
      reasonCodes: ['PROVENANCE_SOURCE_UNAVAILABLE'],
    };
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
  publishedAttestation = null,
  repository = 'rogersialves/wendkeep',
  workflow = '.github/workflows/auto-tag.yml',
  requirePublished = false,
  chain = null,
  context = null,
} = {}) {
  if (chain) return evaluateReleaseChain({ chain, context: context || {} });
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
  if (publishedIntegrity && !publishedAttestation) {
    return {
      ok: false,
      code: 'published_attestation_missing',
      message: `${name}@${version} possui bytes no npm, mas nenhuma attestation verificada os vincula ao SHA de origem.`,
    };
  }
  if (publishedIntegrity) {
    const expectedDigest = sha512HexFromIntegrity(publishedIntegrity);
    const attestationMatches = publishedAttestation?.verified === true
      && publishedAttestation.subjectSha512 === expectedDigest
      && normalizedRepository(publishedAttestation.repository) === normalizedRepository(repository)
      && String(publishedAttestation.commit || '').toLowerCase() === String(headCommit || '').toLowerCase()
      && publishedAttestation.workflow === workflow;
    if (!attestationMatches) {
      return {
        ok: false,
        code: 'published_attestation_mismatch',
        message: `a attestation publicada de ${name}@${version} não corresponde ao subject, repositório, workflow e commit testados.`,
      };
    }
  }
  return {
    ok: true,
    code: publishedIntegrity ? 'verified' : 'release_candidate',
    name,
    version,
    tag,
    commit: headCommit,
    integrity: publishedIntegrity || localIntegrity || '',
    ...(publishedIntegrity ? { attestation: publishedAttestation } : {}),
  };
}
