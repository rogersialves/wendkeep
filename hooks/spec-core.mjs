// hooks/spec-core.mjs — living spec (07-Specs) + change delta merge (OpenSpec native).
// Pure parsing/merge + promoteSpecs (fs). No import from change-core (avoids a cycle).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from './obsidian-common.mjs';
import { getLocale } from './locale.mjs';

// Short stable fingerprint of tarefas.md — freshness check between package/verdict and gate.
export function tasksHashOf(md) {
  return createHash('sha1').update(String(md)).digest('hex').slice(0, 12);
}

// Parse is BILINGUAL always (mixed vaults never break); rendering follows the vault locale.
const REQ_RE = /^### (?:Requisito|Requirement):\s*(.+)$/gm;

export function parseRequirements(md) {
  const text = String(md);
  const matches = [...text.matchAll(REQ_RE)];
  const reqs = [];
  for (let i = 0; i < matches.length; i += 1) {
    const raw = matches[i][1].trim();
    // Identity is the ID (e.g. GATE-1) when the heading is "<ID> — <nome>"; else the whole text.
    const idM = raw.match(/^([A-Z][A-Z0-9]*-\d+)\s*—\s*(.+)$/);
    const id = idM ? idM[1] : null;
    const name = idM ? idM[2].trim() : raw;
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const body = text.slice(start, end).replace(/(\n>[^\n]*)+\s*$/, '').trim();
    reqs.push({ id, name, body });
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
    removed: parseRequirements(grab('REMOVED')).map((r) => r.id || r.name),
  };
}

export function applyDelta(reqs, delta) {
  const keyOf = (r) => r.id || r.name; // identity = ID when present, else the name
  const order = reqs.map(keyOf);
  const map = new Map(reqs.map((r) => [keyOf(r), r])); // key -> full {id,name,body}
  const warnings = [];
  for (const r of delta.added || []) {
    const k = keyOf(r);
    if (map.has(k)) warnings.push(`ADDED já existe: ${k}`); else order.push(k);
    map.set(k, r);
  }
  for (const r of delta.modified || []) {
    const k = keyOf(r);
    if (!map.has(k)) { warnings.push(`MODIFIED inexistente: ${k}`); order.push(k); }
    map.set(k, r);
  }
  for (const k of delta.removed || []) {
    if (!map.has(k)) warnings.push(`REMOVED inexistente: ${k}`);
    map.delete(k);
  }
  const seen = new Set();
  const out = order.filter((k) => map.has(k) && !seen.has(k) && seen.add(k)).map((k) => map.get(k));
  return { reqs: out, warnings };
}

export function renderSpec(capability, reqs, { footer, reqHeading = 'Requisito' } = {}) {
  const blocks = reqs.map((r) => `### ${reqHeading}: ${r.id ? `${r.id} — ${r.name}` : r.name}\n${r.body}`).join('\n\n');
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

// Um delta ainda no estado do scaffold (só o requisito "(nome)"/"(name)", nada removido) não é
// contrato — a promoção o filtra. Um delta com REMOVED é sempre intenção real.
export function isPlaceholderDelta(md) {
  const d = parseDelta(md);
  if (d.removed.length) return false;
  const all = [...d.added, ...d.modified];
  if (!all.length) return true;
  return all.every((r) => /^\((?:nome|name)\)$/.test(r.name));
}

// Capabilities com delta REAL no disco (<change>/specs/<cap>/spec.md), independente do
// frontmatter `specs:` da proposta — o scaffold deixa `specs: []` e o buraco engolia deltas
// preenchidos mas não listados (visto em produção: 07-Specs vazio com delta real no disco).
export function discoverSpecDeltas(changeDir) {
  let names = [];
  try { names = readdirSync(join(changeDir, 'specs')); } catch { return []; }
  const caps = [];
  for (const cap of names) {
    try { if (!isPlaceholderDelta(readFileSync(join(changeDir, 'specs', cap, 'spec.md'), 'utf8'))) caps.push(cap); }
    catch { /* sem spec.md */ }
  }
  return caps;
}

// Merge each capability's delta (in the change) into the living spec in 07-Specs.
export function promoteSpecs(vaultBase, changeDir, specs, { changeWikilink, dateStr } = {}) {
  const loc = getLocale(vaultBase);
  const specsDir = loc.folders.specs;
  const promoted = [];
  const warnings = [];
  for (const cap of specs) {
    let delta;
    try { delta = parseDelta(readFileSync(join(changeDir, 'specs', cap, 'spec.md'), 'utf8')); }
    catch { warnings.push(`sem delta para ${cap}`); continue; }
    const livePath = join(vaultBase, specsDir, `${cap}.md`);
    let current = [];
    try { current = parseRequirements(readFileSync(livePath, 'utf8')); } catch { /* nova capability */ }
    const applied = applyDelta(current, delta);
    warnings.push(...applied.warnings.map((w) => `${cap}: ${w}`));
    ensureDir(join(vaultBase, specsDir));
    const footer = changeWikilink ? `Atualizado por ${changeWikilink} em ${dateStr}.` : '';
    writeFileSync(livePath, renderSpec(cap, applied.reqs, { footer, reqHeading: loc.reqHeading }), 'utf8');
    promoted.push(cap);
  }
  return { promoted, warnings };
}

// Gate check for the independent verdict (Wave A). A requirement-bearing change must have
// a verdict that is ok and covers every declared req id. A requirement-less change passes:
// nothing for an independent verifier to check — the sensor gate is already the proof.
export function evaluateVerdict(verdict, reqIds, { tasksHash } = {}) {
  const ids = reqIds || [];
  if (ids.length === 0) return { ok: true, missing: [] };
  if (!verdict || verdict.ok !== true) return { ok: false, missing: [] };
  // Freshness (G3/#6): a verdict minted against a different tarefas.md is stale. Verdicts
  // without a hash (pre-0.6.1) are accepted for backward compat.
  if (tasksHash && verdict.tasksHash && verdict.tasksHash !== tasksHash) {
    return { ok: false, missing: [], stale: true };
  }
  const covered = new Set((verdict.coverage || []).filter((c) => c.covered).map((c) => c.req));
  const missing = ids.filter((r) => !covered.has(r));
  return { ok: missing.length === 0, missing };
}
