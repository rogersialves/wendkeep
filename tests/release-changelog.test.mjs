import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractReleaseNotes } from '../src/release-changelog.mjs';
import { execFileSync } from 'node:child_process';
import {
  executeRelease, npmExecutorSpec, npmHasVersion, npmVersionQueryArgs, releaseCommands,
  releaseSteps, resolveReleasePlan,
} from '../scripts/release-plan.mjs';
import { assessUnpublishedPackageVersion } from '../scripts/check-unpublished-version.mjs';

const TEST_WORKFLOW = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
const RELEASE_WORKFLOW = readFileSync(new URL('../.github/workflows/auto-tag.yml', import.meta.url), 'utf8');
const AGENT_RULES = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
const CHANGELOG = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const RELEASE_PUBLISH_STEP = RELEASE_WORKFLOW.match(
  /      - name: Publish package[\s\S]*?(?=\n      - name:|$)/,
)?.[0] || '';

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

test('[sensor:release-tests] [req:RECALL-13] current release notes are extractable and match the package', () => {
  assert.equal(PACKAGE.version, '0.90.0');
  const release = extractReleaseNotes(CHANGELOG, PACKAGE.version);
  assert.equal(release.date, '2026-08-30');
  assert.match(release.notes, /Grafo modular incremental para a linha 0\.x/i);
  assert.match(release.notes, /Supply chain fail-closed/i);
  assert.match(release.notes, /required checks candidatos só serão aplicados\s+remotamente/i);
  assert.match(release.notes, /attestation SLSA verificada pelo npm/i);
  assert.doesNotMatch(release.notes, /019f[0-9a-f-]+/i);
});

test('[sensor:release-tests] 0.89.0 ecosystem bridge notes remain extractable', () => {
  const release = extractReleaseNotes(CHANGELOG, '0.89.0');
  assert.match(release.notes, /Bridges opcionais oficiais para Spec Kit e Superpowers/i);
  assert.match(release.notes, /Autoridade única e drift fail-closed/i);
});

test('[req:RECALL-13] release preflight distinguishes unpublished, published, and stale versions', () => {
  assert.deepEqual(
    assessUnpublishedPackageVersion({ packageVersion: '0.86.0', publishedVersion: '0.85.1' }),
    {
      ok: true,
      package_version: '0.86.0',
      published_version: '0.85.1',
      status: 'unpublished',
    },
  );
  assert.equal(
    assessUnpublishedPackageVersion({ packageVersion: '0.86.0', publishedVersion: '0.86.0' }).status,
    'already-published',
  );
  assert.equal(
    assessUnpublishedPackageVersion({ packageVersion: '0.85.1', publishedVersion: '0.86.0' }).status,
    'package-behind',
  );
});

test('[sensor:release-tests] 0.76.9 active-context injection notes remain extractable', () => {
  const release = extractReleaseNotes(CHANGELOG, '0.76.9');
  assert.match(release.notes, /Injeção de change causal/i);
  assert.match(release.notes, /Store vazio fail-closed/i);
  assert.match(release.notes, /Criação contextual preservada/i);
});

test('[sensor:release-tests] 0.76.8 doctor/recovery notes remain extractable', () => {
  const release = extractReleaseNotes(CHANGELOG, '0.76.8');
  assert.match(release.notes, /Doctor de active contexts/i);
  assert.match(release.notes, /context repair/i);
  assert.match(release.notes, /Preservação histórica/i);
});

test('[sensor:release-tests] 0.76.7 handoff/evidence notes remain extractable', () => {
  const release = extractReleaseNotes(CHANGELOG, '0.76.7');
  assert.match(release.notes, /Handoff causal no Stop/i);
  assert.match(release.notes, /Recall automático escopado/i);
  assert.match(release.notes, /active_contexts/i);
});

