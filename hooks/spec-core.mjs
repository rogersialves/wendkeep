// hooks/spec-core.mjs — living spec (07-Specs) + change delta merge (OpenSpec native).
// Pure parsing/merge + promoteSpecs (fs). No import from change-core (avoids a cycle).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from './obsidian-common.mjs';
import { getLocale } from './locale.mjs';

// Short stable fingerprint of tarefas.md — freshness check between package/verdict and gate.
export function tasksHashOf(md) {
  return createHash('sha1').update(String(md)).digest('hex').slice(0, 12);
}

export function contentHashOf(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export const SPECS_STATE_FILE = '.brain/SPECS_STATE.json';
export const SPEC_BASELINE_FILE = '.spec-base.json';
export const MANAGED_SPEC_MARKER = '<!-- wendkeep:managed-spec — generated from 08-Mudanças; do not edit directly -->';

// Parse is BILINGUAL always (mixed vaults never break); rendering follows the vault locale.
const REQ_RE = /^### (?:Requisito|Requirement):\s*(.+)$/gm;

export function parseRequirements(md) {
  const text = String(md);
  const matches = [...text.matchAll(REQ_RE)];
  const reqs = [];
  for (let i = 0; i < matches.length; i += 1) {
    const raw = matches[i][1].trim();
    // Identity is the ID (e.g. GATE-1) when the heading is "<ID> — <nome>"; else the whole text.
    const idM = raw.match(/^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+)\s*—\s*(.+)$/);
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
  return `${MANAGED_SPEC_MARKER}\n---\ntype: spec\ncssclasses:\n  - topic-spec\ntags:\n  - spec\n---\n\n# ${capability}\n\n## Requisitos\n\n${blocks}${foot}`;
}

function readLivingSpecs(vaultBase) {
  const specsDir = join(vaultBase, getLocale(vaultBase).folders.specs);
  const specs = {};
  let files = [];
  try { files = readdirSync(specsDir).filter((f) => f.endsWith('.md') && f !== 'README.md'); } catch { return specs; }
  for (const file of files) {
    const capability = file.replace(/\.md$/, '');
    const md = readFileSync(join(specsDir, file), 'utf8');
    specs[capability] = {
      hash: contentHashOf(md),
      requirements: Object.fromEntries(parseRequirements(md).map((r) => [r.id || r.name, contentHashOf(JSON.stringify(r))])),
    };
  }
  return specs;
}

export function livingSpecCapabilities(vaultBase) {
  return Object.keys(readLivingSpecs(vaultBase));
}

export function adoptSpecsState(vaultBase) {
  const state = { version: 1, generatedAt: new Date().toISOString(), specs: readLivingSpecs(vaultBase) };
  ensureDir(join(vaultBase, '.brain'));
  writeFileSync(join(vaultBase, SPECS_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return state;
}

export function readSpecsState(vaultBase) {
  try { return JSON.parse(readFileSync(join(vaultBase, SPECS_STATE_FILE), 'utf8')); } catch { return null; }
}

export function checkSpecsState(vaultBase) {
  const recorded = readSpecsState(vaultBase);
  if (!recorded) return { ok: false, missing: true, changed: [] };
  const current = readLivingSpecs(vaultBase);
  const names = new Set([...Object.keys(recorded.specs || {}), ...Object.keys(current)]);
  const changed = [...names].filter((name) => recorded.specs?.[name]?.hash !== current[name]?.hash);
  return { ok: changed.length === 0, missing: false, changed, current, recorded };
}

function recordPromotedSpecs(vaultBase, capabilities) {
  const existing = readSpecsState(vaultBase);
  if (!existing) return adoptSpecsState(vaultBase);
  const current = readLivingSpecs(vaultBase);
  const specs = { ...(existing.specs || {}) };
  for (const capability of capabilities) {
    if (current[capability]) specs[capability] = current[capability];
    else delete specs[capability];
  }
  const state = { version: 1, generatedAt: new Date().toISOString(), specs };
  writeFileSync(join(vaultBase, SPECS_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return state;
}

export function captureSpecBaseline(vaultBase, changeDir, { refresh = false } = {}) {
  const path = join(changeDir, SPEC_BASELINE_FILE);
  if (!refresh && existsSync(path)) {
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch { /* rebuild malformed baseline */ }
  }
  const baseline = { version: 1, capturedAt: new Date().toISOString(), specs: readLivingSpecs(vaultBase) };
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  return baseline;
}

export function specConflicts(vaultBase, changeDir, capabilities = discoverSpecDeltas(changeDir)) {
  let baseline = null;
  try { baseline = JSON.parse(readFileSync(join(changeDir, SPEC_BASELINE_FILE), 'utf8')); } catch { /* legacy change */ }
  if (!baseline) return [];
  const current = readLivingSpecs(vaultBase);
  const conflicts = [];
  for (const capability of capabilities) {
    let delta;
    try { delta = parseDelta(readFileSync(join(changeDir, 'specs', capability, 'spec.md'), 'utf8')); } catch { continue; }
    const baseReqs = baseline.specs?.[capability]?.requirements || {};
    const currentReqs = current[capability]?.requirements || {};
    for (const req of delta.added || []) {
      const key = req.id || req.name;
      if (!(key in baseReqs) && key in currentReqs) conflicts.push(`${capability}:${key} foi adicionado por outra change`);
    }
    for (const req of delta.modified || []) {
      const key = req.id || req.name;
      if (baseReqs[key] !== currentReqs[key]) conflicts.push(`${capability}:${key} mudou desde a abertura da change`);
    }
    for (const key of delta.removed || []) {
      if (baseReqs[key] !== currentReqs[key]) conflicts.push(`${capability}:${key} mudou desde a abertura da change`);
    }
  }
  return conflicts;
}

export function resolveEffectiveSpecs(vaultBase, changeDir, capabilities = discoverSpecDeltas(changeDir)) {
  const specsDir = join(vaultBase, getLocale(vaultBase).folders.specs);
  const result = [];
  const warnings = [];
  const errors = [];
  for (const capability of capabilities) {
    let living = [];
    try { living = parseRequirements(readFileSync(join(specsDir, `${capability}.md`), 'utf8')); } catch { /* new capability */ }
    let deltaMd = '';
    try { deltaMd = readFileSync(join(changeDir, 'specs', capability, 'spec.md'), 'utf8'); } catch { /* unchanged living capability */ }
    if (deltaMd && isPlaceholderDelta(deltaMd)) deltaMd = '';
    const delta = deltaMd ? parseDelta(deltaMd) : { added: [], modified: [], removed: [] };
    const operations = new Map(living.map((r) => [r.id || r.name, { operation: 'BASE', source: 'living' }]));
    for (const r of delta.added) operations.set(r.id || r.name, { operation: 'ADDED', source: 'change' });
    for (const r of delta.modified) operations.set(r.id || r.name, { operation: 'MODIFIED', source: 'change' });
    for (const key of delta.removed) operations.delete(key);
    const applied = applyDelta(living, delta);
    warnings.push(...applied.warnings.map((w) => `${capability}: ${w}`));
    for (const warning of applied.warnings) {
      if (/^(ADDED já existe|MODIFIED inexistente|REMOVED inexistente)/.test(warning)) errors.push(`${capability}: ${warning}`);
    }
    result.push({
      capability,
      requirements: applied.reqs.map((r) => ({ ...r, capability, ...(operations.get(r.id || r.name) || { operation: 'BASE', source: 'living' }) })),
    });
  }
  const serializable = result.map((s) => ({ capability: s.capability, requirements: s.requirements }));
  return { specs: result, requirements: result.flatMap((s) => s.requirements), warnings, errors, hash: contentHashOf(JSON.stringify(serializable)) };
}

export function buildEffectiveRequirementPackage(vaultBase, changeDir, reqIds = []) {
  let listed = [];
  try { listed = parseSpecsList(readFileSync(join(changeDir, 'proposta.md'), 'utf8')); } catch { /* caller validates change */ }
  const changed = [...new Set([...listed, ...discoverSpecDeltas(changeDir)])];
  const capabilities = [...new Set([...livingSpecCapabilities(vaultBase), ...changed])];
  const effective = resolveEffectiveSpecs(vaultBase, changeDir, capabilities);
  const byId = new Map(effective.requirements.filter((r) => r.id).map((r) => [r.id, r]));
  const missing = reqIds.filter((id) => !byId.has(id));
  const requirements = reqIds.map((id) => byId.get(id)).filter(Boolean);
  const relevantCaps = new Set([...changed, ...requirements.map((r) => r.capability)]);
  const relevant = effective.specs.filter((spec) => relevantCaps.has(spec.capability));
  return {
    ...effective,
    specs: relevant,
    requirements,
    missing,
    changedCapabilities: changed,
    hash: contentHashOf(JSON.stringify(relevant)),
  };
}

export function parseSpecsList(propostaMd) {
  const text = String(propostaMd);
  const inline = text.match(/^specs:\s*\[(.*?)\]\s*$/m);
  if (inline) return inline[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  const block = text.match(/^specs:\s*\n((?:[ \t]+-[ \t]*.+\n?)+)/m);
  if (block) return block[1].split('\n').map((l) => l.replace(/^[ \t]*-[ \t]*/, '').trim().replace(/['"]/g, '')).filter(Boolean);
  return [];
}

function yamlScalar(text, key) {
  const m = String(text).match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
}

export function parseSpecImpact(propostaMd) {
  const text = String(propostaMd || '');
  const status = yamlScalar(text, 'spec_impact') || yamlScalar(text, 'spec-impact');
  const reason = yamlScalar(text, 'spec_impact_reason') || yamlScalar(text, 'spec-impact-reason');
  return { status, reason };
}

export function validateSpecImpact(changeDir) {
  let proposta = '';
  try { proposta = readFileSync(join(changeDir, 'proposta.md'), 'utf8'); }
  catch { return { ok: false, errors: ['proposta.md ausente'], warnings: [], status: '', listed: [], onDisk: [] }; }

  const { status, reason } = parseSpecImpact(proposta);
  const listed = parseSpecsList(proposta);
  const onDisk = discoverSpecDeltas(changeDir);
  const enforced = existsSync(join(changeDir, '.spec-impact-v1'));
  const errors = [];
  const warnings = [];

  if (!status) {
    if (enforced) errors.push('spec_impact ausente — classifique como required ou none');
    else warnings.push('change legada sem spec_impact — migre para required ou none antes do próximo ciclo');
    return { ok: errors.length === 0, errors, warnings, status: '', listed, onDisk, legacy: !enforced };
  }
  if (!['pending', 'required', 'none'].includes(status)) errors.push(`spec_impact inválido: ${status}`);
  if (status === 'pending') errors.push('spec_impact pending — classifique o impacto antes de arquivar');
  if (status === 'none') {
    if (!reason) errors.push('spec_impact none exige justificativa em spec_impact_reason');
    if (listed.length || onDisk.length) errors.push('spec_impact none contradiz specs/deltas declarados');
  }
  if (status === 'required') {
    if (!listed.length) errors.push('spec_impact required exige ao menos uma capability em specs');
    for (const cap of listed) if (!onDisk.includes(cap)) errors.push(`delta real ausente para capability ${cap}`);
    for (const cap of onDisk) if (!listed.includes(cap)) errors.push(`delta ${cap} existe no disco mas não está listado em specs`);
  }
  return { ok: errors.length === 0, errors, warnings, status, reason, listed, onDisk, legacy: false };
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
  const state = checkSpecsState(vaultBase);
  const unmanaged = state.missing ? [] : state.changed.filter((capability) => specs.includes(capability));
  if (unmanaged.length) {
    throw new Error(`07-Specs alterado fora do WendKeep: ${unmanaged.join(', ')} — mova o delta para 08-Mudanças/<change>/specs`);
  }
  const conflicts = specConflicts(vaultBase, changeDir, specs);
  if (conflicts.length) throw new Error(`conflito de spec: ${conflicts.join('; ')} — reconcilie o delta e rode \`wendkeep spec rebase --change <slug> --accept-current\``);
  for (const cap of specs) {
    let deltaMd;
    try { deltaMd = readFileSync(join(changeDir, 'specs', cap, 'spec.md'), 'utf8'); }
    catch { throw new Error(`delta ausente para ${cap}`); }
    if (isPlaceholderDelta(deltaMd)) throw new Error(`delta placeholder para ${cap}`);
    const delta = parseDelta(deltaMd);
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
  recordPromotedSpecs(vaultBase, promoted);
  return { promoted, warnings };
}

// Gate check for the independent verdict (Wave A). A requirement-bearing change must have
// a verdict that is ok and covers every declared req id. A requirement-less change passes:
// nothing for an independent verifier to check — the sensor gate is already the proof.
export function evaluateVerdict(verdict, reqIds, { tasksHash, effectiveSpecHash } = {}) {
  const ids = reqIds || [];
  if (ids.length === 0) return { ok: true, missing: [] };
  if (!verdict || verdict.ok !== true) return { ok: false, missing: [] };
  // Freshness (G3/#6): a verdict minted against a different tarefas.md is stale. Verdicts
  // without a hash (pre-0.6.1) are accepted for backward compat.
  if (tasksHash && verdict.tasksHash && verdict.tasksHash !== tasksHash) {
    return { ok: false, missing: [], stale: true };
  }
  if (effectiveSpecHash && verdict.effectiveSpecHash && verdict.effectiveSpecHash !== effectiveSpecHash) {
    return { ok: false, missing: [], stale: true };
  }
  const covered = new Set((verdict.coverage || []).filter((c) => c.covered).map((c) => c.req));
  const missing = ids.filter((r) => !covered.has(r));
  return { ok: missing.length === 0, missing };
}
