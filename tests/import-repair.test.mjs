// A session the live hook registered but never filled (BUG-0003) used to be invisible to
// `wendkeep import`: dedup asked "is it registered?" instead of "does it have the turns?",
// so the exact sessions the recovery command exists for were the ones it refused to touch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runImport } from '../hooks/import-sessions.mjs';

const TRANSCRIPT = [
  { type: 'user', uuid: 't1', timestamp: '2026-06-13T09:00:00.000Z', sessionId: 'sid-repair', message: { role: 'user', content: 'Primeira pergunta sobre autenticacao' } },
  { type: 'assistant', uuid: 'a1', timestamp: '2026-06-13T09:00:05.000Z', sessionId: 'sid-repair', message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 200 }, content: [{ type: 'text', text: 'Resposta um' }] } },
  { type: 'user', uuid: 't2', timestamp: '2026-06-13T09:05:00.000Z', sessionId: 'sid-repair', message: { role: 'user', content: 'Segunda pergunta do usuario' } },
  { type: 'assistant', uuid: 'a2', timestamp: '2026-06-13T09:05:05.000Z', sessionId: 'sid-repair', message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 50, output_tokens: 80 }, content: [{ type: 'text', text: 'Resposta dois' }] } },
];

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const turnMarkers = (md) => (md.match(/<!-- wk-turn: /g) || []).length;

function walkNotes(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkNotes(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function seed() {
  const src = tmp('wk-rep-src-');
  const vault = tmp('wk-rep-vault-');
  writeFileSync(join(src, 'sid-repair.jsonl'), TRANSCRIPT.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  const first = runImport(vault, { source: 'claude', from: src });
  const note = join(vault, first.sessions[0].relPath);
  return { src, vault, note };
}

const sessionNotes = (vault) => walkNotes(join(vault, '02-Sessões'));

// --- IMPORT-1 ----------------------------------------------------------------

test('runImport: completa uma sessão registrada cuja nota ficou sem nenhum turno', () => {
  const { src, vault, note } = seed();
  assert.equal(turnMarkers(readFileSync(note, 'utf8')), 2, 'pré-condição: nota cheia');

  // Reproduz o dano do BUG-0003: registro sobrevive, iterações somem.
  const gutted = readFileSync(note, 'utf8').replace(/\n### \d\d:\d\d - [\s\S]*?(?=\n## )/g, '\n');
  writeFileSync(note, gutted, 'utf-8');
  assert.equal(turnMarkers(readFileSync(note, 'utf8')), 0, 'pré-condição: nota esvaziada');

  const repair = runImport(vault, { source: 'claude', from: src });
  assert.equal(turnMarkers(readFileSync(note, 'utf8')), 2, 'os dois turnos voltaram');
  assert.equal(sessionNotes(vault).length, 1, 'reparo na nota existente, não numa segunda');
  assert.equal(repair.repaired, 1, 'contada como reparada, não pulada');
  assert.equal(repair.skipped, 0);
  assert.equal(repair.imported, 0, 'não é nota nova — `imported` fica pra criação do zero');
});

test('runImport: nota já completa é pulada e não é modificada', () => {
  const { src, vault, note } = seed();
  const before = readFileSync(note, 'utf8');

  const rerun = runImport(vault, { source: 'claude', from: src });
  assert.equal(readFileSync(note, 'utf8'), before, 'byte a byte idêntica');
  assert.equal(rerun.imported, 0);
  assert.equal(rerun.skipped, 1);
});

test('runImport: cobertura parcial acrescenta só o turno que falta, sem duplicar', () => {
  const { src, vault, note } = seed();
  // Remove apenas o último bloco de iteração.
  const md = readFileSync(note, 'utf8');
  const cut = md.lastIndexOf('\n### ');
  const end = md.indexOf('\n## ', cut);
  writeFileSync(note, md.slice(0, cut) + md.slice(end), 'utf-8');
  assert.equal(turnMarkers(readFileSync(note, 'utf8')), 1, 'pré-condição: um turno só');

  runImport(vault, { source: 'claude', from: src });
  assert.equal(turnMarkers(readFileSync(note, 'utf8')), 2, 'o que faltava entrou');
  const ids = readFileSync(note, 'utf8').match(/<!-- wk-turn: ([^\s]+) -->/g) || [];
  assert.equal(new Set(ids).size, ids.length, 'nenhum turno duplicado');
});

test('runImport: reparar é idempotente — a terceira rodada não muda nada', () => {
  const { src, vault, note } = seed();
  writeFileSync(note, readFileSync(note, 'utf8').replace(/\n### \d\d:\d\d - [\s\S]*?(?=\n## )/g, '\n'), 'utf-8');
  runImport(vault, { source: 'claude', from: src });
  const afterRepair = readFileSync(note, 'utf8');
  runImport(vault, { source: 'claude', from: src });
  assert.equal(readFileSync(note, 'utf8'), afterRepair, 'no-op depois de reparada');
  assert.equal(sessionNotes(vault).length, 1);
});

// --- IMPORT-2 ----------------------------------------------------------------

test('runImport: relatório separa já-completa de completada', () => {
  const { src, vault, note } = seed();
  writeFileSync(note, readFileSync(note, 'utf8').replace(/\n### \d\d:\d\d - [\s\S]*?(?=\n## )/g, '\n'), 'utf-8');

  const repaired = runImport(vault, { source: 'claude', from: src });
  assert.equal(repaired.repaired, 1, 'a sessão completada é contada à parte');
  assert.equal(repaired.skipped, 0);

  const noop = runImport(vault, { source: 'claude', from: src });
  assert.equal(noop.repaired, 0);
  assert.equal(noop.skipped, 1, 'já completa conta como pulada');
});
