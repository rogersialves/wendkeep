#!/usr/bin/env node
// Retroactive ADR renumbering (0.30.0). The decision folder accumulated three naming eras:
// canonical ADR-NNN, dated `YYYY-MM-DD-escolha-<slug>` (hook capture pre-0.30), and hand-written
// `YYYY-MM-DD-<slug>`. This renumbers EVERY note in 04-Decisões to `ADR-<NNNN>-<slug>` in strict
// chronological order (the order decisions were made), renames the files in place, updates every
// wikilink to them across the whole vault, and normalizes each note's `type`/`adr`/H1. Idempotent:
// running it again on an already-canonical vault is a no-op (same order, same names).
import { readdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { getLocale } from './locale.mjs';

export const padAdr = (n) => String(n).padStart(4, '0');

// Every .md under 04-Decisões, absolute + vault-relative (posix slashes for wikilinks).
function walkDecisions(vaultBase, decisionsDir) {
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
  walk(join(vaultBase, decisionsDir));
  return out;
}

// Chronological sort key: date, then time, then existing ADR number, then filename — all derived
// from (in priority) frontmatter, filename prefix, and the dated folder path.
export function decisionSortKey({ abs, base, content }) {
  const c = content ?? (existsSync(abs) ? safeRead(abs) : '');
  const fmDate = c.match(/^date:\s*(\d{4}-\d{2}-\d{2})/m);
  const fnDate = base.match(/^(\d{4}-\d{2}-\d{2})/);
  const folderDate = abs.replaceAll('\\', '/').match(/\/(\d{4})\/(\d{2})-[^/]+\/DIA\s+(\d{1,2})\//i);
  let date = '9999-12-31';
  if (fmDate) date = fmDate[1];
  else if (fnDate) date = fnDate[1];
  else if (folderDate) date = `${folderDate[1]}-${folderDate[2]}-${String(folderDate[3]).padStart(2, '0')}`;

  const fmTime = c.match(/^started_at:\s*\S*T(\d{2}:\d{2}:\d{2})/m);
  const srcTime = c.match(/\[\[[^\]]*\/(\d{2})-(\d{2})-[^\]]*\]\]/); // session wikilink HH-MM prefix
  let time = '00:00:00';
  if (fmTime) time = fmTime[1];
  else if (srcTime) time = `${srcTime[1]}:${srcTime[2]}:00`;

  const adr = base.match(/^ADR-(\d+)/i);
  const adrNum = adr ? Number(adr[1]) : 999999;
  return `${date}T${time}#${String(adrNum).padStart(6, '0')}#${base}`;
}

function safeRead(abs) {
  try { return readFileSync(abs, 'utf8'); } catch { return ''; }
}

// Descriptive slug from any of the three eras' filenames.
export function slugFromDecisionName(base) {
  let s = base.replace(/\.md$/i, '');
  s = s.replace(/^ADR-\d+-/i, '');
  s = s.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  s = s.replace(/^escolha-/i, '');
  return s || 'decisao';
}

// Normalize one decision note's body: type -> decision, adr: <num>, and an `ADR-NNNN — ` H1 prefix.
export function normalizeDecisionContent(content, adrNum) {
  let c = String(content || '');
  const label = `ADR-${padAdr(adrNum)}`;

  // type: decisao|decisão|decision  ->  decision
  if (/^type:\s*.*$/m.test(c)) c = c.replace(/^type:\s*.*$/m, 'type: decision');
  else c = c.replace(/^---\n/, `---\ntype: decision\n`);

  // adr: <num>  (replace if present, else insert right after the type line)
  if (/^adr:\s*.*$/m.test(c)) c = c.replace(/^adr:\s*.*$/m, `adr: ${adrNum}`);
  else c = c.replace(/^type: decision$/m, `type: decision\nadr: ${adrNum}`);

  // H1: strip any existing `ADR-\d+ — ` prefix, then prepend the canonical label.
  c = c.replace(/^#\s+(.*)$/m, (_, title) => {
    const bare = title.replace(/^ADR-\d+\s*[—–-]\s*/i, '').trim();
    return `# ${label} — ${bare}`;
  });
  return c;
}

