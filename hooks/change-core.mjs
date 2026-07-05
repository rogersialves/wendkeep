// hooks/change-core.mjs
// Native change/spec lifecycle in the vault (Pilar B). Vault-facing lib consumed by
// the `wendkeep change` CLI (src/change.mjs) and the brain-inject hook. No external deps.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, wikilinkFromRel } from './obsidian-common.mjs';
import { parseSpecsList, promoteSpecs } from './spec-core.mjs';

export const CHANGES_DIR = '08-Mudanças';
export const SPECS_DIR = '07-Specs';
export const ARCHIVE_DIR = '_arquivo';
const POINTER = '.brain/CURRENT_CHANGE.md';

export function changeDirRel(slug) {
  return join(CHANGES_DIR, slug);
}

export function renderChangeScaffold({ slug, sessionRel, dateStr }) {
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

## Por quê

(motivo da mudança)

## O que muda

(escopo da mudança)
`;
  const design = `# ${slug} — design

## Abordagem

(abordagem técnica)
`;
  const tarefas = `# ${slug} — tarefas

- [ ] 1.1 (primeira tarefa)
`;
  const specDelta = `## ADDED Requirements
### Requisito: (nome)
(comportamento / cenários)

## MODIFIED Requirements

## REMOVED Requirements
`;
  return { proposta, design, tarefas, specDelta };
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

export function newChange(vaultBase, slug, { sessionRel = '', dateStr }) {
  const dir = join(vaultBase, CHANGES_DIR, slug);
  const existed = existsSync(join(dir, 'proposta.md'));
  mkdirSync(dir, { recursive: true });
  const files = renderChangeScaffold({ slug, sessionRel, dateStr });
  const write = (name, content) => {
    const f = join(dir, name);
    if (!existsSync(f)) writeFileSync(f, content, 'utf8');
  };
  write('proposta.md', files.proposta);
  write('design.md', files.design);
  write('tarefas.md', files.tarefas);
  // Seed an example spec delta so the promotion format is discoverable.
  const exampleDelta = join(dir, 'specs', 'exemplo', 'spec.md');
  if (!existsSync(exampleDelta)) {
    mkdirSync(join(dir, 'specs', 'exemplo'), { recursive: true });
    writeFileSync(exampleDelta, files.specDelta, 'utf8');
  }
  setActiveChange(vaultBase, slug);
  return { rel: changeDirRel(slug), created: !existed };
}

export function parseTasks(md) {
  const tasks = [];
  const re = /^-\s+\[( |x)\]\s+(\S+)\s+(.*)$/gm;
  const sensorRe = /\[sensor:\s*([\w.-]+)\]/;
  let m;
  while ((m = re.exec(String(md))) !== null) {
    let text = m[3].trim();
    const sm = text.match(sensorRe);
    const sensor = sm ? sm[1] : undefined;
    if (sm) text = text.replace(sensorRe, '').replace(/\s+/g, ' ').trim();
    tasks.push({ id: m[2], text, done: m[1] === 'x', ...(sensor ? { sensor } : {}) });
  }
  return tasks;
}

export function listChanges(vaultBase) {
  const base = join(vaultBase, CHANGES_DIR);
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
  let md = '';
  try { md = readFileSync(join(vaultBase, CHANGES_DIR, slug, 'tarefas.md'), 'utf8'); } catch { return ''; }
  const open = parseTasks(md).filter((t) => !t.done).slice(0, maxTasks);
  const lines = open.map((t) => `- [ ] ${t.id} ${t.text}`);
  const more = open.length === maxTasks ? '\n*…mais tarefas em tarefas.md*' : '';
  return `<active_change>
Mudança ativa: ${slug} — [[${CHANGES_DIR}/${slug}/proposta]]. Tarefas abertas:
${lines.join('\n')}${more}
</active_change>`;
}

export function activeChangeLink(vaultBase) {
  const slug = activeChange(vaultBase);
  return slug ? `Change ativa: [[${CHANGES_DIR}/${slug}/proposta]]` : '';
}

// Gate seam (Pilar B stub; Pilar C replaces with real sensor evidence).
export function gateGreen() {
  return { ok: true, failing: [] };
}

export function archiveChange(vaultBase, slug, { gate = gateGreen, dateStr, adrNum }) {
  const src = join(vaultBase, CHANGES_DIR, slug);
  const verdict = gate(src);
  if (!verdict.ok) return { ok: false, failing: verdict.failing || [] };

  const destRel = join(CHANGES_DIR, ARCHIVE_DIR, `${dateStr}-${slug}`);
  const changeWikilink = wikilinkFromRel(join(destRel, 'proposta'));

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

  ensureDir(join(vaultBase, CHANGES_DIR, ARCHIVE_DIR));
  renameSync(src, join(vaultBase, destRel));

  const [year] = String(dateStr).split('-');
  const adrDirRel = join('04-Decisões', year);
  ensureDir(join(vaultBase, adrDirRel));
  const num = String(adrNum).padStart(3, '0');
  const adrRel = join(adrDirRel, `ADR-${num}-${slug}.md`);
  const capLine = promoted.length
    ? `\n\nCapabilities: ${promoted.map((c) => wikilinkFromRel(join(SPECS_DIR, c))).join(', ')}.`
    : '';
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

Mudança ${changeWikilink} concluída e arquivada.${capLine}
`, 'utf8');

  clearActiveChange(vaultBase);
  return { ok: true, failing: [], archivedRel: destRel, adrRel, promoted, specWarnings };
}