test('[sensor:release-tests] 0.76.6 task-lease notes remain extractable', () => {
  const release = extractReleaseNotes(CHANGELOG, '0.76.6');
  assert.match(release.notes, /Task lease causal/i);
  assert.match(release.notes, /operating_profile_task.*active_contexts/i);
});

test('[sensor:release-tests] 0.76.5 delivery notes remain extractable', () => {
  const release = extractReleaseNotes(CHANGELOG, '0.76.5');
  assert.match(release.notes, /Delivery causal/i);
  assert.match(release.notes, /CURRENT_DELIVERY.*projeção/i);
});

test('[sensor:release-tests] 0.76.4 active-context registry notes remain extractable', () => {
  const release = extractReleaseNotes(CHANGELOG, '0.76.4');
  assert.match(release.notes, /Registry multi-contexto/i);
  assert.match(release.notes, /CURRENT_CHANGE.*projeção/i);
});

test('[sensor:release-tests] 0.76.3 recovery notes remain extractable', () => {
  const release = extractReleaseNotes(CHANGELOG, '0.76.3');
  assert.match(release.notes, /Recuperação explícita do contexto em quarentena/i);
  assert.match(release.notes, /Receipt pós-conflito/i);
});

test('[sensor:release-tests] 0.76.2 bounded-memory notes remain extractable', () => {
  const release = extractReleaseNotes(CHANGELOG, '0.76.2');
  assert.match(release.notes, /Projeção SHARED bounded na origem/i);
  assert.match(release.notes, /memory rescope --apply/i);
});

test('[sensor:release-tests] 0.76.1 causal branch transition notes remain extractable', () => {
  const release = extractReleaseNotes(CHANGELOG, '0.76.1');
  assert.match(release.notes, /Transição causal de branch/i);
  assert.match(release.notes, /context switch <branch>/i);
});

test('[sensor:release-tests] 0.76.0 managed worktree notes remain extractable', () => {
  const release = extractReleaseNotes(CHANGELOG, '0.76.0');
  assert.match(release.notes, /Worktrees gerenciadas e seguras/i);
  assert.match(release.notes, /worktree create\/list\/status\/open/i);
});

test('[sensor:release-tests] 0.75.2 historical handoff notes remain extractable', () => {
  const release = extractReleaseNotes(CHANGELOG, '0.75.2');
  assert.match(release.notes, /Handoffs legados reescopáveis/i);
  assert.match(release.notes, /Curadoria proporcional/i);
  assert.match(release.notes, /Diagnóstico sem falso bloqueio/i);
  assert.doesNotMatch(release.notes, /019f[0-9a-f-]+/i);
});

test('[sensor:release-tests] 0.75.1 Observer hotfix notes remain extractable', () => {
  const release = extractReleaseNotes(CHANGELOG, '0.75.1');
  assert.match(release.notes, /Coalescência sem perda/i);
  assert.match(release.notes, /Reconciliação realmente integral/i);
  assert.match(release.notes, /Leases compatíveis com o transporte/i);
});

test('[sensor:release-tests] 0.75.0 Observer consolidation notes remain extractable', () => {
  const release = extractReleaseNotes(CHANGELOG, '0.75.0');
  assert.match(release.notes, /Identidades SQL escopadas por projeto/i);
  assert.match(release.notes, /Ingest atômico por evento/i);
  assert.match(release.notes, /Reconciliação explícita/i);
  assert.match(release.notes, /Publicação incremental nos hooks/i);
  assert.match(release.notes, /Outbox observável/i);
  assert.doesNotMatch(release.notes, /019f[0-9a-f-]+/i);
});

test('[sensor:release-tests] 0.74.0 scoped memory and recall notes remain extractable', () => {
  const release = extractReleaseNotes(CHANGELOG, '0.74.0');
  assert.match(release.notes, /Registradores de memória escopados/i);
  assert.match(release.notes, /Migração append-only de escopo/i);
  assert.match(release.notes, /Recall baseado em evidências/i);
  assert.match(release.notes, /Context broker por prompt/i);
  assert.match(release.notes, /FTS5 no Observer/i);
  assert.doesNotMatch(release.notes, /019f[0-9a-f-]+/i);
});

