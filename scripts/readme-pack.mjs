#!/usr/bin/env node
// O repositório guarda o README em português — é o que o GitHub renderiza na página do
// projeto, e o público inicial é brasileiro. O npm precisa do inglês: a página do pacote
// SEMPRE renderiza o README.md do tarball, e não existe campo em package.json que aponte
// para outro arquivo. Então a troca tem de acontecer no empacotamento.
//
//   prepack   README.md -> .README.repo.bak ; README.en.md -> README.md
//   (npm empacota: o tarball leva o inglês)
//   postpack  .README.repo.bak -> README.md
//
// Rodar como hook (e não dentro do scripts/release.mjs) é o que cobre `npm publish` direto
// e `npm pack` — nem toda publicação passa pelo fluxo de release.
import { copyFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';

// No Windows uma operação de arquivo falha transitoriamente quando outro processo (antivírus,
// indexador) ainda segura o handle. Aqui isso é caro: se o `post` falhar, o REPOSITÓRIO fica
// com o inglês em README.md — foi o que o CI pegou em windows-latest/node 22, enquanto
// Windows 18/20 e Ubuntu passavam. `copyFile` + `unlink` tolera o que o `rename` não tolera.
function restore(from, to) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch {
      try {
        copyFileSync(from, to);
        try { unlinkSync(from); } catch { /* o .bak órfão é limpo pelo próximo `pre` */ }
        return;
      } catch {
        const until = Date.now() + 60;
        while (Date.now() < until) { /* espera curta antes de tentar de novo */ }
      }
    }
  }
  console.error(`readme-pack: não consegui restaurar ${to}. Rode: git checkout README.md`);
  process.exit(1);
}
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(ROOT, 'README.md');
const ENGLISH = join(ROOT, 'README.en.md');
const STASH = join(ROOT, '.README.repo.bak');

function pre() {
  if (!existsSync(ENGLISH)) {
    console.error('readme-pack: README.en.md não existe — o tarball sairia em português.');
    process.exit(1);
  }
  // Um .bak sobrevivente significa que um pack anterior morreu no meio: restaurar primeiro
  // evita empilhar o inglês por cima do inglês e perder o português de vez.
  if (existsSync(STASH)) restore(STASH, README);
  copyFileSync(README, STASH);
  copyFileSync(ENGLISH, README);
}

function post() {
  if (!existsSync(STASH)) return; // nada a restaurar (pack não chegou a trocar)
  restore(STASH, README);
}

const mode = process.argv[2];
if (mode === 'pre') pre();
else if (mode === 'post') post();
else {
  console.error('uso: readme-pack.mjs pre|post');
  process.exit(2);
}
