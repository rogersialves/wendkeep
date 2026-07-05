// .agent/hooks/brain-recall.mjs
// Query engine read-only: pontua o índice por tópico. Token só no resultado.
// Uso: node .agent/hooks/brain-recall.mjs <termos da busca>
import { pathToFileURL } from 'node:url';
import { getVaultBase } from './obsidian-common.mjs';
import { loadIndex } from './brain-core.mjs';

export { loadIndex };

export function scoreRows(rows, query, topK = 5) {
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return rows
    .map((r) => {
      // Inclui slug do file + paths das derivadas (ADR/bug/aprendizado) no haystack:
      // os títulos das sessões e tags são genéricos; o sinal tópico vem dos slugs.
      const hay = `${r.summary || ''} ${(r.tags || []).join(' ')} ${r.file || ''} ${(r.decisions || []).join(' ')} ${(r.bugs || []).join(' ')} ${(r.learnings || []).join(' ')}`.toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score++;
      return { row: r, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || String(b.row.date || '').localeCompare(String(a.row.date || '')))
    .slice(0, topK)
    .map((s) => s.row);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const vaultBase = getVaultBase();
  const hits = scoreRows(loadIndex(vaultBase), process.argv.slice(2).join(' '));
  process.stdout.write(JSON.stringify(hits, null, 2) + '\n');
}
