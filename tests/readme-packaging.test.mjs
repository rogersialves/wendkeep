// CLI-PKG-1: o repositório guarda o README em português (o que o GitHub exibe) e o tarball
// leva o inglês (a página do npm sempre renderiza o README.md do pacote).
//
// O teste olha o TARBALL, não a árvore de trabalho: é exatamente aí que os dois divergem de
// propósito, então conferir os arquivos do repo não provaria nada sobre o que o npm recebe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const isPt = (s) => /Seu agente de código esquece/.test(s);
const isEn = (s) => /Your AI coding agent forgets/.test(s);
const GUIDE_SLUGS = [
  'getting-started.md', 'changes-and-verification.md', 'memory.md',
  'sessions-and-import.md', 'notes-and-knowledge.md', 'costs-and-observability.md',
  'maintenance-and-diagnostics.md', 'verify.md', 'memory-migration.md',
  'retroactive-import.md',
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

test('DOC-5: somente os diretórios de guias bilíngues são adicionados ao pacote', () => {
  const files = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).files;
  assert.ok(files.includes('docs/pt-BR/commands/*.md'), 'glob PT-BR em files');
  assert.ok(files.includes('docs/en/commands/*.md'), 'glob EN em files');
  assert.ok(!files.includes('docs'), 'o acervo histórico inteiro não pode viajar por acidente');
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

// O que realmente importa: o conteúdo do tarball, e o repo intacto depois.
test('npm pack: o tarball leva o inglês e o repositório volta ao português', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'wk-pack-'));
  try {
    const packed = spawnSync('npm', ['pack', '--pack-destination', outDir], {
      cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32',
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
    assert.equal(packedManifest.version, '0.58.2', 'DOC-5: o tarball deve declarar exatamente a release 0.58.2');
    assert.ok(isEn(readFileSync(join(pkg, 'README.md'), 'utf8')),
      'o README.md DO TARBALL é o inglês — é o que a página do npm renderiza');
    assert.ok(existsSync(join(pkg, 'README.en.md')), 'e o inglês também viaja pelo nome próprio');
    for (const locale of ['pt-BR', 'en']) {
      for (const guide of GUIDE_SLUGS) {
        assert.ok(existsSync(join(pkg, 'docs', locale, 'commands', guide)),
          `guia ausente no tarball: docs/${locale}/commands/${guide}`);
      }
    }
    const expectedDocs = ['pt-BR', 'en']
      .flatMap((locale) => GUIDE_SLUGS.map((guide) => `${locale}/commands/${guide}`))
      .sort();
    assert.deepEqual(filesUnder(join(pkg, 'docs')).sort(), expectedDocs,
      'o tarball não pode incluir o acervo histórico de docs');

    // O prepack troca os arquivos; o postpack tem de restaurar.
    assert.ok(isPt(readFileSync(join(ROOT, 'README.md'), 'utf8')),
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
