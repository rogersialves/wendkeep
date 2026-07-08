// hooks/change-core.mjs
// Native change/spec lifecycle in the vault (Pilar B). Vault-facing lib consumed by
// the `wendkeep change` CLI (src/change.mjs) and the brain-inject hook. No external deps.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureDir, wikilinkFromRel, monthFolderRelFromDateStr } from './obsidian-common.mjs';
import { parseSpecsList, promoteSpecs } from './spec-core.mjs';
import { getLocale } from './locale.mjs';

export const ARCHIVE_DIR = '_arquivo';
const POINTER = '.brain/CURRENT_CHANGE.md';

export function changeDirRel(slug, vaultBase) {
  return join(getLocale(vaultBase).folders.changes, slug);
}

export function renderChangeScaffold({ slug, sessionRel, dateStr, locale = 'pt-BR' }) {
  const en = locale === 'en';
  const source = sessionRel ? `\n  - "${wikilinkFromRel(sessionRel)}"` : ' []';
  const proposta = `---
type: change
status: active
date: ${dateStr}
cssclasses:
  - topic-change
tags:
  - mudanca
source:${source}
specs: []
---

# ${slug}

${en ? '## Why\n\n(reason for the change)\n\n## What changes\n\n(scope of the change)' : '## Por quê\n\n(motivo da mudança)\n\n## O que muda\n\n(escopo da mudança)'}
`;
  const design = `# ${slug} — design

${en ? '## Approach\n\n(technical approach)' : '## Abordagem\n\n(abordagem técnica)'}
`;
  const tarefas = `# ${slug} — ${en ? 'tasks' : 'tarefas'}

- [ ] 1.1 ${en ? '(first task)' : '(primeira tarefa)'}
`;
  const reqHeading = en ? 'Requirement' : 'Requisito';
  const specDelta = `## ADDED Requirements
### ${reqHeading}: ${en ? '(name)' : '(nome)'}
${en ? '(behaviour / scenarios)' : '(comportamento / cenários)'}

## MODIFIED Requirements

## REMOVED Requirements
`;
  return { proposta, design, tarefas, specDelta };
}

// Scaffold placeholder markers per file (pt + en, mirrors renderChangeScaffold). A change whose
// proposta/design/tarefas still carry these was never actually planned — archiving it mints a
// bogus ADR and pollutes _arquivo (seen in production). The archive gate blocks on them.
const SCAFFOLD_MARKERS = [
  ['proposta.md', ['(motivo da mudança)', '(escopo da mudança)', '(reason for the change)', '(scope of the change)']],
  ['design.md', ['(abordagem técnica)', '(technical approach)']],
  ['tarefas.md', ['(primeira tarefa)', '(first task)']],
];

export function scaffoldPlaceholders(dir) {
  const found = [];
  for (const [file, markers] of SCAFFOLD_MARKERS) {
    let content = '';
    try { content = readFileSync(join(dir, file), 'utf8'); } catch { continue; }
    for (const m of markers) if (content.includes(m)) found.push(`${file}: ${m}`);
  }
  return found;
}

