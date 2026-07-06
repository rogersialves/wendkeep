// `wendkeep spec <sub>` — read-only views over the living specs in 07-Specs (0.7.0).
import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseRequirements } from '../hooks/spec-core.mjs';
import { getLocale } from '../hooks/locale.mjs';

function resolveVault(argv) {
  let vault;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--vault') vault = argv[++i];
    else if (a.startsWith('--vault=')) vault = a.slice(8);
  }
  const base = vault || process.env.OBSIDIAN_VAULT_PATH;
  if (!base) {
    process.stderr.write('wendkeep spec: no vault. Pass --vault <path> or set OBSIDIAN_VAULT_PATH.\n');
    process.exit(2);
  }
  return isAbsolute(base) ? base : resolve(process.cwd(), base);
}

export function runSpec(argv) {
  const [sub, ...rest] = argv;
  const vaultBase = resolveVault(rest);
  const specsDir = join(vaultBase, getLocale(vaultBase).folders.specs);

  if (sub === 'list') {
    let files = [];
    try { files = readdirSync(specsDir).filter((f) => f.endsWith('.md') && f !== 'README.md'); } catch { /* sem specs */ }
    if (!files.length) { process.stdout.write('specs: (nenhuma)\n'); process.exit(0); }
    for (const f of files) {
      const md = readFileSync(join(specsDir, f), 'utf8');
      const n = parseRequirements(md).length;
      const upd = md.match(/> Atualizado por .* em (\d{4}-\d{2}-\d{2})/);
      process.stdout.write(`${f.replace(/\.md$/, '')}: ${n} requisito(s)${upd ? ` (atualizado ${upd[1]})` : ''}\n`);
    }
    process.exit(0);
  }

  if (sub === 'show') {
    const cap = rest.find((a, i) => !a.startsWith('-') && rest[i - 1] !== '--vault');
    if (!cap) { process.stderr.write('wendkeep spec show: missing <capability>\n'); process.exit(2); }
    let md;
    try { md = readFileSync(join(specsDir, `${cap}.md`), 'utf8'); }
    catch { process.stderr.write(`wendkeep spec show: not found: ${cap}\n`); process.exit(2); }
    const reqs = parseRequirements(md);
    process.stdout.write(`${cap}: ${reqs.length} requisito(s)\n`);
    for (const r of reqs) process.stdout.write(`  ${r.id ? `${r.id} — ` : ''}${r.name}\n`);
    process.exit(0);
  }

  process.stderr.write(`wendkeep spec: unknown subcommand "${sub}". Known: list, show.\n`);
  process.exit(2);
}
