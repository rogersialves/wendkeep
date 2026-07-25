// Reparo das notas de sessão que ficaram com frontmatter empilhado.
//
// O dano vem das versões anteriores à session-note-atomic-write: sem lock, um hook lia a
// nota já truncada por outro e prependava um frontmatter novo. Como o prepend entra pelo
// TOPO, o bloco de baixo é o original (o único com type/date/provider/source) e o de cima
// é a gravação mais recente. Ficar com um só perde metade da informação; a fusão é que é a
// resposta.
//
// A causa já está fechada — isto aqui limpa o que ficou para trás.
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { checkStackedFrontmatter } from './harness-doctor.mjs';
import { mutateSessionNote } from './session-note-io.mjs';

// Separa os blocos de frontmatter empilhados no topo do corpo da nota.
//
// A regra de "empilhado" é a MESMA de `checkStackedFrontmatter`: só conta como bloco o que
// reabre com `---` logo após o fechamento do anterior. Detector e reparador precisam
// concordar — se divergissem, o doctor acusaria uma nota que o reparo não conserta (ou
// pior, o reparo comeria corpo que o doctor considera são). Um `---` no meio do texto
// (regra horizontal, tabela) fica no corpo, onde deve ficar.
export function splitStackedFrontmatter(content) {
  const blocks = [];
  let rest = typeof content === 'string' ? content : '';

  while (/^---\n/.test(rest)) {
    const close = rest.indexOf('\n---', 4);
    if (close < 0) break;
    blocks.push(rest.slice(0, close + 4));
    rest = rest.slice(close + 4).replace(/^[\r\n]+/, '');
  }

  return { blocks, body: rest };
}

// Quebra o miolo de um frontmatter em entradas top-level, preservando as linhas literais.
// Uma linha `^chave:` abre a entrada; o que vier indentado/em branco pertence a ela. Nada é
// reinterpretado — listas YAML aninhadas atravessam byte-a-byte, sem reserializar aspas,
// recuo ou ordem (o que geraria um diff gigante numa nota de 228 KB).
function parseEntries(block) {
  const inner = block.replace(/^---\n/, '').replace(/\n---$/, '');
  const entries = new Map();
  let current = null;

  for (const line of inner.split('\n')) {
    const root = line.match(/^([A-Za-z0-9_-]+):/);
    if (root) {
      current = root[1];
      entries.set(current, [line]);
      continue;
    }
    if (current) entries.get(current).push(line);
  }

  // Linha em branco no fim de uma entrada é layout, não valor.
  for (const lines of entries.values()) {
    while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop();
  }
  return entries;
}

// Funde os blocos empilhados num só. Devolve `null` quando não há nada a fundir.
export function mergeStackedFrontmatter(content) {
  const { blocks, body } = splitStackedFrontmatter(content);
  if (blocks.length < 2) return null;

  // A base é o bloco de BAIXO: é o original, o único com as chaves-base, e define a ordem
  // das chaves. Depois aplica de baixo para cima, então o bloco do topo — a gravação mais
  // recente — é o último a escrever e vence. Chave que só existe num bloco de cima entra no
  // fim, nunca é descartada.
  const merged = parseEntries(blocks[blocks.length - 1]);
  for (let i = blocks.length - 2; i >= 0; i -= 1) {
    for (const [key, lines] of parseEntries(blocks[i])) merged.set(key, lines);
  }

  return `---\n${[...merged.values()].flat().join('\n')}\n---\n\n${body}`;
}

// Um reparo que perde dado é pior que o dano que ele conserta: só grava o que passar aqui.
function validateMerge(original, merged) {
  const after = splitStackedFrontmatter(merged);
  if (after.blocks.length !== 1) return 'resultado não ficou com um bloco só';

  const kept = new Set(parseEntries(after.blocks[0]).keys());
  const before = splitStackedFrontmatter(original);
  for (const block of before.blocks) {
    for (const key of parseEntries(block).keys()) {
      if (!kept.has(key)) return `chave perdida no merge: ${key}`;
    }
  }
  if (before.body && !merged.endsWith(before.body)) return 'corpo da nota não sobreviveu ao merge';
  return null;
}

// Varre as notas de sessão empilhadas e as funde. Dry-run por padrão.
export function repairStackedFrontmatter(vaultBase, { apply = false, lockTimeoutMs } = {}) {
  const repaired = [];
  const skipped = [];

  for (const abs of checkStackedFrontmatter(vaultBase).notes) {
    const rel = relative(vaultBase, abs).replaceAll('\\', '/');
    let original;
    try {
      original = readFileSync(abs, 'utf-8');
    } catch {
      skipped.push({ file: rel, reason: 'leitura falhou' });
      continue;
    }

    const merged = mergeStackedFrontmatter(original);
    if (merged === null) continue; // detector e merge concordam: nada a fundir

    const problem = validateMerge(original, merged);
    if (problem) {
      skipped.push({ file: rel, reason: problem });
      continue;
    }

    const blocks = splitStackedFrontmatter(original).blocks.length;
    if (!apply) {
      repaired.push({ file: rel, blocks });
      continue;
    }

    // Sob o mesmo lock dos hooks: reparar enquanto um subagente escreve seria repetir o bug.
    const outcome = mutateSessionNote(abs, () => merged, lockTimeoutMs ? { timeoutMs: lockTimeoutMs } : {});
    if (!outcome.written) {
      skipped.push({ file: rel, reason: `gravação não ocorreu (${outcome.reason})` });
      continue;
    }
    repaired.push({ file: rel, blocks });
  }

  return { applied: apply, repaired, skipped };
}