test('[sensor:release-tests] 0.72.1 provenance and Observer hardening notes remain extractable', () => {
  const release = extractReleaseNotes(CHANGELOG, '0.72.1');
  assert.match(release.notes, /Proveniência verificável/i);
  assert.match(release.notes, /CI verde/i);
  assert.match(release.notes, /Node\.js 22\.13/i);
  assert.match(release.notes, /full-transcript/i);
});

test('[sensor:release-tests] 0.71.0 dashboard notes remain extractable after the local-open fix', () => {
  const release = extractReleaseNotes(CHANGELOG, '0.71.0');
  assert.match(release.notes, /Painel web local do Observer/i);
  assert.match(release.notes, /snapshots sanitizados/i);
  assert.match(release.notes, /imagem Docker/i);
  assert.match(release.notes, /sessionStorage/i);
});

test('[sensor:release-tests] 0.70.0 notes remain extractable after the dashboard bump', () => {
  const release = extractReleaseNotes(CHANGELOG, '0.70.0');
  assert.match(release.notes, /Observer local multi-projeto/i);
  assert.match(release.notes, /snapshots sanitizados/i);
  assert.match(release.notes, /loopback/i);
  assert.match(release.notes, /research preview/i);
  assert.match(release.notes, /preço inventado/i);
});

test('[sensor:release-tests] 0.68.6 notes remain extractable after the bump', () => {
  const release = extractReleaseNotes(CHANGELOG, '0.68.6');
  assert.match(release.notes, /monorepos pnpm/i);
  assert.match(release.notes, /X\.Y\.Z/);
  assert.match(release.notes, /cooldown/i);
  assert.match(release.notes, /integridade/i);
});

test('[sensor:release-tests] as notas de 0.68.1 seguem extraíveis depois do bump', () => {
  // A entrada anterior precisa continuar íntegra: a v0.68.1 já tem tag e GitHub Release, e o
  // auto-tag relê o CHANGELOG para refrescar release existente.
  const release = extractReleaseNotes(CHANGELOG, '0.68.1');
  assert.equal(release.date, '2026-08-08');
  assert.match(release.notes, /VAULT_PATH_UNSAFE/);
  assert.match(release.notes, /walk fresco/i);
});

test('[sensor:release-tests] [req:REL-CI-1] release depende da matriz verde do mesmo SHA', () => {
  assert.match(RELEASE_WORKFLOW, /^  release:\r?\n    needs:\s*\[test, observer-macos, quality, codeql, dependency-audit\]$/m);
  assert.match(RELEASE_WORKFLOW, /^  push:\r?\n    branches:\s*\[main\]$/m);
  assert.match(RELEASE_WORKFLOW, /^  test:\r?\n    strategy:/m);
  assert.doesNotMatch(TEST_WORKFLOW, /^\s{2}push:/m, 'test.yml fica exclusivo para pull requests');
  assert.match(TEST_WORKFLOW, /^\s{2}pull_request:\s*$/m);
});

