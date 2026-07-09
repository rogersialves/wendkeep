// `wendkeep import` — retroactive memory. Scans this project's Claude Code transcripts and
// turns every session that isn't already in the vault into a full, dated session note (deduped
// by session_id). One command backfills your whole history: cost, subagents, iterations.
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { runImport, stampSessionIds, rescanDecisions } from '../hooks/import-sessions.mjs';

function opt(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

export function runImportCli(argv) {
  const vaultRaw = opt(argv, '--vault') || process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultRaw) { process.stderr.write('wendkeep import: no vault (--vault or OBSIDIAN_VAULT_PATH).\n'); process.exit(2); }
  const vaultBase = isAbsolute(vaultRaw) ? vaultRaw : resolve(process.cwd(), vaultRaw);
  if (!existsSync(vaultBase)) { process.stderr.write(`wendkeep import: vault not found: ${vaultBase}\n`); process.exit(2); }

  // Repair mode: re-scan already-imported transcripts for prose decisions only, then stop.
  if (argv.includes('--rescan-decisions')) {
    const r = rescanDecisions(vaultBase, { limit: Number(opt(argv, '--limit')) || 0 });
    if (argv.includes('--json')) { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); process.exit(0); }
    process.stdout.write(`${r.scanned} transcript(s) varridos · ${r.decisions} decisão(ões) capturadas\n`);
    for (const s of r.sessions) for (const n of s.notes) process.stdout.write(`  → ${n}\n`);
    if (r.errors.length) for (const e of r.errors) process.stderr.write(`  erro ${e.sessionId}: ${e.error}\n`);
    process.exit(0);
  }

  // Repair mode: backfill session_id into existing notes from the registry, then stop.
  if (argv.includes('--stamp-ids')) {
    const r = stampSessionIds(vaultBase);
    if (argv.includes('--json')) { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); process.exit(0); }
    process.stdout.write(`session_id carimbado em ${r.stamped} nota(s) · ${r.alreadyOk} já ok · ${r.missingFile} sem arquivo (de ${r.total} no registry)\n`);
    process.exit(0);
  }

  const projectRaw = opt(argv, '--project') || process.cwd();
  const projectPath = isAbsolute(projectRaw) ? projectRaw : resolve(process.cwd(), projectRaw);
  const source = (opt(argv, '--source') || 'all').toLowerCase();
  if (!['all', 'claude', 'codex'].includes(source)) {
    process.stderr.write(`wendkeep import: --source must be all | claude | codex (got "${source}").\n`);
    process.exit(2);
  }
  const from = opt(argv, '--from') || '';
  const codexFrom = opt(argv, '--codex-from') || '';
  const since = opt(argv, '--since') || '';
  const limit = Number(opt(argv, '--limit')) || 0;
  const dryRun = argv.includes('--dry-run');

  const report = runImport(vaultBase, { projectPath, source, from, codexFrom, since, limit, dryRun });

  if (argv.includes('--json')) { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); process.exit(0); }

  const verb = dryRun ? 'importaria' : 'importadas';
  if (report.claudeDir) process.stdout.write(`Claude: ${report.claudeDir}\n`);
  if (report.codexDir) process.stdout.write(`Codex:  ${report.codexDir}\n`);
  process.stdout.write(`${report.scanned} transcript(s) · ${report.imported} ${verb} · ${report.skipped} já no vault\n`);
  for (const s of report.sessions) {
    const tag = s.dryRun ? '(dry-run)' : '→';
    process.stdout.write(`  ${tag} ${s.sessionId}  ${s.turns} turno(s)${s.relPath ? `  ${s.relPath}` : ''}\n`);
  }
  if (report.errors.length) {
    process.stdout.write(`\n${report.errors.length} com erro (pulados):\n`);
    for (const e of report.errors) process.stdout.write(`  ${e.sessionId}: ${e.error}\n`);
  }
  if (dryRun) process.stdout.write('\nNada foi escrito (--dry-run). Rode sem --dry-run para criar as notas.\n');
  process.exit(0);
}
