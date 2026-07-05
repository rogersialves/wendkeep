// .agent/hooks/brain-reindex.mjs
// Backfill manual: reconstrói .brain/index.jsonl + .brain/DIGEST.md varrendo todo 02-Sessões.
// Uso: node .agent/hooks/brain-reindex.mjs [caminho-do-vault]
import { pathToFileURL } from 'node:url';
import { getVaultBase } from './obsidian-common.mjs';
import { buildBrainDigest, buildBrainIndex, brainDir } from './brain-core.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const vaultBase = getVaultBase({ obsidian_vault_path: process.argv[2] });
  const rows = buildBrainIndex(vaultBase);
  const digest = buildBrainDigest(vaultBase, rows);
  process.stdout.write(`[brain] index: ${rows.length} sessões; digest: ${digest.length} linhas → ${brainDir(vaultBase)}\n`);
}
