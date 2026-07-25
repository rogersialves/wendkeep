// CLI-PKG-1: o repositório guarda o README em português (o que o GitHub exibe) e o tarball
// leva o inglês (a página do npm sempre renderiza o README.md do pacote).
//
// O teste olha o TARBALL, não a árvore de trabalho: é exatamente aí que os dois divergem de
// propósito, então conferir os arquivos do repo não provaria nada sobre o que o npm recebe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const isPt = (s) => /Seu agente de código esquece/.test(s);
const isEn = (s) => /Your AI coding agent forgets/.test(s);

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
    assert.ok(isEn(readFileSync(join(pkg, 'README.md'), 'utf8')),
      'o README.md DO TARBALL é o inglês — é o que a página do npm renderiza');
    assert.ok(existsSync(join(pkg, 'README.en.md')), 'e o inglês também viaja pelo nome próprio');

    // O prepack troca os arquivos; o postpack tem de restaurar.
    assert.ok(isPt(readFileSync(join(ROOT, 'README.md'), 'utf8')),
      'o repositório voltou ao português após o pack');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