test('[sensor:release-tests] [req:REL-CI-2] workflow confiável publica antes de criar a tag no SHA testado', () => {
  const globalPermissions = RELEASE_WORKFLOW.match(/^permissions:\r?\n(?:  [^\r\n]+\r?\n?)+/m)?.[0] || '';
  const releasePermissions = RELEASE_WORKFLOW.match(/^  release:[\s\S]*?^    permissions:\r?\n(?:      [^\r\n]+\r?\n?)+/m)?.[0] || '';
  assert.match(globalPermissions, /contents:\s*read/);
  assert.doesNotMatch(globalPermissions, /id-token:\s*write/);
  assert.match(releasePermissions, /id-token:\s*write/);
  assert.match(RELEASE_WORKFLOW, /registry-url:\s*['"]https:\/\/registry\.npmjs\.org['"]/);
  assert.match(RELEASE_WORKFLOW, /node-version:\s*['"]2[4-9]['"]/);
  const publishAt = RELEASE_WORKFLOW.indexOf('      - name: Publish package');
  const tagAt = RELEASE_WORKFLOW.indexOf('      - name: Create verified tag');
  assert.ok(publishAt > -1, 'workflow precisa ter um passo real de publish');
  assert.ok(tagAt > -1, 'workflow precisa criar a tag comprovada');
  assert.ok(publishAt < tagAt, 'publish precisa ocorrer antes da tag');
  assert.match(RELEASE_PUBLISH_STEP, /npm view[\s\S]*--prefer-online/);
  assert.match(RELEASE_PUBLISH_STEP, /npm publish \.\/artifacts\/release-candidate\.tgz --provenance/);
  assert.match(RELEASE_WORKFLOW, /git tag -a "\$TAG" "\$GITHUB_SHA"/);
});

test('[sensor:release-tests] [req:REL-CI-3] release verifica proveniência e publica receipt', () => {
  assert.match(RELEASE_WORKFLOW, /release-provenance\.mjs --require-published --json/);
  assert.match(RELEASE_WORKFLOW, /release-receipt\.json/);
  assert.match(RELEASE_WORKFLOW, /actions\/upload-artifact@[a-f0-9]{40}\s+# v4/);
  assert.match(RELEASE_WORKFLOW, /finalize-release-receipt\.mjs/);
  assert.match(RELEASE_WORKFLOW, /gh release view "\$TAG" --json url/);
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

test('[sensor:release-tests] [req:CLI-PKG-2] versão publicada aborta mesmo sem tag alguma', () => {
  // Tag ausente não torna publicável um release já lançado: o registry recusaria com
  // EPUBLISHCONFLICT e o operador veria um erro de rede em vez da instrução de bump.
  const plan = resolveReleasePlan(releaseFacts({ tagCommit: null, publishedOnNpm: true }));
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


// Repositório sintético: o script resolve ROOT a partir do próprio caminho, então copiá-lo para
// um repo temporário permite controlar tag, versão e resposta do registry. Um npm falso apontado
// por npm_execpath torna `publishedOnNpm` determinístico e dispensa rede.
function syntheticRelease({ version, tagAt, publishedVersions = [] }) {
  const root = mkdtempSync(join(tmpdir(), 'wk-release-sim-'));
  const git = (args) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    for (const file of ['scripts/release.mjs', 'scripts/release-plan.mjs', 'src/release-changelog.mjs']) {
      writeFileSync(join(root, file), readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
    }
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'sim-pkg', version }, null, 2));
    writeFileSync(join(root, 'CHANGELOG.md'), `# Changelog\n\n## [${version}] — 2026-08-08\n\n### Fixed\n\n- Nota.\n`);
    writeFileSync(join(root, 'fake-npm.mjs'), `
      const [, , sub, spec] = process.argv;
      if (sub !== 'view') process.exit(0);
      const wanted = String(spec).split('@').pop();
      if (${JSON.stringify(publishedVersions)}.includes(wanted)) { console.log(wanted); process.exit(0); }
      process.exit(1);
    `);

    git(['init', '-q']);
    git(['config', 'user.email', 'sim@example.com']);
    git(['config', 'user.name', 'sim']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'sim']);
    if (tagAt === 'head') git(['tag', '-a', `v${version}`, '-m', 'sim']);
    if (tagAt === 'other') {
      const first = git(['rev-parse', 'HEAD']);
      writeFileSync(join(root, 'outro.txt'), 'divergente\n');
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'segundo']);
      git(['tag', '-a', `v${version}`, '-m', 'sim', first]);
    }

    try {
      const stdout = execFileSync(process.execPath, ['scripts/release.mjs', '--dry-run'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, npm_execpath: join(root, 'fake-npm.mjs') },
      });
      return { aborted: false, output: stdout };
    } catch (error) {
      return { aborted: true, output: `${error.stdout || ''}${error.stderr || ''}` };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const simSteps = (output) => [...output.matchAll(/^· \[dry\] (.+)$/gm)].map((m) => m[1]);

test('[sensor:release-tests] [req:CLI-PKG-2] script em repo sintético: sem tag publica e cria a tag', () => {
  const { aborted, output } = syntheticRelease({ version: '1.0.0' });
  assert.equal(aborted, false, output);
  const steps = simSteps(output);
  assert.equal(steps.length, 3, output);
  assert.match(steps[0], /npm publish/);
  assert.match(steps[1], /git tag -a v1\.0\.0/);
  assert.match(steps[2], /git push/);
});

test('[sensor:release-tests] [req:CLI-PKG-2] script em repo sintético: tag no HEAD publica sem recriar a tag', () => {
  // Este é o caminho que a mudança inteira existe para destravar, exercitado ponta a ponta.
  const { aborted, output } = syntheticRelease({ version: '1.0.0', tagAt: 'head' });
  assert.equal(aborted, false, output);
  const steps = simSteps(output);
  assert.deepEqual(steps.length, 2, output);
  assert.match(steps[0], /npm publish/);
  assert.ok(!steps.some((s) => s.includes('git tag -a')), `recriou a tag: ${output}`);
});

test('[sensor:release-tests] [req:CLI-PKG-2] script em repo sintético: versão publicada aborta sem executar', () => {
  const { aborted, output } = syntheticRelease({
    version: '1.0.0', tagAt: 'head', publishedVersions: ['1.0.0'],
  });
  assert.equal(aborted, true, output);
  assert.deepEqual(simSteps(output), [], output);
  assert.match(output, /já está publicad/i);
});

test('[sensor:release-tests] [req:CLI-PKG-2] script em repo sintético: tag divergente aborta sem executar', () => {
  const { aborted, output } = syntheticRelease({ version: '1.0.0', tagAt: 'other' });
  assert.equal(aborted, true, output);
  assert.deepEqual(simSteps(output), [], output);
  assert.match(output, /outro commit/i);
});

test('release: existing tag still refreshes the GitHub Release from CHANGELOG', () => {
  const tagBranch = RELEASE_WORKFLOW.match(/if git rev-parse[\s\S]*?^\s*fi$/m)?.[0] || '';
  assert.ok(tagBranch, 'workflow has an explicit existing/new tag branch');
  assert.doesNotMatch(tagBranch, /\bexit\s+0\b/, 'an existing tag must not skip release refresh');
  assert.ok(
    RELEASE_WORKFLOW.indexOf('gh release edit') > RELEASE_WORKFLOW.indexOf(tagBranch),
    'the existing-tag path reaches release edit',
  );
});

test('release: release readback normalizes the extra newline emitted by gh', () => {
  assert.match(RELEASE_WORKFLOW, /PUBLISHED_RELEASE_NOTES\.md/);
  assert.doesNotMatch(
    RELEASE_WORKFLOW,
    /diff -u RELEASE_NOTES\.md PUBLISHED_RELEASE_NOTES\.md/,
    'raw diff rejects an otherwise identical gh body because --jq appends one newline',
  );
  assert.match(RELEASE_WORKFLOW, /trimEnd\(\)/, 'comparison canonicalizes trailing newlines');
});

test('AGENTS: release closure requires updating and reading back notes from CHANGELOG', () => {
  assert.match(AGENT_RULES, /Fechamento obrigatório[\s\S]*CHANGELOG[\s\S]*GitHub Release/i);
  assert.match(AGENT_RULES, /gh release edit\s+vX\.Y\.Z/);
  assert.match(AGENT_RULES, /gh release view\s+vX\.Y\.Z/);
  assert.match(AGENT_RULES, /não (?:declare|considere)[\s\S]*release[\s\S]*concluída/i);
});
