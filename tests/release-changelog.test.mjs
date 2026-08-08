import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractReleaseNotes } from '../src/release-changelog.mjs';
import { execFileSync } from 'node:child_process';
import {
  executeRelease, npmExecutorSpec, npmHasVersion, npmVersionQueryArgs, releaseCommands,
  releaseSteps, resolveReleasePlan,
} from '../scripts/release-plan.mjs';

const AUTO_TAG_WORKFLOW = readFileSync(new URL('../.github/workflows/auto-tag.yml', import.meta.url), 'utf8');
const AGENT_RULES = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
const CHANGELOG = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const FIXTURE = `# Changelog

All notable changes to **wendkeep** are documented here.

## [0.38.1] — 2026-07-12

### Fixed

- Sessão Claude nova não perde o 1º turno.
- Paridade de provider nos hooks.

## [0.38.0] — 2026-07-12

### Added

- Coisa nova A.

### Fixed

- Bug B.

## [0.35.0] — 2026-07-11

### Fixed

- Algo antigo.
`;

test('extractReleaseNotes: returns body + date for a version', () => {
  const r = extractReleaseNotes(FIXTURE, '0.38.1');
  assert.equal(r.version, '0.38.1');
  assert.equal(r.date, '2026-07-12');
  assert.match(r.notes, /### Fixed/);
  assert.match(r.notes, /não perde o 1º turno/);
});

test('extractReleaseNotes: stops before the next version header', () => {
  const r = extractReleaseNotes(FIXTURE, '0.38.0');
  assert.match(r.notes, /Coisa nova A/);
  assert.match(r.notes, /Bug B/);
  assert.doesNotMatch(r.notes, /Algo antigo/);
  assert.doesNotMatch(r.notes, /não perde o 1º turno/);
});

test('extractReleaseNotes: accepts a v-prefixed version', () => {
  const r = extractReleaseNotes(FIXTURE, 'v0.35.0');
  assert.equal(r.version, '0.35.0');
  assert.match(r.notes, /Algo antigo/);
});

test('extractReleaseNotes: body is trimmed (no leading/trailing blank lines)', () => {
  const r = extractReleaseNotes(FIXTURE, '0.35.0');
  assert.equal(r.notes, r.notes.trim());
  assert.ok(r.notes.length > 0);
});

test('extractReleaseNotes: throws when the version is absent', () => {
  assert.throws(() => extractReleaseNotes(FIXTURE, '9.9.9'), /9\.9\.9/);
});

test('[sensor:release-tests] 0.68.2 notes are extractable and match the package', () => {
  const release = extractReleaseNotes(CHANGELOG, '0.68.2');
  assert.equal(PACKAGE.version, '0.68.2');
  assert.equal(release.date, '2026-08-08');
  assert.match(release.notes, /auto-tag\.yml/);
  assert.match(release.notes, /unicidade da versão no registry/i);
  assert.match(release.notes, /commit corrente/i);
  assert.doesNotMatch(release.notes, /019f[0-9a-f-]+/i);
});

test('[sensor:release-tests] as notas de 0.68.1 seguem extraíveis depois do bump', () => {
  // A entrada anterior precisa continuar íntegra: a v0.68.1 já tem tag e GitHub Release, e o
  // auto-tag relê o CHANGELOG para refrescar release existente.
  const release = extractReleaseNotes(CHANGELOG, '0.68.1');
  assert.equal(release.date, '2026-08-08');
  assert.match(release.notes, /VAULT_PATH_UNSAFE/);
  assert.match(release.notes, /walk fresco/i);
});

const releaseFacts = (overrides = {}) => ({
  name: 'wendkeep',
  version: '1.2.3',
  tag: 'v1.2.3',
  tagCommit: null,
  headCommit: 'a'.repeat(40),
  publishedOnNpm: false,
  ...overrides,
});

test('[sensor:release-tests] [req:CLI-PKG-2] sem tag, o release publica e cria a tag', () => {
  const plan = resolveReleasePlan(releaseFacts());
  assert.equal(plan.action, 'publish-and-tag');
});

test('[sensor:release-tests] [req:CLI-PKG-2] tag do auto-tag no commit corrente publica e preserva a tag', () => {
  // auto-tag.yml cria a tag no merge em main, antes de qualquer publish. A tag existir não
  // significa que a versão foi lançada — só o registry responde isso.
  const plan = resolveReleasePlan(releaseFacts({
    tagCommit: 'a'.repeat(40),
    publishedOnNpm: false,
  }));
  assert.equal(plan.action, 'publish-only');
});

test('[sensor:release-tests] [req:CLI-PKG-2] versão já publicada aborta mesmo com a tag no commit corrente', () => {
  const plan = resolveReleasePlan(releaseFacts({
    tagCommit: 'a'.repeat(40),
    publishedOnNpm: true,
  }));
  assert.equal(plan.action, 'abort');
  assert.match(plan.reason, /já está publicad/i);
});

test('[sensor:release-tests] [req:CLI-PKG-2] tag apontando para outro commit aborta', () => {
  // Publicar aqui entregaria conteúdo diferente do que foi tagueado. Precede a consulta ao
  // registry: é uma checagem local e o estado é ambíguo demais para prosseguir.
  const plan = resolveReleasePlan(releaseFacts({
    tagCommit: 'b'.repeat(40),
    publishedOnNpm: false,
  }));
  assert.equal(plan.action, 'abort');
  assert.match(plan.reason, /outro commit|diverge/i);
});

test('[sensor:release-tests] [req:CLI-PKG-2] publish-and-tag executa publish, tag e push', () => {
  const steps = releaseSteps({ action: 'publish-and-tag', reason: '' });
  assert.deepEqual(steps, ['publish', 'tag', 'push']);
});

test('[sensor:release-tests] [req:CLI-PKG-2] publish-only publica e preserva a tag existente', () => {
  // O ponto da mudança inteira: este caminho PRECISA publicar. Não publicar aqui reintroduz o
  // defeito original em silêncio; recriar a tag faz `git tag -a` falhar depois do publish,
  // deixando o release pela metade justamente no passo irreversível.
  const steps = releaseSteps({ action: 'publish-only', reason: '' });
  assert.ok(steps.includes('publish'), 'publish-only precisa publicar');
  assert.ok(!steps.includes('tag'), 'publish-only não pode recriar a tag');
  assert.deepEqual(steps, ['publish', 'push']);
});

test('[sensor:release-tests] [req:CLI-PKG-2] abort não executa passo algum', () => {
  assert.deepEqual(releaseSteps({ action: 'abort', reason: 'qualquer' }), []);
});

test('[sensor:release-tests] [req:CLI-PKG-2] a consulta ao registry ignora cache de metadata', () => {
  // Sem --prefer-online o npm responde de cache e pode negar uma versão recém-publicada,
  // o que levaria o guard a liberar uma republicação. A asserção é sobre os args que chegam ao
  // executor, não sobre o helper isolado — montar a consulta inline sem a flag tem de quebrar.
  const seen = [];
  npmHasVersion('wendkeep', '1.2.3', (args) => {
    seen.push(args);
    return '1.2.3';
  });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].includes('--prefer-online'), `faltou --prefer-online em ${seen[0].join(' ')}`);
  assert.ok(seen[0].includes('wendkeep@1.2.3'));
  assert.deepEqual(seen[0], npmVersionQueryArgs('wendkeep', '1.2.3'));
});

