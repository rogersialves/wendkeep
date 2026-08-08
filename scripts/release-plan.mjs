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
  // Versão publicada nunca prossegue, com tag ou sem ela. Uma tag ausente não torna um release
  // já lançado publicável de novo — o registry recusaria com EPUBLISHCONFLICT, e abortar aqui
  // dá a mensagem certa em vez de um erro de rede opaco.
  if (publishedOnNpm) {
    return {
      action: 'abort',
      reason: `${name}@${version} já está publicado no npm. Bump a versão em package.json.`,
    };
  }

  if (!tagCommit) {
    return {
      action: 'publish-and-tag',
      reason: `tag ${tag} ainda não existe`,
    };
  }

  // Note que isto ordena a decisão, não o I/O: o chamador coleta `publishedOnNpm` antes de
  // chamar esta função.
  if (tagCommit !== headCommit) {
    return {
      action: 'abort',
      reason: `tag ${tag} aponta para outro commit (${tagCommit.slice(0, 7)}), `
        + `não para o HEAD (${headCommit.slice(0, 7)}). Publicar entregaria conteúdo diverso do `
        + 'que foi tagueado.',
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
 * Comandos concretos de um plano, na ordem de execução. O script apenas itera e executa, então
 * o que ele faz fica ancorado aqui e verificável sem publicar nem tocar no repositório.
 *
 * @param {{action: string}} plan
 * @param {{tag: string, branch: string}} ctx
 * @returns {Array<{step: string, command: string, args: string[]}>}
 */
export function releaseCommands(plan, { tag, branch, npmSpec = npmExecutorSpec }) {
  const byStep = {
    publish: () => {
      const spec = npmSpec(['publish']);
      return {
        step: 'publish', command: spec.command, args: spec.args, shell: spec.shell,
      };
    },
    tag: () => ({
      step: 'tag', command: 'git', args: ['tag', '-a', tag, '-m', tag], shell: false,
    }),
    push: () => ({
      step: 'push', command: 'git', args: ['push', 'origin', branch, '--follow-tags'], shell: false,
    }),
  };
  return releaseSteps(plan).map((step) => byStep[step]());
}

/**
 * Executa os comandos de um release. Em dry-run nada roda — e isso precisa ser verificável, já
 * que perder essa guarda faz `npm run release:dry` publicar de verdade.
 *
 * @param {Array<{step: string, command: string, args: string[], shell?: boolean}>} commands
 * @param {{dry: boolean, run: (cmd: object) => void, log: (msg: string) => void}} io
 * @returns {string[]} os passos executados (vazio em dry-run)
 */
export function executeRelease(commands, { dry, run, log = () => {} }) {
  const executed = [];
  for (const command of commands) {
    log(`${dry ? '· [dry]' : '→'} ${command.step}`);
    if (dry) continue;
    run(command);
    executed.push(command.step);
  }
  return executed;
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
 * Como invocar o npm sem depender de resolvê-lo pelo PATH.
 *
 * No Windows `npm` é um `.cmd`: `execFileSync('npm', …)` dá ENOENT, e apontar direto para
 * `npm.cmd` dá EINVAL no Node 24, que recusa executar `.cmd` sem shell (CVE-2024-27980). O npm
 * exporta `npm_execpath` ao rodar `npm run`, apontando para o `npm-cli.js`; invocá-lo com o
 * próprio node resolve em qualquer plataforma e dispensa `shell: true`.
 *
 * @returns {{command: string, args: string[]}}
 */
export function npmExecutorSpec(args, {
  execPath = process.execPath,
  npmExecPath = process.env.npm_execpath,
  platform = process.platform,
} = {}) {
  if (npmExecPath) return { command: execPath, args: [npmExecPath, ...args], shell: false };
  // Fora de `npm run` não há npm_execpath. No Windows, `npm` sozinho é irresolúvel e o
  // fail-open de npmHasVersion transformaria isso em guard desligado sem aviso, então aqui o
  // shell é a diferença entre consultar o registry e não consultar nada. Os args são fixos ou
  // vêm do package.json, nunca de entrada externa.
  return { command: 'npm', args, shell: platform === 'win32' };
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
