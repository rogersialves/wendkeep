const DEPENDENCY_FIELDS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]);

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