test('[sensor:release-tests] [req:CLI-PKG-2] o npm é invocado pelo npm-cli.js, não pelo PATH', () => {
  // No Windows `npm` é um .cmd: execFileSync dá ENOENT, e apontar para npm.cmd dá EINVAL no
  // Node 24. Sem isto a consulta ao registry falha sempre e o guard fica inoperante — o
  // fail-open transformaria "versão já publicada" em release liberado.
  const spec = npmExecutorSpec(['view', 'wendkeep@1.2.3', 'version'], {
    execPath: '/usr/bin/node',
    npmExecPath: '/npm/bin/npm-cli.js',
  });
  assert.equal(spec.command, '/usr/bin/node');
  assert.deepEqual(spec.args, ['/npm/bin/npm-cli.js', 'view', 'wendkeep@1.2.3', 'version']);
});

test('[sensor:release-tests] [req:CLI-PKG-2] sem npm_execpath o executor cai para o npm do PATH', () => {
  // `null` e não `undefined`: um parâmetro com default só é sobrescrito por valor não-undefined,
  // então passar `undefined` reativaria process.env.npm_execpath — que existe sob `npm test` e
  // faria este teste medir o ambiente em vez da função.
  const spec = npmExecutorSpec(['publish'], { execPath: '/usr/bin/node', npmExecPath: null });
  assert.equal(spec.command, 'npm');
  assert.deepEqual(spec.args, ['publish']);
});

