// hooks/spec-core.mjs — living spec (07-Specs) + change delta merge (OpenSpec native).
// Pure parsing/merge + promoteSpecs (fs). No import from change-core (avoids a cycle).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from './obsidian-common.mjs';

const SPECS_DIR = '07-Specs';
const REQ_RE = /^### Requisito:\s*(.+)$/gm;

export function parseRequirements(md) {
  const text = String(md);
  const matches = [...text.matchAll(REQ_RE)];
  const reqs = [];
  for (let i = 0; i < matches.length; i += 1) {
    const name = matches[i][1].trim();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const body = text.slice(start, end).replace(/(\n>[^\n]*)+\s*$/, '').trim();
    reqs.push({ name, body });
  }
  return reqs;
}

export function parseDelta(md) {
  const text = String(md);
  const grab = (label) => {
    const m = text.match(new RegExp(`^##\\s+${label} Requirements\\s*$`, 'm'));
    if (!m) return '';
    const rest = text.slice(m.index + m[0].length);
    const next = rest.search(/^##\s+\w+ Requirements\s*$/m);
    return next === -1 ? rest : rest.slice(0, next);
  };
  return {
    added: parseRequirements(grab('ADDED')),
    modified: parseRequirements(grab('MODIFIED')),
    removed: parseRequirements(grab('REMOVED')).map((r) => r.name),
  };
}

export function applyDelta(reqs, delta) {
  const order = reqs.map((r) => r.name);
  const map = new Map(reqs.map((r) => [r.name, r.body]));
  const warnings = [];
  for (const r of delta.added || []) {
    if (map.has(r.name)) warnings.push(`ADDED já existe: ${r.name}`); else order.push(r.name);
    map.set(r.name, r.body);
  }
  for (const r of delta.modified || []) {
    if (!map.has(r.name)) { warnings.push(`MODIFIED inexistente: ${r.name}`); order.push(r.name); }
    map.set(r.name, r.body);
  }
  for (const name of delta.removed || []) {
    if (!map.has(name)) warnings.push(`REMOVED inexistente: ${name}`);
    map.delete(name);
  }
  const seen = new Set();
  const out = order
    .filter((n) => map.has(n) && !seen.has(n) && seen.add(n))
    .map((n) => ({ name: n, body: map.get(n) }));
  return { reqs: out, warnings };
}

export function renderSpec(capability, reqs, { footer } = {}) {
  const blocks = reqs.map((r) => `### Requisito: ${r.name}\n${r.body}`).join('\n\n');
  const foot = footer ? `\n\n> ${footer}\n` : '\n';
  return `---\ntype: spec\ncssclasses:\n  - topic-spec\ntags:\n  - spec\n---\n\n# ${capability}\n\n## Requisitos\n\n${blocks}${foot}`;
}

export function parseSpecsList(propostaMd) {
  const text = String(propostaMd);
  const inline = text.match(/^specs:\s*\[(.*?)\]\s*$/m);
  if (inline) return inline[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  const block = text.match(/^specs:\s*\n((?:[ \t]+-[ \t]*.+\n?)+)/m);
  if (block) return block[1].split('\n').map((l) => l.replace(/^[ \t]*-[ \t]*/, '').trim().replace(/['"]/g, '')).filter(Boolean);
  return [];
}

// Merge each capability's delta (in the change) into the living spec in 07-Specs.
export function promoteSpecs(vaultBase, changeDir, specs, { changeWikilink, dateStr } = {}) {
  const promoted = [];
  const warnings = [];
  for (const cap of specs) {
    let delta;
    try { delta = parseDelta(readFileSync(join(changeDir, 'specs', cap, 'spec.md'), 'utf8')); }
    catch { warnings.push(`sem delta para ${cap}`); continue; }
    const livePath = join(vaultBase, SPECS_DIR, `${cap}.md`);
    let current = [];
    try { current = parseRequirements(readFileSync(livePath, 'utf8')); } catch { /* nova capability */ }
    const applied = applyDelta(current, delta);
    warnings.push(...applied.warnings.map((w) => `${cap}: ${w}`));
    ensureDir(join(vaultBase, SPECS_DIR));
    const footer = changeWikilink ? `Atualizado por ${changeWikilink} em ${dateStr}.` : '';
    writeFileSync(livePath, renderSpec(cap, applied.reqs, { footer }), 'utf8');
    promoted.push(cap);
  }
  return { promoted, warnings };
}
