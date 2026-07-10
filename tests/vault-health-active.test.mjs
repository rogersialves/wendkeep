import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVaultHealth } from '../hooks/vault-health.mjs';
import { writeControl } from '../hooks/obsidian-common.mjs';

test('vault health aceita sessão ativa sem Encerramento quando usage está antes de Pendências', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-health-active-'));
  try {
    const rel = '02-Sessões/2026/07-JUL/DIA 09/ativa.md';
    const transcript = join(vault, 'transcript.jsonl');
    mkdirSync(join(vault, '02-Sessões', '2026', '07-JUL', 'DIA 09'), { recursive: true });
    writeFileSync(join(vault, rel), '# ativa\n\n## Iterações\n\n## Uso de tokens e custos\n\nok\n\n## Pendências\n\nNenhuma.\n');
    writeFileSync(transcript, '{}\n');
    writeControl(vault, { status: 'active', session_file: rel, session_id: 's1' });
    writeFileSync(join(vault, '.brain', 'SESSION_REGISTRY.json'), JSON.stringify({
      version: 1,
      sessions: { s1: { status: 'active', session_file: rel, transcript_path: transcript } },
    }));
    const r = runVaultHealth({ vaultBase: vault });
    assert.equal(r.ok, true, r.failures.join('; '));
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
