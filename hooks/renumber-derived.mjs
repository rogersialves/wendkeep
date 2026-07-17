#!/usr/bin/env node
// Retroactive renumbering for the OTHER derived-note families (0.41.0): 05-Bugs -> BUG-NNNN,
// 06-Aprendizados/06-Learnings -> APR-NNNN. Mirrors renumber-decisions with one deliberate
// difference: the destination is always the MONTH folder of the note's resolved date — legacy
// `DIA N` subfolders and dated root notes are moved up/in, then empty `DIA *` dirs are removed.
// (Decisions renumber preserves dirname; the semantics differ, so the modules stay separate.)
// Known edge: an issueRef that itself starts with `BUG-\d+` would be eaten by the slug strip.
import { readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { getLocale } from './locale.mjs';
import { ensureDir, monthFolderRelFromDateStr } from './obsidian-common.mjs';
import { padAdr, rewriteLinks, allVaultMarkdown } from './renumber-decisions.mjs';

export const DERIVED_KINDS = {
  bugs: { folderKey: 'bugs', prefix: 'BUG', numField: 'bug', type: 'bug', fallbackSlug: 'bug' },
  learnings: { folderKey: 'learnings', prefix: 'APR', numField: 'apr', type: 'learning', fallbackSlug: 'aprendizado' },
};

function safeRead(abs) {
  try { return readFileSync(abs, 'utf8'); } catch { return ''; }
}

function walkNotes(vaultBase, folderRel) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith('.md')) {
        out.push({ abs, rel: relative(vaultBase, abs).replaceAll('\\', '/'), base: e.name });
      }
    }
  };
  walk(join(vaultBase, folderRel));
  return out;
}

// Resolve the note's date (frontmatter > filename prefix > `DIA N` folder > month folder).
// Returns 'YYYY-MM-DD' or '' when nothing is derivable.
export function derivedNoteDate({ abs, base, content }) {
  const c = content ?? safeRead(abs);
  const fmDate = c.match(/^date:\s*(\d{4}-\d{2}-\d{2})/m);
  if (fmDate) return fmDate[1];
  const fnDate = base.match(/^(\d{4}-\d{2}-\d{2})/);
  if (fnDate) return fnDate[1];
  const posix = abs.replaceAll('\\', '/');
  const dayFolder = posix.match(/\/(\d{4})\/(\d{2})-[^/]+\/DIA\s+(\d{1,2})\//i);
  if (dayFolder) return `${dayFolder[1]}-${dayFolder[2]}-${String(dayFolder[3]).padStart(2, '0')}`;
  const monthFolder = posix.match(/\/(\d{4})\/(\d{2})-[^/]+\//);
  if (monthFolder) return `${monthFolder[1]}-${monthFolder[2]}-01`;
  return '';
}

function derivedSortKey(note, prefix) {
  const date = derivedNoteDate(note) || '9999-12-31';
  const numMatch = note.base.match(new RegExp(`^${prefix}-(\\d+)`, 'i'));
  const num = numMatch ? Number(numMatch[1]) : 999999;
  return `${date}#${String(num).padStart(6, '0')}#${note.base}`;
}

// Descriptive slug from any era's filename: PREFIX-NNNN-, date prefix and legacy `bug-` marker out.
export function slugFromDerivedName(base, kind) {
  let s = base.replace(/\.md$/i, '');
  s = s.replace(new RegExp(`^${kind.prefix}-\\d+-`, 'i'), '');
  s = s.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  if (kind.folderKey === 'bugs') s = s.replace(/^bug-/i, '');
  return s || kind.fallbackSlug;
}

// Normalize body: type, numeric field (bug:/apr:) and the canonical `PREFIX-NNNN — ` H1.
export function normalizeDerivedContent(content, num, kind) {
  let c = String(content || '');
  const label = `${kind.prefix}-${padAdr(num)}`;

  if (/^type:\s*.*$/m.test(c)) c = c.replace(/^type:\s*.*$/m, `type: ${kind.type}`);
  else c = c.replace(/^---\n/, `---\ntype: ${kind.type}\n`);

  const fieldRe = new RegExp(`^${kind.numField}:\\s*.*$`, 'm');
  if (fieldRe.test(c)) c = c.replace(fieldRe, `${kind.numField}: ${num}`);
  else c = c.replace(new RegExp(`^type: ${kind.type}$`, 'm'), `type: ${kind.type}\n${kind.numField}: ${num}`);

  c = c.replace(/^#\s+(.*)$/m, (_, title) => {
    let bare = title.replace(new RegExp(`^${kind.prefix}-\\d+\\s*[—–-]\\s*`, 'i'), '');
    bare = bare.replace(/^(?:Bug|Aprendizado|Learning)\s*[-—–]\s*/i, '').trim();
    return `# ${label} — ${bare}`;
  });
  return c;
}

// Pure plan: chronological numbering, destination = month folder of the resolved date
// (fallback: keep the current dirname when no date is derivable).
export function planRenumberDerived(vaultBase, kindId) {
  const kind = DERIVED_KINDS[kindId];
  if (!kind) throw new Error(`renumber-derived: unknown kind "${kindId}"`);
  const folderRel = getLocale(vaultBase).folders[kind.folderKey];
  const notes = walkNotes(vaultBase, folderRel)
    .map((n) => ({ ...n, content: safeRead(n.abs) }))
    .sort((a, b) => derivedSortKey(a, kind.prefix).localeCompare(derivedSortKey(b, kind.prefix)));

  const renames = [];
  notes.forEach((n, i) => {
    const num = i + 1;
    const slug = slugFromDerivedName(n.base, kind);
    const newBase = `${kind.prefix}-${padAdr(num)}-${slug}.md`;
    const date = derivedNoteDate(n);
    const destDirRel = date ? monthFolderRelFromDateStr(folderRel, date, vaultBase) : dirname(n.rel);
    const newRel = `${destDirRel.replaceAll('\\', '/')}/${newBase}`;
    renames.push({
      num, slug,
      oldAbs: n.abs,
      newAbs: join(vaultBase, destDirRel, newBase),
      oldRelNoExt: n.rel.replace(/\.md$/i, ''),
      newRelNoExt: newRel.replace(/\.md$/i, ''),
      oldBaseNoExt: n.base.replace(/\.md$/i, ''),
      newBaseNoExt: newBase.replace(/\.md$/i, ''),
      renamed: n.rel !== newRel,
    });
  });
  return renames;
}

// Remove now-empty `DIA *` folders under the derived root (best-effort, fail-quiet).
function pruneEmptyDayFolders(vaultBase, folderRel) {
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const abs = join(dir, e.name);
      walk(abs);
      if (/^DIA\s/i.test(e.name)) {
        try { rmdirSync(abs); } catch { /* não-vazio — fica */ }
      }
    }
  };
  walk(join(vaultBase, folderRel));
}

