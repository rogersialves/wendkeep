// Decisão do release, isolada dos efeitos colaterais.
//
// Dois automatismos produzem releases deste repositório e assumem ordens opostas:
// `npm run release` publica no npm e então cria a tag, enquanto `auto-tag.yml` observa a main e
// cria a tag assim que o package.json carrega uma versão sem tag. Por isso a tag existir NÃO
// significa que a versão foi lançada — só o registry responde isso.
//
// O guard bloqueia apenas o que é irreversível: republicar uma versão já presente no registry,
// ou publicar conteúdo diferente do que foi tagueado. Manter esta função pura permite verificar
// a matriz de estados sem publicar nem mutar o repositório.

/**
 * @param {object} facts
 * @param {string} facts.name        nome do pacote
 * @param {string} facts.version     versão em package.json
 * @param {string} facts.tag         tag correspondente (`v${version}`)
 * @param {string|null} facts.tagCommit  commit apontado pela tag, ou null se ela não existe
 * @param {string} facts.headCommit  commit corrente
 * @param {boolean} facts.publishedOnNpm  se a versão já está no registry
 * @returns {{action: 'publish-and-tag'|'publish-only'|'abort', reason: string}}
 */
export function resolveReleasePlan({
  name, version, tag, tagCommit, headCommit, publishedOnNpm,
}) {
  if (!tagCommit) {
    return {
      action: 'publish-and-tag',
      reason: `tag ${tag} ainda não existe`,
    };
  }

  // Checagem local e barata primeiro: elimina o estado ambíguo antes de qualquer rede.
  if (tagCommit !== headCommit) {
    return {
      action: 'abort',
      reason: `tag ${tag} aponta para outro commit (${tagCommit.slice(0, 7)}), `
        + `não para o HEAD (${headCommit.slice(0, 7)}). Publicar entregaria conteúdo diverso do `
        + 'que foi tagueado.',
    };
  }

  if (publishedOnNpm) {
    return {
      action: 'abort',
      reason: `${name}@${version} já está publicado no npm. Bump a versão em package.json.`,
    };
  }

  return {
    action: 'publish-only',
    reason: `tag ${tag} já existe no commit corrente (auto-tag.yml); falta apenas publicar`,
  };
}
