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
  if (existsSync(STASH)) renameSync(STASH, README);
  copyFileSync(README, STASH);
  copyFileSync(ENGLISH, README);
}

function post() {
  if (!existsSync(STASH)) return; // nada a restaurar (pack não chegou a trocar)
  renameSync(STASH, README);
}

const mode = process.argv[2];
if (mode === 'pre') pre();
else if (mode === 'post') post();
else {
  console.error('uso: readme-pack.mjs pre|post');
  process.exit(2);
}
