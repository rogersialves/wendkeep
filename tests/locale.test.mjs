import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCALES, getLocale, clearLocaleCache } from '../hooks/locale.mjs';

test('getLocale: pt-BR default (no config), en via .brain/config.json, bad locale falls back', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-loc-'));
  try {
    assert.equal(getLocale(vault).id, 'pt-BR');
    clearLocaleCache();
    mkdirSync(join(vault, '.brain'), { recursive: true });
    writeFileSync(join(vault, '.brain', 'config.json'), '{ "locale": "en" }');
    assert.equal(getLocale(vault).id, 'en');
    assert.equal(getLocale(vault).folders.changes, '08-Changes');
    clearLocaleCache();
    writeFileSync(join(vault, '.brain', 'config.json'), '{ "locale": "xx" }');
    assert.equal(getLocale(vault).id, 'pt-BR', 'unknown locale falls back');
  } finally { clearLocaleCache(); rmSync(vault, { recursive: true, force: true }); }
});

test('locales carry the same keys; folder numbering is stable across locales', () => {
  const pt = LOCALES['pt-BR'];
  const en = LOCALES.en;
  assert.deepEqual(Object.keys(en.folders), Object.keys(pt.folders));
  assert.equal(pt.months.length, 12);
  assert.equal(en.months.length, 12);
  for (const k of Object.keys(pt.folders)) {
    assert.equal(pt.folders[k].slice(0, 3), en.folders[k].slice(0, 3), `${k} keeps its NN- prefix`);
  }
  assert.equal(en.coreSections.length, 3);
});
