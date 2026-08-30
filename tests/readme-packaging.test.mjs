// CLI-PKG-1: o repositório guarda o README em português (o que o GitHub exibe) e o tarball
// leva o inglês (a página do npm sempre renderiza o README.md do pacote).
//
// O teste olha o TARBALL, não a árvore de trabalho: é exatamente aí que os dois divergem de
// propósito, então conferir os arquivos do repo não provaria nada sobre o que o npm recebe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const isPt = (s) => /Seu agente de código esquece/.test(s);
const isEn = (s) => /Your AI coding agent forgets/.test(s);
const GUIDE_SLUGS = [
  'getting-started.md', 'operating-profiles.md', 'changes-and-verification.md', 'memory.md',
  'sessions-and-import.md', 'notes-and-knowledge.md', 'costs-and-observability.md',
  'maintenance-and-diagnostics.md', 'verify.md', 'memory-migration.md',
  'retroactive-import.md', 'observer.md', 'observer-security.md', 'worktrees.md',
  'context.md',
  'portable.md',
  'sync-protocol.md',
  'mcp.md',
  'evidence-embeddings.md',
  'capabilities.md',
  'tdd.md',
  'commit.md',
];

function filesUnder(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(absolute, base);
    return [absolute.slice(base.length + 1).replaceAll('\\', '/')];
  });
}

test('o repositório guarda o português como README.md e o inglês ao lado', () => {
  assert.ok(isPt(readFileSync(join(ROOT, 'README.md'), 'utf8')), 'README.md em português (GitHub)');
  assert.ok(isEn(readFileSync(join(ROOT, 'README.en.md'), 'utf8')), 'README.en.md em inglês');
});

test('os dois READMEs apontam um para o outro, sem link morto', () => {
  const pt = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const en = readFileSync(join(ROOT, 'README.en.md'), 'utf8');
  assert.match(pt, /\]\(README\.en\.md\)/, 'português linka o inglês');
  assert.match(en, /\]\(README\.md\)/, 'inglês linka o português');
  assert.ok(!/README\.pt-BR\.md/.test(pt + en), 'o nome antigo não sobrevive em nenhum dos dois');
});

test('os dois idiomas viajam no pacote', () => {
  const files = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).files;
  for (const f of ['README.md', 'README.en.md']) assert.ok(files.includes(f), `${f} em files`);
});

test('[req:OP-9] package, lockfile raiz e primeira release do CHANGELOG convergem', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const lockfile = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const firstRelease = changelog.match(/^## \[([^\]]+)\]/m)?.[1];

  assert.equal(lockfile.version, manifest.version, 'package-lock.json.version acompanha package.json');
  assert.equal(lockfile.packages[''].version, manifest.version,
    'packages[""].version acompanha package.json');
  assert.equal(firstRelease, manifest.version,
    'a primeira entrada versionada do CHANGELOG acompanha package.json');
});

test('DOC-5: somente os diretórios de guias bilíngues são adicionados ao pacote', () => {
  const files = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).files;
  assert.ok(files.includes('docs/pt-BR/commands/*.md'), 'glob PT-BR em files');
  assert.ok(files.includes('docs/en/commands/*.md'), 'glob EN em files');
  assert.ok(!files.includes('docs'), 'o acervo histórico inteiro não pode viajar por acidente');
});

test('[req:OBS-UI-1] a interface do Observer viaja explicitamente no pacote', () => {
  const files = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).files;
  assert.ok(files.includes('web/observer'), 'a interface do Observer precisa ser empacotada');
});

// Medido num projeto pnpm limpo, sem configuração alguma (pnpm 11.5.2):
//   $ pnpm add -D wendkeep@latest
//   + wendkeep 0.49.0 (0.57.1 is available)
// Saiu 0, sem erro, e instalou a versão de dois dias antes — `minimumReleaseAge` é default
// do pnpm 11. Um comando que falha em silêncio não pode aparecer como recomendação.
//
// Teste de texto, sim: o defeito que ele guarda TAMBÉM é de texto, e o erro plausível é
// copiar o bloco npm de cima trocando o gerenciador. Ancorado em `pnpm add` de propósito —
// o bloco npm usa `@latest` legitimamente, npm não tem cooldown.
test('nenhum README manda instalar por pnpm com @latest', () => {
  for (const file of ['README.md', 'README.en.md']) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const armadilha = text.match(/^.*pnpm add .*wendkeep@latest.*$/m);
    assert.equal(armadilha, null,
      `${file} recomenda um pnpm add que instala versão antiga em silêncio:\n  ${armadilha?.[0]}`);
  }
});

test('a atualização por pnpm resolve e reinstala a versão publicada', () => {
  const files = [
    'README.md',
    'README.en.md',
    'docs/pt-BR/commands/getting-started.md',
    'docs/en/commands/getting-started.md',
  ];
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    assert.match(text, /pnpm view wendkeep version/, `${file} consulta a versão publicada`);
    assert.match(text, /wendkeep@\$version/, `${file} reutiliza a versão consultada`);
    assert.match(text, /pnpm add .*--config\.minimumReleaseAge=0/, `${file} desativa o cooldown só para a atualização`);
    assert.match(text, /pnpm install --update-checksums --config\.minimumReleaseAge=0/, `${file} documenta a regeneração do lock`);
    assert.match(text, /pnpm exec wendkeep sync/, `${file} executa o binário pelo pnpm`);
    assert.doesNotMatch(
      text,
      /^pnpm add .*wendkeep@(?:latest|X\.Y\.Z).*$/m,
      `${file} não pode deixar um argumento literal ou silenciosamente atrasado copiável`,
    );
  }
});

