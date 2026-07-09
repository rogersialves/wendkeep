// `wendkeep renumber-decisions` — retroactive ADR fix. Renumbers every note in 04-Decisões to
// `ADR-<NNNN>-<slug>` in chronological order, renames the files, and rewrites every wikilink to
// them across the vault. Preview by default; pass --apply to write. Idempotent.
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { renumberDecisions } from '../hooks/renumber-decisions.mjs';

function opt(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

export function runRenumberDecisions(argv) {
  const vaultRaw = opt(argv, '--vault') || process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultRaw) { process.stderr.write('wendkeep renumber-decisions: no vault (--vault or OBSIDIAN_VAULT_PATH).\n'); process.exit(2); }
  const vaultBase = isAbsolute(vaultRaw) ? vaultRaw : resolve(process.cwd(), vaultRaw);
  if (!existsSync(vaultBase)) { process.stderr.write(`wendkeep renumber-decisions: vault not found: ${vaultBase}\n`); process.exit(2); }

  const apply = argv.includes('--apply');
  const report = renumberDecisions(vaultBase, { apply });

  if (argv.includes('--json')) { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); process.exit(0); }

  process.stdout.write(`${report.total} decisão(ões) · ${report.renamed} a renomear${apply ? ` · ${report.filesTouched} arquivo(s) com links atualizados` : ''}\n`);
  for (const p of report.plan.filter((x) => x.renamed)) {
    process.stdout.write(`  ADR-${String(p.num).padStart(4, '0')}  ${p.from}\n              → ${p.to}\n`);
  }
  if (!apply) process.stdout.write('\nNada foi escrito (preview). Rode com --apply para renomear e atualizar os wikilinks.\n');
  process.exit(0);
}
