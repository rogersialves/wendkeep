// `wendkeep note new` — manual derived notes without guesswork. The agent (or a human)
// asks for a bug/learning note and gets it already numbered (BUG-/APR-NNNN), in the month
// folder of the right derived tree, with the correct frontmatter — and the created vault
// path on stdout. Nobody computes the next number by hand, nobody recreates `DIA N` folders.
import { existsSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve, join, dirname } from 'node:path';
import {
  ensureDir,
  getNextDerivedNumber,
  monthFolderRelFromDateStr,
  readControl,
  slugify,
  uniquePath,
  toVaultRelative,
} from '../hooks/obsidian-common.mjs';
import { getLocale } from '../hooks/locale.mjs';
import { buildManualBugNote, buildManualLearningNote, relinkDerivedNotes } from '../hooks/linked-notes.mjs';

const TYPES = {
  bug: { folderKey: 'bugs', prefix: 'BUG', build: buildManualBugNote },
  learning: { folderKey: 'learnings', prefix: 'APR', build: buildManualLearningNote },
};

function opt(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

export function runNote(argv) {
  const [sub, ...rest] = argv;

  if (sub === 'relink') {
    const vaultRaw = opt(rest, '--vault') || process.env.OBSIDIAN_VAULT_PATH;
    if (!vaultRaw) { process.stderr.write('wendkeep note relink: no vault (--vault or OBSIDIAN_VAULT_PATH).\n'); process.exit(2); }
    const vaultBase = isAbsolute(vaultRaw) ? vaultRaw : resolve(process.cwd(), vaultRaw);
    if (!existsSync(vaultBase)) { process.stderr.write(`wendkeep note relink: vault not found: ${vaultBase}\n`); process.exit(2); }
    const r = relinkDerivedNotes(vaultBase, { apply: rest.includes('--apply') });
    if (rest.includes('--json')) { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); process.exit(0); }
    process.stdout.write(`${r.linked.length} nota(s) derivada(s) órfã(s)${r.applied ? ' linkadas' : ' seriam linkadas'}\n`);
    for (const l of r.linked) process.stdout.write(`  ${l.file} -> ${l.session}\n`);
    for (const s of r.skipped) process.stdout.write(`  pulado: ${s.file} (${s.reason})\n`);
    if (!r.applied && r.linked.length) process.stdout.write('\ndry-run — nada escrito. Rode com --apply para injetar os backlinks.\n');
    process.exit(0);
  }

  if (sub !== 'new') {
    process.stderr.write('wendkeep note: subcomando desconhecido (use `note new --type bug|learning "<título>"` ou `note relink [--apply]`).\n');
    process.exit(2);
  }

  const type = (opt(rest, '--type') || '').toLowerCase();
  const kind = TYPES[type];
  if (!kind) {
    process.stderr.write('wendkeep note new: --type deve ser bug ou learning.\n');
    process.exit(2);
  }

  // Título = primeiro argumento posicional (não-flag, não-valor de flag).
  const flagValues = new Set([opt(rest, '--type'), opt(rest, '--vault'), opt(rest, '--date')].filter(Boolean));
  const title = rest.find((a) => !a.startsWith('--') && !flagValues.has(a));
  if (!title || !title.trim()) {
    process.stderr.write('wendkeep note new: falta o título — `note new --type bug "resumo do bug"`.\n');
    process.exit(2);
  }

  const dateStr = opt(rest, '--date') || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    process.stderr.write(`wendkeep note new: --date inválida "${dateStr}" (use YYYY-MM-DD).\n`);
    process.exit(2);
  }

  const vaultRaw = opt(rest, '--vault') || process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultRaw) { process.stderr.write('wendkeep note new: no vault (--vault or OBSIDIAN_VAULT_PATH).\n'); process.exit(2); }
  const vaultBase = isAbsolute(vaultRaw) ? vaultRaw : resolve(process.cwd(), vaultRaw);
  if (!existsSync(vaultBase)) { process.stderr.write(`wendkeep note new: vault not found: ${vaultBase}\n`); process.exit(2); }

  const loc = getLocale(vaultBase);
  const num = getNextDerivedNumber(vaultBase, kind.folderKey, kind.prefix);
  const dirRel = monthFolderRelFromDateStr(loc.folders[kind.folderKey], dateStr, vaultBase);
  const fileName = `${kind.prefix}-${String(num).padStart(4, '0')}-${slugify(title, type, 60)}.md`;
  const filePath = uniquePath(join(vaultBase, dirRel, fileName));
  ensureDir(dirname(filePath));

  let sessionRel = '';
  try {
    const control = readControl(vaultBase);
    if (control?.status === 'active' && control.session_file) sessionRel = control.session_file;
  } catch { /* sem sessão ativa — nota nasce sem backlink */ }

  writeFileSync(filePath, kind.build(title.trim(), { num, dateStr, sessionRel, localeId: loc.id }), 'utf8');
  process.stdout.write(`${toVaultRelative(vaultBase, filePath)}\n`);
  process.exit(0);
}
