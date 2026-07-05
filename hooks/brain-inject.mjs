// .agent/hooks/brain-inject.mjs
// Injeção da camada quente no SessionStart (Claude/Codex/Copilot): CORE curado +
// DIGEST auto + 1-linha pointer do recall. Budget-capada. Nunca derruba o hook.
// Uso (hook): node .agent/hooks/brain-inject.mjs   (input JSON via stdin)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getVaultBase, readHookInput, writeHookOutput } from './obsidian-common.mjs';
import { brainDir } from './brain-core.mjs';
import { buildActiveChangeInjection } from './change-core.mjs';

const MAX_LINES = 45; // CORE ≤25 + DIGEST ≤15 + folga; salvaguarda se o CORE crescer à mão

export function buildInjection(vaultBase) {
  const dir = brainDir(vaultBase);
  const read = (name) => {
    try { return readFileSync(join(dir, name), 'utf8').trim(); } catch { return ''; }
  };
  const pointer = 'Memória profunda sob demanda: /brain-recall <tópico> (índice .brain/index.jsonl).';
  // Quando CORE e DIGEST não existem, ''.split('\n') vira [''] — o filter derruba essa
  // linha vazia para o caso "só pointer" ficar com exatamente 3 linhas.
  let lines = [read('CORE.md'), read('DIGEST.md')].filter(Boolean).join('\n\n').split('\n').filter((l, i, a) => a.length > 1 || l);
  if (lines.length > MAX_LINES) {
    lines = lines.slice(0, MAX_LINES);
    lines.push('*…truncado pelo budget — fonte completa: .brain/CORE.md + .brain/DIGEST.md*');
  }
  const brain = ['<brain_memory>', ...lines, pointer, '</brain_memory>'].join('\n');
  const change = buildActiveChangeInjection(vaultBase);
  return change ? `${brain}\n${change}` : brain;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = readHookInput();
    writeHookOutput({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: buildInjection(getVaultBase(input)),
      },
    });
  } catch (error) {
    process.stderr.write(`[brain] inject falhou: ${error.message}\n`);
    writeHookOutput({});
  }
}
