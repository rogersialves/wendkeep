import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasSessionFrontmatter, LOCK_BUSY, mutateSessionNote, withPathLock, writeFileAtomic } from '../hooks/session-note-io.mjs';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'wk-note-io-'));
}

test('writeFileAtomic grava o conteúdo e não deixa temporário para trás', () => {
  const root = scratch();
  try {
    const path = join(root, 'nota.md');
    writeFileAtomic(path, '---\ntype: session\n---\n\n# x\n');
    assert.equal(readFileSync(path, 'utf-8'), '---\ntype: session\n---\n\n# x\n');
    assert.deepEqual(readdirSync(root), ['nota.md'], 'nenhum .tmp sobrevive ao rename');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mutateSessionNote grava a saída do mutator e libera o lock', () => {
  const root = scratch();
  try {
    const path = join(root, 'nota.md');
    writeFileSync(path, '---\ntype: session\n---\n\n# x\n');

    const outcome = mutateSessionNote(path, (content) => `${content}extra\n`);

    assert.equal(outcome.written, true);
    assert.equal(outcome.reason, 'ok');
    assert.match(readFileSync(path, 'utf-8'), /extra\n$/);
    assert.equal(existsSync(`${path}.lock`), false, 'lock liberado');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mutateSessionNote: mutator devolvendo null aborta sem tocar no arquivo', () => {
  const root = scratch();
  try {
    const path = join(root, 'nota.md');
    const original = '---\ntype: session\n---\n\n# x\n';
    writeFileSync(path, original);

    const outcome = mutateSessionNote(path, () => null);

    assert.equal(outcome.written, false);
    assert.equal(outcome.reason, 'aborted');
    assert.equal(readFileSync(path, 'utf-8'), original, 'arquivo byte-idêntico');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mutateSessionNote: conteúdo idêntico não reescreve o arquivo', () => {
  const root = scratch();
  try {
    const path = join(root, 'nota.md');
    writeFileSync(path, '---\ntype: session\n---\n\n# x\n');
    const before = statSync(path).mtimeMs;

    const outcome = mutateSessionNote(path, (content) => content);

    assert.equal(outcome.written, false);
    assert.equal(outcome.reason, 'unchanged');
    assert.equal(statSync(path).mtimeMs, before, 'mtime preservado — nenhuma escrita ocorreu');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mutateSessionNote: arquivo inexistente não é criado', () => {
  const root = scratch();
  try {
    const path = join(root, 'ausente.md');
    const outcome = mutateSessionNote(path, () => 'novo');
    assert.equal(outcome.written, false);
    assert.equal(outcome.reason, 'missing');
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mutateSessionNote: lock fresco de outro processo faz o escritor desistir', () => {
  const root = scratch();
  try {
    const path = join(root, 'nota.md');
    const original = '---\ntype: session\n---\n\n# x\n';
    writeFileSync(path, original);
    mkdirSync(`${path}.lock`);

    const outcome = mutateSessionNote(path, () => 'nunca deveria gravar', { timeoutMs: 40 });

    assert.equal(outcome.written, false);
    assert.equal(outcome.reason, 'busy');
    assert.equal(readFileSync(path, 'utf-8'), original, 'desiste em vez de gravar sem lock');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mutateSessionNote: lock morto (stale) é removido e a gravação prossegue', () => {
  const root = scratch();
  try {
    const path = join(root, 'nota.md');
    writeFileSync(path, '---\ntype: session\n---\n\n# x\n');
    const lock = `${path}.lock`;
    mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);

    const outcome = mutateSessionNote(path, (content) => `${content}retomado\n`, { timeoutMs: 40, staleMs: 1000 });

    assert.equal(outcome.written, true);
    assert.match(readFileSync(path, 'utf-8'), /retomado\n$/);
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Regressão: `rmSync(dir, {recursive:true, force:true})` é NO-OP SILENCIOSO no Windows para
// caminho não-ASCII. Toda nota de sessão vive sob `02-Sessões/`, então o lock ficava preso e
// o segundo escritor desistia — turnos perdidos em silêncio.
test('o lock é liberado em caminho acentuado (02-Sessões)', () => {
  const root = scratch();
  try {
    const dir = join(root, '02-Sessões', '2026', '07-JUL', 'DIA 23');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'nota.md');
    writeFileSync(path, '---\ntype: session\n---\n\n# x\n');

    for (let i = 1; i <= 3; i += 1) {
      const outcome = mutateSessionNote(path, (content) => `${content}linha ${i}\n`, { timeoutMs: 100 });
      assert.equal(outcome.reason, 'ok', `gravação ${i} não pode encontrar o lock preso`);
      assert.equal(existsSync(`${path}.lock`), false, `lock liberado após a gravação ${i}`);
    }
    assert.match(readFileSync(path, 'utf-8'), /linha 1\nlinha 2\nlinha 3\n$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('withPathLock devolve LOCK_BUSY dentro do timeout quando o lock não vem', () => {
  const root = scratch();
  try {
    const path = join(root, 'nota.md');
    writeFileSync(path, 'x');
    mkdirSync(`${path}.lock`);

    const started = Date.now();
    const result = withPathLock(path, () => 'nunca', { timeoutMs: 60 });

    assert.equal(result, LOCK_BUSY);
    assert.ok(Date.now() - started < 5000, 'desiste no deadline em vez de girar');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('withPathLock libera o lock mesmo quando fn lança', () => {
  const root = scratch();
  try {
    const path = join(root, 'nota.md');
    writeFileSync(path, 'x');
    assert.throws(() => withPathLock(path, () => { throw new Error('boom'); }), /boom/);
    assert.equal(existsSync(`${path}.lock`), false, 'finally solta o lock');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Guarda estrutural: um escritor novo que volte ao writeFileSync cru reabre o buraco.
test('todos os hooks que reescrevem a nota de sessão passam por mutateSessionNote', () => {
  const hooks = [
    'token-usage.mjs', 'subagent-usage.mjs', 'session-observability.mjs',
    'session-stop.mjs', 'session-ensure.mjs', 'decision-capture.mjs', 'task-log.mjs',
  ];
  for (const hook of hooks) {
    const src = readFileSync(new URL(`../hooks/${hook}`, import.meta.url), 'utf-8');
    assert.match(src, /mutateSessionNote\b/, `${hook} deve gravar a nota via mutateSessionNote`);
    assert.doesNotMatch(src, /writeFileSync\(\s*sessionPath/, `${hook} não pode gravar a nota com writeFileSync cru`);
  }
});

test('hasSessionFrontmatter distingue nota íntegra de conteúdo truncado', () => {
  assert.equal(hasSessionFrontmatter('---\ntype: session\n---\n\n# x\n'), true);
  assert.equal(hasSessionFrontmatter('type: session\n---\n\n# x\n'), false, 'topo truncado');
  assert.equal(hasSessionFrontmatter('---\ntype: session\n'), false, 'fechamento ausente');
  assert.equal(hasSessionFrontmatter(''), false);
  assert.equal(hasSessionFrontmatter(null), false);
});
