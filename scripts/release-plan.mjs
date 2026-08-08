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

  // Divergência de commit é o estado mais ambíguo, então decide primeiro. Note que isso ordena
  // a decisão, não o I/O: o chamador coleta `publishedOnNpm` antes de chamar esta função.
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

/**
 * Passos que um plano executa, em ordem. Manter o mapeamento aqui — e não espalhado em ifs no
 * script — é o que permite verificar que `publish-only` de fato publica: não publicar reintroduz
 * o defeito original, e recriar a tag faz `git tag -a` falhar depois do `npm publish`, deixando
 * o release pela metade no único passo irreversível.
 *
 * @param {{action: string}} plan
 * @returns {Array<'publish'|'tag'|'push'>}
 */
export function releaseSteps({ action }) {
  if (action === 'abort') return [];
  if (action === 'publish-only') return ['publish', 'push'];
  return ['publish', 'tag', 'push'];
}

/**
 * Argumentos da consulta de versão ao registry.
 *
 * `--prefer-online` é obrigatório: sem ele o npm responde de metadata em cache e pode negar uma
 * versão recém-publicada, o que levaria o guard a liberar uma republicação.
 */
export function npmVersionQueryArgs(name, version) {
  return ['view', `${name}@${version}`, 'version', '--prefer-online'];
}

/**
 * @param {string} name
 * @param {string} version
 * @param {(args: string[]) => string} run  executor injetável (o script passa o npm real)
 */
export function npmHasVersion(name, version, run) {
  try {
    return run(npmVersionQueryArgs(name, version)) === version;
  } catch {
    // Fail-open deliberado. A consulta falha tanto para versão inexistente quanto para rede
    // instável, e os dois casos são indistinguíveis pelo código de saída. Bloquear aqui travaria
    // um release legítimo; liberar é seguro porque o registry recusa republicação com
    // EPUBLISHCONFLICT e é a autoridade final.
    return false;
  }
}