// O que realmente importa: o conteúdo do tarball, e o repo intacto depois.
test('[req:OP-9] [req:RECALL-13] npm pack leva módulos de profile/FLOW/delivery, docs bilíngues e restaura o README', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'wk-pack-'));
  const packRoot = join(outDir, 'workspace');
  try {
    // `prepack` troca README.md no cwd por exigência do npm. Empacotar a árvore de trabalho
    // real durante `npm test` cria uma corrida com DOC-1/readme tests, que podem ler o inglês
    // enquanto o hook está ativo. O contrato é o mesmo em uma cópia isolada, sem mutar o repo.
    cpSync(ROOT, packRoot, {
      recursive: true,
      filter: (source) => {
        const normalized = source.replaceAll('\\', '/');
        const isExcludedPath = (name) => normalized.includes(`/${name}/`)
          || normalized.endsWith(`/${name}`);
        return !isExcludedPath('node_modules')
          && !isExcludedPath('.git')
          && !isExcludedPath('.WendKeep-vault')
          && !isExcludedPath('.codex')
          && !isExcludedPath('.claude')
          && !isExcludedPath('.agents');
      },
    });
    const packed = spawnSync('npm', ['pack', '--pack-destination', outDir], {
      cwd: packRoot, encoding: 'utf8', shell: process.platform === 'win32',
    });
    assert.equal(packed.status, 0, packed.stderr);

    const tgz = readdirSync(outDir).find((f) => f.endsWith('.tgz'));
    assert.ok(tgz, `nenhum .tgz gerado em ${outDir}`);

    // cwd + nome relativo: o tar do MSYS lê `C:\...` como host remoto e falha com
    // "Cannot connect to C: resolve failed". Assim funciona em Windows e Linux.
    const untar = spawnSync('tar', ['-xzf', tgz], {
      cwd: outDir, encoding: 'utf8', shell: process.platform === 'win32',
    });
    assert.equal(untar.status, 0, untar.stderr);

    const pkg = join(outDir, 'package');
    const packedManifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
    const sourceManifest = JSON.parse(readFileSync(join(packRoot, 'package.json'), 'utf8'));
    assert.equal(packedManifest.version, sourceManifest.version,
      `DOC-5: o tarball deve declarar exatamente a release ${sourceManifest.version}`);
    assert.ok(isEn(readFileSync(join(pkg, 'README.md'), 'utf8')),
      'o README.md DO TARBALL é o inglês — é o que a página do npm renderiza');
    assert.ok(existsSync(join(pkg, 'README.en.md')), 'e o inglês também viaja pelo nome próprio');
    for (const modulePath of [
      'src/profile.mjs',
      'src/flow.mjs',
      'src/work-kind.mjs',
      'src/delivery.mjs',
      'src/context.mjs',
      'src/portable.mjs',
      'src/sync-protocol.mjs',
      'src/sync-outbox.mjs',
      'src/sync-adapters.mjs',
      'src/sync-protocol-cli.mjs',
      'packages/mcp/src/sync.mjs',
      'src/tdd.mjs',
      'src/tdd-attestation.mjs',
      'src/tdd-attestation-store.mjs',
      'hooks/flow-core.mjs',
      'hooks/operating-profile-task-store.mjs',
      'hooks/vault-path-safety.mjs',
      'web/observer/index.html',
      'web/observer/styles.css',
      'web/observer/app.mjs',
      'web/observer/favicon.svg',
      'packages/mcp/src/audit.mjs',
      'packages/mcp/src/cli.mjs',
      'packages/mcp/src/effects.mjs',
      'packages/mcp/src/executor.mjs',
      'packages/mcp/src/server.mjs',
      'packages/mcp/src/stdio.mjs',
      'schema/mcp-effect-manifest-v1.schema.json',
      'schema/mcp-tool-input-v1.schema.json',
      'schema/mcp-tool-result-v1.schema.json',
    ]) {
      assert.ok(
        existsSync(join(pkg, ...modulePath.split('/'))),
        `módulo público de Perfis de Operação ausente no tarball: ${modulePath}`,
      );
    }
    for (const locale of ['pt-BR', 'en']) {
      for (const guide of GUIDE_SLUGS) {
        assert.ok(existsSync(join(pkg, 'docs', locale, 'commands', guide)),
          `guia ausente no tarball: docs/${locale}/commands/${guide}`);
      }
      const profiles = readFileSync(join(pkg, 'docs', locale, 'commands', 'operating-profiles.md'), 'utf8');
      for (const token of [
        'OFF', 'FLOW', 'GUIDE', 'GOVERN', 'ASSURE', 'Keep Core',
        'wendkeep profile status', 'wendkeep profile route', 'wendkeep flow finish', 'wendkeep flow promote',
        'wendkeep delivery start', 'wendkeep delivery finish', 'change new --guide',
      ]) assert.match(profiles, new RegExp(token), `guia empacotado ${locale} sem ${token}`);
    }
    const expectedDocs = ['pt-BR', 'en']
      .flatMap((locale) => GUIDE_SLUGS.map((guide) => `${locale}/commands/${guide}`))
      .sort();
    assert.deepEqual(filesUnder(join(pkg, 'docs')).sort(), expectedDocs,
      'o tarball não pode incluir o acervo histórico de docs');

    // O prepack troca os arquivos; o postpack tem de restaurar.
    assert.ok(isPt(readFileSync(join(packRoot, 'README.md'), 'utf8')),
      'o repositório voltou ao português após o pack');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    // Se o postpack falhou, o assert acima já acusou — mas a árvore de trabalho não pode
    // ficar com o inglês em README.md por causa de um teste. Restaura sem mascarar a falha.
    const stash = join(ROOT, '.README.repo.bak');
    if (existsSync(stash)) {
      copyFileSync(stash, join(ROOT, 'README.md'));
      rmSync(stash, { force: true });
    }
  }
});