// Replace every wikilink to a renamed note across one file's text. `renames` carries the old/new
// vault-relative path (no extension) and basename so both full-path and basename links are caught.
export function rewriteLinks(content, renames) {
  let c = String(content || '');
  for (const r of renames) {
    if (r.oldRelNoExt === r.newRelNoExt) continue;
    c = c.split(`[[${r.oldRelNoExt}]]`).join(`[[${r.newRelNoExt}]]`);
    c = c.split(`[[${r.oldRelNoExt}|`).join(`[[${r.newRelNoExt}|`);
    c = c.split(`[[${r.oldBaseNoExt}]]`).join(`[[${r.newBaseNoExt}]]`);
    c = c.split(`[[${r.oldBaseNoExt}|`).join(`[[${r.newBaseNoExt}|`);
    // Best-effort: refresh a `|ADR-006]]` display alias to the new padded id.
    if (r.oldAdrLabel) c = c.split(`|${r.oldAdrLabel}]]`).join(`|${r.newAdrLabel}]]`);
  }
  return c;
}

function allVaultMarkdown(vaultBase) {
  const out = [];
  const skip = new Set(['.git', '.obsidian', 'node_modules', '_arquivo']);
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.brain') continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(abs); }
      else if (e.name.endsWith('.md')) out.push(abs);
    }
  };
  walk(vaultBase);
  return out;
}

// Build the chronological renumber plan. Pure: reads notes, sorts, computes new names. No writes.
export function planRenumber(vaultBase) {
  const decisionsDir = getLocale(vaultBase).folders.decisions;
  const notes = walkDecisions(vaultBase, decisionsDir)
    .map((n) => ({ ...n, content: safeRead(n.abs) }))
    .sort((a, b) => decisionSortKey(a).localeCompare(decisionSortKey(b)));

  const renames = [];
  notes.forEach((n, i) => {
    const num = i + 1;
    const slug = slugFromDecisionName(n.base);
    const newBase = `ADR-${padAdr(num)}-${slug}.md`;
    const folderRel = dirname(n.rel);
    const newRel = folderRel === '.' ? newBase : `${folderRel}/${newBase}`;
    const oldAdr = n.base.match(/^ADR-(\d+)/i);
    renames.push({
      num, slug,
      oldAbs: n.abs,
      newAbs: join(dirname(n.abs), newBase),
      oldRelNoExt: n.rel.replace(/\.md$/i, ''),
      newRelNoExt: newRel.replace(/\.md$/i, ''),
      oldBaseNoExt: n.base.replace(/\.md$/i, ''),
      newBaseNoExt: newBase.replace(/\.md$/i, ''),
      oldAdrLabel: oldAdr ? `ADR-${String(Number(oldAdr[1])).padStart(3, '0')}` : '',
      newAdrLabel: `ADR-${padAdr(num)}`,
      renamed: n.base !== newBase,
    });
  });
  return renames;
}

// Execute the plan: collision-safe rename (via temp), body normalization, vault-wide link rewrite.
export function renumberDecisions(vaultBase, { apply = false } = {}) {
  const renames = planRenumber(vaultBase);
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

  // Phase A — park every renamed source under a temp name so no target clobbers a not-yet-moved source.
  const temps = new Map();
  changed.forEach((r, i) => {
    const tmp = join(dirname(r.oldAbs), `.wk-renum-${i}.tmp`);
    renameSync(r.oldAbs, tmp);
    temps.set(r, tmp);
  });

  // Phase B — normalize each note's body, then land it at its final path. For a renamed note we
  // write the normalized content back over its temp and renameSync temp -> final (no delete: the
  // temp file becomes the final file). For an unchanged name we just rewrite in place.
  for (const r of renames) {
    const tmp = temps.get(r);
    if (tmp) {
      writeFileSync(tmp, normalizeDecisionContent(safeRead(tmp), r.num), 'utf8');
      renameSync(tmp, r.newAbs);
    } else {
      writeFileSync(r.newAbs, normalizeDecisionContent(safeRead(r.oldAbs), r.num), 'utf8');
    }
    report.normalized += 1;
  }

  // Phase C — rewrite wikilinks to any renamed note across the whole vault.
  const linkRenames = changed;
  for (const abs of allVaultMarkdown(vaultBase)) {
    const before = safeRead(abs);
    const after = rewriteLinks(before, linkRenames);
    if (after !== before) { writeFileSync(abs, after, 'utf8'); report.filesTouched += 1; report.linksUpdated += 1; }
  }
  return report;
}
