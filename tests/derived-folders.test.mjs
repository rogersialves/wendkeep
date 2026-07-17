// Derived notes (decisions/bugs/learnings) are filed by YEAR/MONTH, not by day.
// Sessions keep their day-level folder — verified here for contrast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  monthFolderRelFromDateStr,
  datedFolderRelFromDateStr,
} from '../hooks/obsidian-common.mjs';

test('monthFolderRelFromDateStr: <folder>/<year>/<MM-MON>, no DIA', () => {
  assert.equal(monthFolderRelFromDateStr('05-Bugs', '2026-06-29'), join('05-Bugs', '2026', '06-JUN'));
  assert.equal(monthFolderRelFromDateStr('04-Decisões', '2026-01-05'), join('04-Decisões', '2026', '01-JAN'));
  assert.doesNotMatch(monthFolderRelFromDateStr('06-Aprendizados', '2026-06-29'), /DIA/);
});

test('datedFolderRelFromDateStr: sessions still include DIA (unchanged)', () => {
  assert.match(datedFolderRelFromDateStr('02-Sessões', '2026-06-29'), /DIA 29/);
});

// DRV-1 — `note new` nunca cria subpasta DIA (trava e2e via bin)
test('note new: created path never contains a DIA subfolder', async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { dirname } = await import('node:path');
  const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');
  const vault = mkdtempSync(join(tmpdir(), 'wk-nodia-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  try {
    const r = spawnSync(process.execPath, [BIN, 'note', 'new', '--type', 'learning', 'sem dia', '--vault', vault], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /DIA/, 'path sem subpasta DIA');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