test('[sensor:release-tests] [req:CLI-PKG-2] o publish usa exatamente o executor resolvido', () => {
  // Asserção da forma exata, não de uma disjunção: aceitar `command === 'npm'` OU o npm-cli.js
  // deixaria a forma quebrada passar, que é justamente o defeito a barrar.
  const [publish] = releaseCommands({ action: 'publish-only' }, {
    tag: 'v1.2.3',
    branch: 'main',
    npmSpec: (args) => ({ command: '/usr/bin/node', args: ['/npm-cli.js', ...args], shell: false }),
  });
  assert.deepEqual(publish, {
    step: 'publish', command: '/usr/bin/node', args: ['/npm-cli.js', 'publish'], shell: false,
  });
});

test('[sensor:release-tests] [req:CLI-PKG-2] o default do executor lê npm_execpath do ambiente', () => {
  // Os demais testes injetam os dois parâmetros, então nada exercitaria o default — e trocá-lo
  // por `null` reintroduziria o ENOENT silencioso sem quebrar nada.
  const previous = process.env.npm_execpath;
  process.env.npm_execpath = '/injected/npm-cli.js';
  try {
    const spec = npmExecutorSpec(['view', 'x@1.0.0', 'version']);
    assert.equal(spec.command, process.execPath);
    assert.equal(spec.args[0], '/injected/npm-cli.js');
  } finally {
    if (previous === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previous;
  }
});

test('[sensor:release-tests] [req:CLI-PKG-2] fora de npm run o Windows recorre ao shell', () => {
  // Sem npm_execpath, `npm` é irresolúvel no Windows; devolver o comando cru faria a consulta
  // lançar e o fail-open desligar o guard em silêncio.
  const win = npmExecutorSpec(['publish'], { npmExecPath: null, platform: 'win32' });
  assert.deepEqual(win, { command: 'npm', args: ['publish'], shell: true });

  const posix = npmExecutorSpec(['publish'], { npmExecPath: null, platform: 'linux' });
  assert.deepEqual(posix, { command: 'npm', args: ['publish'], shell: false });
});

test('[sensor:release-tests] [req:CLI-PKG-2] dry-run não executa comando algum', () => {
  // Perder esta guarda faz `npm run release:dry` publicar de verdade — irreversível.
  const commands = releaseCommands({ action: 'publish-and-tag' }, { tag: 'v1.2.3', branch: 'main' });
  const ran = [];
  const executed = executeRelease(commands, { dry: true, run: (c) => ran.push(c.step) });
  assert.deepEqual(ran, [], 'dry-run não pode executar nada');
  assert.deepEqual(executed, []);
});

test('[sensor:release-tests] [req:CLI-PKG-2] execução real roda todos os passos na ordem', () => {
  const commands = releaseCommands({ action: 'publish-and-tag' }, { tag: 'v1.2.3', branch: 'main' });
  const ran = [];
  const executed = executeRelease(commands, { dry: false, run: (c) => ran.push(c.step) });
  assert.deepEqual(ran, ['publish', 'tag', 'push']);
  assert.deepEqual(executed, ['publish', 'tag', 'push']);
});

test('[sensor:release-tests] [req:CLI-PKG-2] releaseCommands ancora o que o script executa', () => {
  const ctx = { tag: 'v1.2.3', branch: 'main' };
  const andTag = releaseCommands({ action: 'publish-and-tag' }, ctx);
  assert.deepEqual(andTag.map((c) => c.step), ['publish', 'tag', 'push']);
  assert.deepEqual(andTag[1], {
    step: 'tag', command: 'git', args: ['tag', '-a', 'v1.2.3', '-m', 'v1.2.3'], shell: false,
  });
  assert.deepEqual(andTag[2], {
    step: 'push', command: 'git', args: ['push', 'origin', 'main', '--follow-tags'], shell: false,
  });

  const only = releaseCommands({ action: 'publish-only' }, ctx);
  assert.deepEqual(only.map((c) => c.step), ['publish', 'push']);
  assert.ok(!only.some((c) => c.args.includes('tag')), 'publish-only não pode recriar a tag');

  assert.deepEqual(releaseCommands({ action: 'abort' }, ctx), []);
});

test('[sensor:release-tests] [req:CLI-PKG-2] versão presente no registry é reconhecida', () => {
  assert.equal(npmHasVersion('wendkeep', '1.2.3', () => '1.2.3'), true);
});

test('[sensor:release-tests] [req:CLI-PKG-2] falha de consulta ao registry não bloqueia o release', () => {
  // Fail-open deliberado: o registry é a autoridade final e recusa republicação com
  // EPUBLISHCONFLICT. Bloquear aqui travaria um release legítimo por instabilidade de rede.
  const offline = () => { throw new Error('ENOTFOUND registry.npmjs.org'); };
  assert.equal(npmHasVersion('wendkeep', '1.2.3', offline), false);
});

test('[sensor:release-tests] [req:CLI-PKG-2] o script executa o plano derivado dos mesmos fatos', () => {
  // Ancora scripts/release.mjs: sem isto, hardcodar os passos ou largar o executor sobrevive à
  // suíte. O esperado é recomputado dos fatos reais do repositório, então o teste vale em
  // qualquer estado — inclusive quando o plano correto é abortar.
  const git = (args) => execFileSync('git', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const tag = `v${PACKAGE.version}`;
  let tagCommit = null;
  try {
    tagCommit = git(['rev-list', '-n', '1', `refs/tags/${tag}`]);
  } catch { /* tag ausente */ }

  const plan = resolveReleasePlan({
    name: PACKAGE.name,
    version: PACKAGE.version,
    tag,
    tagCommit,
    headCommit: git(['rev-parse', 'HEAD']),
    publishedOnNpm: npmHasVersion(PACKAGE.name, PACKAGE.version, () => {
      throw new Error('consulta ao registry fora do escopo deste teste');
    }),
  });

  let result;
  let aborted = false;
  try {
    result = execFileSync(process.execPath, ['scripts/release.mjs', '--dry-run'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // Guards anteriores ao plano — working tree sujo, CHANGELOG ausente — também abortam, e
    // durante o desenvolvimento é o caso comum. A asserção que sobrevive a qualquer estado é
    // que um release abortado não executa passo algum; a comparação completa roda com a
    // árvore limpa, como em CI.
    result = `${error.stdout || ''}${error.stderr || ''}`;
    aborted = true;
  }

  if (aborted || plan.action === 'abort') {
    assert.doesNotMatch(result, /\[dry\]/, 'release abortado não pode listar passos');
    return;
  }

  const expected = releaseCommands(plan, { tag, branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) });
  const listed = [...result.matchAll(/^· \[dry\] (.+)$/gm)].map((m) => m[1]);
  assert.equal(listed.length, expected.length, `passos listados: ${listed.join(' | ')}`);
  assert.match(listed[0], /npm publish/);
  if (expected.some((c) => c.step === 'tag')) assert.ok(listed.some((l) => l.includes('git tag -a')));
  else assert.ok(!listed.some((l) => l.includes('git tag -a')), 'publish-only não recria a tag');
  assert.ok(listed.at(-1).includes('git push'));
});

test('auto-tag: existing tag still refreshes the GitHub Release from CHANGELOG', () => {
  const tagBranch = AUTO_TAG_WORKFLOW.match(/if git rev-parse[\s\S]*?^\s*fi$/m)?.[0] || '';
  assert.ok(tagBranch, 'workflow has an explicit existing/new tag branch');
  assert.doesNotMatch(tagBranch, /\bexit\s+0\b/, 'an existing tag must not skip release refresh');
  assert.ok(
    AUTO_TAG_WORKFLOW.indexOf('scripts/print-release-notes.mjs') < AUTO_TAG_WORKFLOW.indexOf('if git rev-parse'),
    'release notes are generated before the tag branch',
  );
  assert.ok(
    AUTO_TAG_WORKFLOW.indexOf('gh release edit') > AUTO_TAG_WORKFLOW.indexOf(tagBranch),
    'the existing-tag path reaches release edit',
  );
});

test('auto-tag: release readback normalizes the extra newline emitted by gh', () => {
  assert.match(AUTO_TAG_WORKFLOW, /PUBLISHED_RELEASE_NOTES\.md/);
  assert.doesNotMatch(
    AUTO_TAG_WORKFLOW,
    /diff -u RELEASE_NOTES\.md PUBLISHED_RELEASE_NOTES\.md/,
    'raw diff rejects an otherwise identical gh body because --jq appends one newline',
  );
  assert.match(AUTO_TAG_WORKFLOW, /trimEnd\(\)/, 'comparison canonicalizes trailing newlines');
});

test('AGENTS: release closure requires updating and reading back notes from CHANGELOG', () => {
  assert.match(AGENT_RULES, /Fechamento obrigatório[\s\S]*CHANGELOG[\s\S]*GitHub Release/i);
  assert.match(AGENT_RULES, /gh release edit\s+vX\.Y\.Z/);
  assert.match(AGENT_RULES, /gh release view\s+vX\.Y\.Z/);
  assert.match(AGENT_RULES, /não (?:declare|considere)[\s\S]*release[\s\S]*concluída/i);
});
