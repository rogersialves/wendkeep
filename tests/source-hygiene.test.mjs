// A literal control byte in a source file makes `file` classify it as binary and ripgrep
// skip it by default — a Grep over that file silently returns nothing. It happened three
// times before this test existed (taxonomy.mjs NUL+0x1f, token-usage.mjs 2×NUL), always the
// same way: an escape sequence written as the raw byte. This scans everything we ship.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['hooks', 'src', 'bin'];

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(mjs|js|json)$/i.test(e.name)) out.push(p);
  }
  return out;
}

test('nenhum fonte publicado contém byte de controle literal (fora de tab/LF/CR)', () => {
  const offenders = [];
  for (const dir of DIRS) {
    for (const f of walk(join(ROOT, dir))) {
      const b = readFileSync(f);
      for (let i = 0; i < b.length; i += 1) {
        const c = b[i];
        if (c < 9 || (c > 10 && c < 32 && c !== 13)) {
          offenders.push(`${f} @${i} (0x${c.toString(16).padStart(2, '0')})`);
          break; // um por arquivo basta pra apontar
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `escape a sequência em vez do byte cru:\n${offenders.join('\n')}`);
});
