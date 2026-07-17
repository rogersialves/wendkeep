// `wendkeep spec <sub>` — read-only views over the living specs in 07-Specs (0.7.0).
import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  adoptSpecsState,
  buildEffectiveRequirementPackage,
  captureSpecBaseline,
  discoverSpecDeltas,
  parseRequirements,
  specConflicts,
} from '../hooks/spec-core.mjs';
import { activeChange, parseTasks } from '../hooks/change-core.mjs';
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

  const option = (name) => {
    const index = rest.indexOf(name);
    if (index >= 0) return rest[index + 1];
    const entry = rest.find((a) => a.startsWith(`${name}=`));
    return entry ? entry.slice(name.length + 1) : undefined;
  };

  if (sub === 'effective') {
    const slug = option('--change') || activeChange(vaultBase);
    if (!slug) { process.stderr.write('wendkeep spec effective: no change (--change or current)\n'); process.exit(2); }
    const changeDir = join(vaultBase, getLocale(vaultBase).folders.changes, slug);
    let tasks = [];
    try {
      readFileSync(join(changeDir, 'proposta.md'), 'utf8');
      tasks = parseTasks(readFileSync(join(changeDir, 'tarefas.md'), 'utf8'));
    }
    catch { process.stderr.write(`wendkeep spec effective: change not found: ${slug}\n`); process.exit(2); }
    const reqIds = [...new Set(tasks.flatMap((task) => task.reqs ?? []))];
    const effective = buildEffectiveRequirementPackage(vaultBase, changeDir, reqIds);
    if (effective.errors.length) {
      process.stderr.write(`wendkeep spec effective: invalid delta: ${effective.errors.join('; ')}\n`);
      process.exit(1);
    }
    if (rest.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ slug, effectiveSpecHash: effective.hash, specs: effective.specs }, null, 2)}\n`);
    } else {
      process.stdout.write(`change: ${slug}\neffective-spec-hash: ${effective.hash}\n`);
      for (const spec of effective.specs) {
        process.stdout.write(`spec: ${spec.capability}\n`);
        for (const req of spec.requirements) process.stdout.write(`  ${req.operation === 'BASE' ? '=' : req.operation === 'ADDED' ? '+' : '~'} ${req.id || req.name} [${req.source}]\n`);
      }
    }
    process.exit(0);
  }

  if (sub === 'migrate') {
    const state = adoptSpecsState(vaultBase);
    process.stdout.write(`spec state adopted: ${Object.keys(state.specs).length} living spec(s); 07-Specs is generated/read-only\n`);
    process.exit(0);
  }

  if (sub === 'rebase') {
    const slug = option('--change') || activeChange(vaultBase);
    if (!slug) { process.stderr.write('wendkeep spec rebase: no change (--change or current)\n'); process.exit(2); }
    const changeDir = join(vaultBase, getLocale(vaultBase).folders.changes, slug);
    try { readFileSync(join(changeDir, 'proposta.md'), 'utf8'); }
    catch { process.stderr.write(`wendkeep spec rebase: change not found: ${slug}\n`); process.exit(2); }
    const capabilities = discoverSpecDeltas(changeDir);
    const conflicts = specConflicts(vaultBase, changeDir, capabilities);
    if (conflicts.length && !rest.includes('--accept-current')) {
      process.stderr.write(`wendkeep spec rebase: conflicts: ${conflicts.join('; ')} — reconcile delta, then rerun with --accept-current\n`);
      process.exit(1);
    }
    captureSpecBaseline(vaultBase, changeDir, { refresh: true });
    process.stdout.write(`spec baseline rebased: ${slug}${conflicts.length ? ` (${conflicts.length} conflict(s) accepted)` : ''}\n`);
    process.exit(0);
  }

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

  process.stderr.write(`wendkeep spec: unknown subcommand "${sub}". Known: list, show, effective, migrate, rebase.\n`);
  process.exit(2);
}