export function renumberDerived(vaultBase, kindId, { apply = false } = {}) {
  const kind = DERIVED_KINDS[kindId];
  const renames = planRenumberDerived(vaultBase, kindId);
  const changed = renames.filter((r) => r.renamed);
  const report = {
    total: renames.length,
    renamed: changed.length,
    normalized: 0,
    linksUpdated: 0,
    filesTouched: 0,
    plan: renames.map((r) => ({ num: r.num, from: r.oldRelNoExt, to: r.newRelNoExt, renamed: r.renamed })),
    applied: apply,
  };
  if (!apply) return report;

  // Phase A — park renamed sources under temp names (no target clobbers an unmoved source).
  const temps = new Map();
  changed.forEach((r, i) => {
    const tmp = join(dirname(r.oldAbs), `.wk-renum-${i}.tmp`);
    renameSync(r.oldAbs, tmp);
    temps.set(r, tmp);
  });

  // Phase B — normalize body and land at the final path (possibly a different directory).
  for (const r of renames) {
    const tmp = temps.get(r);
    ensureDir(dirname(r.newAbs));
    if (tmp) {
      writeFileSync(tmp, normalizeDerivedContent(safeRead(tmp), r.num, kind), 'utf8');
      renameSync(tmp, r.newAbs);
    } else {
      writeFileSync(r.newAbs, normalizeDerivedContent(safeRead(r.oldAbs), r.num, kind), 'utf8');
    }
    report.normalized += 1;
  }

  // Phase C — rewrite wikilinks vault-wide (full-path and basename forms).
  for (const abs of allVaultMarkdown(vaultBase)) {
    const before = safeRead(abs);
    const after = rewriteLinks(before, changed);
    if (after !== before) { writeFileSync(abs, after, 'utf8'); report.filesTouched += 1; report.linksUpdated += 1; }
  }

  // Phase D — drop empty legacy `DIA *` folders.
  pruneEmptyDayFolders(vaultBase, getLocale(vaultBase).folders[kind.folderKey]);
  return report;
}
