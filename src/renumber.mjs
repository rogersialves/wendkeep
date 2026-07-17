// `wendkeep renumber-decisions|-bugs|-learnings` — retroactive renumbering. Renumbers every note
// in the derived folder (`ADR-`/`BUG-`/`APR-<NNNN>-<slug>`) in chronological order, renames the
// files (bugs/learnings also move out of legacy `DIA N` folders into the month folder), and
// rewrites every wikilink to them across the vault. Preview by default; --apply writes. Idempotent.
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { renumberDecisions } from '../hooks/renumber-decisions.mjs';
import { renumberDerived, DERIVED_KINDS } from '../hooks/renumber-derived.mjs';

function opt(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

function runRenumberCli(argv, cmdName, unitLabel, prefix, run) {
  const vaultRaw = opt(argv, '--vault') || process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultRaw) { process.stderr.write(`wendkeep ${cmdName}: no vault (--vault or OBSIDIAN_VAULT_PATH).\n`); process.exit(2); }
  const vaultBase = isAbsolute(vaultRaw) ? vaultRaw : resolve(process.cwd(), vaultRaw);
  if (!existsSync(vaultBase)) { process.stderr.write(`wendkeep ${cmdName}: vault not found: ${vaultBase}\n`); process.exit(2); }

  const apply = argv.includes('--apply');
  const report = run(vaultBase, { apply });

  if (argv.includes('--json')) { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); process.exit(0); }

  process.stdout.write(`${report.total} ${unitLabel} · ${report.renamed} a renomear${apply ? ` · ${report.filesTouched} arquivo(s) com links atualizados` : ''}\n`);
  for (const p of report.plan.filter((x) => x.renamed)) {
    process.stdout.write(`  ${prefix}-${String(p.num).padStart(4, '0')}  ${p.from}\n              → ${p.to}\n`);
  }
  if (!apply) process.stdout.write('\nNada foi escrito (preview). Rode com --apply para renomear e atualizar os wikilinks.\n');
  process.exit(0);
}

export function runRenumberDecisions(argv) {
  runRenumberCli(argv, 'renumber-decisions', 'decisão(ões)', 'ADR', (vault, o) => renumberDecisions(vault, o));
}

export function runRenumberBugs(argv) {
  runRenumberCli(argv, 'renumber-bugs', 'bug(s)', DERIVED_KINDS.bugs.prefix, (vault, o) => renumberDerived(vault, 'bugs', o));
}

export function runRenumberLearnings(argv) {
  runRenumberCli(argv, 'renumber-learnings', 'aprendizado(s)', DERIVED_KINDS.learnings.prefix, (vault, o) => renumberDerived(vault, 'learnings', o));
}