export function activeChange(vaultBase) {
  try {
    const m = readFileSync(join(vaultBase, POINTER), 'utf8').match(/^change:\s*(.+)$/m);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

export function setActiveChange(vaultBase, slug) {
  mkdirSync(join(vaultBase, '.brain'), { recursive: true });
  writeFileSync(join(vaultBase, POINTER), `change: ${slug}\n`, 'utf8');
}

export function clearActiveChange(vaultBase) {
  const p = join(vaultBase, POINTER);
  if (existsSync(p)) writeFileSync(p, 'change:\n', 'utf8');
}

export function newChange(vaultBase, slug, { sessionRel = '', dateStr, simple = false }) {
  const loc = getLocale(vaultBase);
  const dir = join(vaultBase, loc.folders.changes, slug);
  const existed = existsSync(join(dir, 'proposta.md'));
  mkdirSync(dir, { recursive: true });
  const files = renderChangeScaffold({ slug, sessionRel, dateStr, locale: loc.id });
  const write = (name, content) => {
    const f = join(dir, name);
    if (!existsSync(f)) writeFileSync(f, content, 'utf8');
  };
  write('proposta.md', files.proposta);
  write('tarefas.md', files.tarefas);
  // Auto-sizing (Wave B): a --simple change skips the design + spec-delta scaffold.
  if (!simple) {
    write('design.md', files.design);
    const exampleDelta = join(dir, 'specs', 'exemplo', 'spec.md');
    if (!existsSync(exampleDelta)) {
      mkdirSync(join(dir, 'specs', 'exemplo'), { recursive: true });
      writeFileSync(exampleDelta, files.specDelta, 'utf8');
    }
  }
  setActiveChange(vaultBase, slug);
  return { rel: changeDirRel(slug, vaultBase), created: !existed };
}

export function parseTasks(md) {
  const tasks = [];
  const re = /^-\s+\[( |x)\]\s+(\S+)\s+(.*)$/gm;
  const sensorRe = /\[sensor:\s*([\w.-]+)\]/;
  const reqRe = /\[req:\s*([A-Z][A-Z0-9]*-\d+)\]/;
  let m;
  while ((m = re.exec(String(md))) !== null) {
    let text = m[3].trim();
    const sm = text.match(sensorRe);
    const rm = text.match(reqRe);
    const sensor = sm ? sm[1] : undefined;
    const req = rm ? rm[1] : undefined;
    if (sm) text = text.replace(sensorRe, '');
    if (rm) text = text.replace(reqRe, '');
    text = text.replace(/\s+/g, ' ').trim();
    tasks.push({ id: m[2], text, done: m[1] === 'x', ...(sensor ? { sensor } : {}), ...(req ? { req } : {}) });
  }
  return tasks;
}

// Toggle a task checkbox by its exact id (0.7.0 ergonomics). Returns false when absent.
export function setTaskDone(changeDir, taskId, done = true) {
  const path = join(changeDir, 'tarefas.md');
  const md = readFileSync(path, 'utf8');
  const esc = String(taskId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(-\\s+\\[)( |x)(\\]\\s+${esc}\\s)`, 'm');
  if (!re.test(md)) return false;
  writeFileSync(path, md.replace(re, `$1${done ? 'x' : ' '}$3`), 'utf8');
  return true;
}

export function listChanges(vaultBase) {
  const base = join(vaultBase, getLocale(vaultBase).folders.changes);
  const active = [];
  let archived = [];
  try {
    for (const name of readdirSync(base)) {
      if (name === ARCHIVE_DIR) continue;
      if (existsSync(join(base, name, 'proposta.md'))) active.push(name);
    }
  } catch { /* no changes dir yet */ }
  try {
    archived = readdirSync(join(base, ARCHIVE_DIR)).filter((n) => !n.startsWith('.'));
  } catch { /* none */ }
  return { active, archived };
}

export function buildActiveChangeInjection(vaultBase, { maxTasks = 8 } = {}) {
  const slug = activeChange(vaultBase);
  if (!slug) return '';
  const chDir = getLocale(vaultBase).folders.changes;
  let md = '';
  try { md = readFileSync(join(vaultBase, chDir, slug, 'tarefas.md'), 'utf8'); } catch { return ''; }
  const open = parseTasks(md).filter((t) => !t.done).slice(0, maxTasks);
  const lines = open.map((t) => `- [ ] ${t.id} ${t.text}`);
  const more = open.length === maxTasks ? '\n*…mais tarefas em tarefas.md*' : '';
  return `<active_change>
Mudança ativa: ${slug} — [[${chDir}/${slug}/proposta]]. Tarefas abertas:
${lines.join('\n')}${more}
</active_change>`;
}

export function activeChangeLink(vaultBase) {
  const slug = activeChange(vaultBase);
  return slug ? `Change ativa: [[${getLocale(vaultBase).folders.changes}/${slug}/proposta]]` : '';
}

// Append fix tasks for surviving mutants to a change's tarefas.md (Wave B). Deduped by
// file:line, numbered M.<n> continuing from any existing fix tasks. Returns count added.
export function appendFixTasks(changeDir, mutants, sensorId) {
  const path = join(changeDir, 'tarefas.md');
  // changeDir = <vault>/<changesDir>/<slug> — derive the vault for the locale verb.
  const verb = getLocale(dirname(dirname(changeDir))).fixTaskVerb;
  let md = '';
  try { md = readFileSync(path, 'utf8'); } catch { /* nova */ }
  // Dedup is bilingual so a vault that switched locale mid-change never duplicates.
  const existing = new Set([...md.matchAll(/(?:mata mutante|kill mutant) (\S+):(\d+)/g)].map((m) => `${m[1]}:${m[2]}`));
  const nums = [...md.matchAll(/^-\s+\[[ x]\]\s+M\.(\d+)\b/gm)].map((m) => Number(m[1]));
  let n = nums.length ? Math.max(...nums) : 0;
  const lines = [];
  for (const mut of mutants || []) {
    const key = `${mut.file}:${mut.line}`;
    if (existing.has(key)) continue;
    existing.add(key);
    n += 1;
    lines.push(`- [ ] M.${n} ${verb} ${mut.file}:${mut.line} (${mut.mutator}) [sensor:${sensorId}]`);
  }
  if (!lines.length) return 0;
  const sep = md === '' || md.endsWith('\n') ? '' : '\n';
  writeFileSync(path, `${md}${sep}${lines.join('\n')}\n`, 'utf8');
  return lines.length;
}

// Gate seam (Pilar B stub; Pilar C replaces with real sensor evidence).
export function gateGreen() {
  return { ok: true, failing: [] };
}

export function archiveChange(vaultBase, slug, { gate = gateGreen, dateStr, adrNum }) {
  const loc = getLocale(vaultBase);
  const chDir = loc.folders.changes;
  const src = join(vaultBase, chDir, slug);
  const verdict = gate(src);
  if (!verdict.ok) return { ok: false, failing: verdict.failing || [] };

  const destRel = join(chDir, ARCHIVE_DIR, `${dateStr}-${slug}`);
  const destAbs = join(vaultBase, destRel);
  const changeWikilink = wikilinkFromRel(join(destRel, 'proposta'));

  // Atomicity guard: fail BEFORE promoting specs if the destination already exists (e.g. a slug
  // reused after a same-day archive). Otherwise promoteSpecs would commit to 07-Specs and the
  // later renameSync would fail, leaving a half-archived state.
  if (existsSync(destAbs)) {
    return { ok: false, failing: [`destino de arquivo já existe: ${destRel} — renomeie o slug ou remova o arquivo antigo`] };
  }

  // Promote spec deltas into the living 07-Specs BEFORE moving (deltas live in src).
  let promoted = [];
  let specWarnings = [];
  try {
    const specs = parseSpecsList(readFileSync(join(src, 'proposta.md'), 'utf8'));
    if (specs.length) {
      const res = promoteSpecs(vaultBase, src, specs, { changeWikilink, dateStr });
      promoted = res.promoted;
      specWarnings = res.warnings;
    }
  } catch { /* proposta ilegível — segue só com ADR */ }

  let reqIds = [];
  try { reqIds = [...new Set(parseTasks(readFileSync(join(src, 'tarefas.md'), 'utf8')).map((t) => t.req).filter(Boolean))]; } catch { /* sem tarefas */ }

  ensureDir(join(vaultBase, chDir, ARCHIVE_DIR));
  try {
    renameSync(src, destAbs);
  } catch (error) {
    return { ok: false, failing: [`falha ao mover a mudança para ${destRel}: ${error.message} (07-Specs pode ter sido promovido — verifique)`] };
  }

  // Flip the archived proposta's frontmatter status so it no longer reads as active.
  try {
    const pp = join(destAbs, 'proposta.md');
    const c = readFileSync(pp, 'utf8').replace(/^status:\s*active\s*$/m, 'status: archived');
    writeFileSync(pp, c, 'utf8');
  } catch { /* proposta ilegível — segue */ }

  // ADR goes in the same dated month folder as session-derived decisions (04-Decisões/ano/MM-MMM/)
  // — not the year root — so all ADRs sit together in the vault's convention.
  const adrDirRel = monthFolderRelFromDateStr(loc.folders.decisions, dateStr, vaultBase);
  ensureDir(join(vaultBase, adrDirRel));
  const num = String(adrNum).padStart(3, '0');
  const adrRel = join(adrDirRel, `ADR-${num}-${slug}.md`);
  const capLine = promoted.length
    ? `\n\nCapabilities: ${promoted.map((c) => wikilinkFromRel(join(loc.folders.specs, c))).join(', ')}.`
    : '';
  const reqLine = reqIds.length ? `\n\nRequisitos: ${reqIds.join(', ')}.` : '';
  writeFileSync(join(vaultBase, adrRel), `---
type: decision
status: accepted
date: ${dateStr}
cssclasses:
  - topic-decision
tags:
  - decisao
---

# ADR-${num} — ${slug}

## Decisão

Mudança ${changeWikilink} concluída e arquivada.${capLine}${reqLine}
`, 'utf8');

  // Only clear the pointer when the archived change IS the active one — archiving some other
  // slug explicitly must not blank the pointer of a different, still-active change.
  if (activeChange(vaultBase) === slug) clearActiveChange(vaultBase);
  return { ok: true, failing: [], archivedRel: destRel, adrRel, promoted, specWarnings };
}
