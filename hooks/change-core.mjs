// hooks/change-core.mjs
// Native change/spec lifecycle in the vault (Pilar B). Vault-facing lib consumed by
// the `wendkeep change` CLI (src/change.mjs) and the brain-inject hook. No external deps.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureDir, wikilinkFromRel, monthFolderRelFromDateStr } from './obsidian-common.mjs';
import { parseSpecsList, promoteSpecs, discoverSpecDeltas, tasksHashOf, captureSpecBaseline, REQ_ID_RE_SRC } from './spec-core.mjs';
import { getLocale } from './locale.mjs';

export const ARCHIVE_DIR = '_arquivo';
const POINTER = '.brain/CURRENT_CHANGE.md';

export function changeDirRel(slug, vaultBase) {
  return join(getLocale(vaultBase).folders.changes, slug);
}

export function renderChangeScaffold({ slug, sessionRel, dateStr, locale = 'pt-BR', simple = false }) {
  const en = locale === 'en';
  const source = sessionRel ? `\n  - "${wikilinkFromRel(sessionRel)}"` : ' []';
  const impact = simple ? 'none' : 'pending';
  const impactReason = simple
    ? (en ? 'Simple change with no product-contract impact.' : 'Mudança simples sem impacto no contrato do produto.')
    : '';
  const proposta = `---
type: change
status: active
date: ${dateStr}
cssclasses:
  - topic-change
tags:
  - mudanca
source:${source}
spec_impact: ${impact}
spec_impact_reason: ${JSON.stringify(impactReason)}
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
  const files = renderChangeScaffold({ slug, sessionRel, dateStr, locale: loc.id, simple });
  const write = (name, content) => {
    const f = join(dir, name);
    if (!existsSync(f)) writeFileSync(f, content, 'utf8');
  };
  write('proposta.md', files.proposta);
  write('tarefas.md', files.tarefas);
  if (!existed) write('.spec-impact-v1', '1\n');
  // Auto-sizing (Wave B): a --simple change skips the design scaffold.
  // No `specs/exemplo` placeholder: it was pure noise (always hand-deleted). When a change
  // resolves `spec_impact: required`, the author writes `specs/<capability>/spec.md` directly
  // — the delta format lives in the wk-workflow skill (and `renderChangeScaffold().specDelta`).
  if (!simple) {
    write('design.md', files.design);
  }
  if (!existed) captureSpecBaseline(vaultBase, dir);
  setActiveChange(vaultBase, slug);
  return { rel: changeDirRel(slug, vaultBase), created: !existed };
}

export function useChange(vaultBase, slug) {
  const dir = join(vaultBase, getLocale(vaultBase).folders.changes, slug);
  if (!existsSync(join(dir, 'proposta.md'))) return { ok: false, error: `change aberta não encontrada: ${slug}` };
  setActiveChange(vaultBase, slug);
  return { ok: true, rel: changeDirRel(slug, vaultBase) };
}

export function continueChange(vaultBase, archivedSlug, newSlug, options = {}) {
  const loc = getLocale(vaultBase);
  const archiveDir = join(vaultBase, loc.folders.changes, ARCHIVE_DIR);
  let names = [];
  try { names = readdirSync(archiveDir).filter((name) => statSync(join(archiveDir, name)).isDirectory()); } catch { /* no archive */ }
  const matches = names.filter((name) => name === archivedSlug || name.endsWith(`-${archivedSlug}`));
  if (!matches.length) return { ok: false, error: `change arquivada não encontrada: ${archivedSlug}` };
  if (matches.length > 1) return { ok: false, error: `change arquivada ambígua: ${archivedSlug} (${matches.join(', ')})` };
  if (existsSync(join(vaultBase, loc.folders.changes, newSlug, 'proposta.md'))) {
    return { ok: false, error: `change de continuação já existe: ${newSlug}` };
  }
  const archivedName = matches[0];
  const archivedProposal = join(loc.folders.changes, ARCHIVE_DIR, archivedName, 'proposta');
  const result = newChange(vaultBase, newSlug, options);
  const proposalPath = join(vaultBase, loc.folders.changes, newSlug, 'proposta.md');
  let proposal = readFileSync(proposalPath, 'utf8');
  proposal = proposal.replace(/^specs:/m, `continues: "${wikilinkFromRel(archivedProposal)}"\nspecs:`);
  const heading = loc.id === 'en' ? '## Continuation' : '## Continuação';
  const note = loc.id === 'en'
    ? `Continues ${wikilinkFromRel(archivedProposal)}. Archived evidence and verdict are not inherited.`
    : `Continua ${wikilinkFromRel(archivedProposal)}. Evidências e verdict da change arquivada não são herdados.`;
  proposal = `${proposal.trimEnd()}\n\n${heading}\n\n${note}\n`;
  writeFileSync(proposalPath, proposal, 'utf8');
  return { ok: true, ...result, archived: archivedName };
}

export function parseTasks(md) {
  const tasks = [];
  const re = /^-\s+\[( |x)\]\s+(\S+)\s+(.*)$/gm;
  const sensorRe = /\[sensor:\s*([\w.-]+)\]/;
  const reqReG = new RegExp(`\\[req:\\s*(${REQ_ID_RE_SRC})\\]`, 'g');
  let m;
  while ((m = re.exec(String(md))) !== null) {
    let text = m[3].trim();
    const sm = text.match(sensorRe);
    const reqs = [...text.matchAll(reqReG)].map((r) => r[1]);
    const sensor = sm ? sm[1] : undefined;
    if (sm) text = text.replace(sensorRe, '');
    if (reqs.length) text = text.replace(reqReG, '');
    text = text.replace(/\s+/g, ' ').trim();
    // `req` stays as alias of the first id — older consumers keep working.
    tasks.push({ id: m[2], text, done: m[1] === 'x', ...(sensor ? { sensor } : {}), ...(reqs.length ? { req: reqs[0], reqs } : {}) });
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
  return { active: active.sort(), archived: archived.sort() };
}

// Visão derivada de TODAS as changes abertas. CURRENT_CHANGE continua sendo o único foco para
// comandos implícitos; provider/session nunca filtram a fila, para que outro agente possa assumir
// o trabalho. O hash leva o conteúdo inteiro de cada tarefas.md — não apenas as contagens — pois
// ele controla a reinjeção por sessão dos hooks.
export function allChangesState(vaultBase) {
  const current = activeChange(vaultBase);
  const { active } = listChanges(vaultBase);
  const chDir = getLocale(vaultBase).folders.changes;
  const fingerprint = [`current:${current}`];
  const changes = active.map((slug) => {
    let md = '';
    let warning = '';
    try { md = readFileSync(join(vaultBase, chDir, slug, 'tarefas.md'), 'utf8'); }
    catch { warning = 'tarefas.md ausente ou ilegível'; }
    const tasks = parseTasks(md);
    const openTasks = tasks.filter((t) => !t.done);
    fingerprint.push(`slug:${slug}`, `tasks:${md}`, `warning:${warning}`);
    return {
      slug,
      current: slug === current,
      openTasks,
      openCount: openTasks.length,
      doneCount: tasks.length - openTasks.length,
      warning,
    };
  });
  changes.sort((a, b) => Number(b.current) - Number(a.current) || a.slug.localeCompare(b.slug));
  const pointerWarning = current && !changes.some((change) => change.current)
    ? `CURRENT_CHANGE aponta para change inexistente: ${current}`
    : '';
  if (pointerWarning) fingerprint.push(`pointer-warning:${pointerWarning}`);
  return { current, changes, pointerWarning, hash: tasksHashOf(fingerprint.join('\n')) };
}

export function renderOpenChanges(state, { tag = 'open_changes' } = {}) {
  if (!state?.changes?.length && !state?.pointerWarning) return '';
  const lines = [];
  if (tag) lines.push(`<${tag}>`);
  if (state.current) lines.push(`Change atual (comandos sem --change): ${state.current}.`);
  else lines.push('Nenhuma change atual selecionada; comandos sem --change continuam recusados.');
  if (state.pointerWarning) lines.push(`Aviso: ${state.pointerWarning}.`);
  for (const change of state.changes || []) {
    const label = change.current ? 'ATUAL' : 'ABERTA';
    lines.push(`### ${label} — ${change.slug} (${change.openCount} aberta(s), ${change.doneCount} concluída(s))`);
    if (change.warning) lines.push(`- Aviso: ${change.warning}.`);
    else if (!change.openTasks.length) lines.push('- Nenhuma tarefa aberta.');
    else for (const task of change.openTasks) lines.push(`- [ ] ${task.id} ${task.text}`);
  }
  if (state.current) lines.push('Para change atual: `wendkeep change done <id>`; antes de archive: `wendkeep verify`.');
  lines.push('Qualquer agente pode assumir uma change: selecione-a com `wendkeep change use <slug>` ou use `--change <slug>` quando disponível.');
  if (tag) lines.push(`</${tag}>`);
  return lines.join('\n');
}

// Mantém o nome exportado para consumidores internos existentes, mas agora injeta o backlog
// completo em vez de ocultar changes não selecionadas.
export function buildActiveChangeInjection(vaultBase) {
  return renderOpenChanges(allChangesState(vaultBase));
}

export function activeChangeLink(vaultBase) {
  const slug = activeChange(vaultBase);
  return slug ? `Change ativa: [[${getLocale(vaultBase).folders.changes}/${slug}/proposta]]` : '';
}

// --- Estado rápido do gate + sentinelas por sessão (0.31.0) --------------------
// Fonte única e barata (só leituras, tudo fail-open) do estado do gate, consumida pelos hooks
// de lifecycle (change-guard/change-nag/change-context) e pelo CLI. null sem change ativa.
export function quickGateState(vaultBase) {
  const slug = activeChange(vaultBase);
  if (!slug) return null;
  const dir = join(vaultBase, getLocale(vaultBase).folders.changes, slug);
  let tarefasMd = '';
  try { tarefasMd = readFileSync(join(dir, 'tarefas.md'), 'utf8'); } catch { /* sem tarefas */ }
  const openTasks = parseTasks(tarefasMd).filter((t) => !t.done).length;
  let redCritical = false;
  try {
    const ev = JSON.parse(readFileSync(join(dir, 'evidencia.json'), 'utf8'));
    redCritical = (Array.isArray(ev) ? ev : []).some((e) => e.status !== 'green' && (e.severity || 'critical') !== 'warning');
  } catch { /* sem/ilegível = não conta contra o nudge */ }
  let evidenceStale = false;
  try {
    const h = readFileSync(join(dir, '.evidence-hash'), 'utf8').trim();
    evidenceStale = Boolean(h) && h !== tasksHashOf(tarefasMd);
  } catch { /* nunca selada */ }
  return { slug, openTasks, redCritical, evidenceStale, placeholders: scaffoldPlaceholders(dir).length };
}

// Sentinelas por sessão em .brain/ — memória "já avisei/injetei nesta sessão" dos hooks de
// lifecycle. kind: 'ctx' | 'warn' | 'nag' | 'gate'. session_id sanitizado para nome de arquivo.
const sanitizeSid = (sid) => String(sid || 'nosession').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);

export function sentinelPath(vaultBase, kind, sid) {
  return join(vaultBase, '.brain', `.change-${kind}-${sanitizeSid(sid)}`);
}

export function readSentinel(vaultBase, kind, sid) {
  try { return readFileSync(sentinelPath(vaultBase, kind, sid), 'utf8').trim(); } catch { return ''; }
}

export function writeSentinel(vaultBase, kind, sid, value = '1') {
  try {
    mkdirSync(join(vaultBase, '.brain'), { recursive: true });
    writeFileSync(sentinelPath(vaultBase, kind, sid), value, 'utf8');
  } catch { /* fail-open: pior caso = aviso repetido */ }
}

// Estado global usado pelo change-context: hash cobre qualquer tarefa aberta, inclusive de uma
// change que não esteja no ponteiro. As propriedades slug/openTasks preservam compatibilidade com
// consumidores antigos e descrevem somente a atual.
export function changeCtxState(vaultBase) {
  const state = allChangesState(vaultBase);
  if (!state.changes.length && !state.pointerWarning) return null;
  const selected = state.changes.find((change) => change.current);
  return {
    ...state,
    slug: state.current,
    openTasks: selected?.openTasks || [],
  };
}

// GC das sentinelas (>7 dias) — seleção pura separada da execução (testável sem depender de
// unlink funcionar no sandbox). Roda no finalize do session-stop, fail-quiet.
const SENTINEL_RE = /^\.change-(?:ctx|warn|nag|gate)-/;

export function staleSentinelNames(entries, now = Date.now(), maxAgeMs = 7 * 86400000) {
  return (entries || []).filter((e) => SENTINEL_RE.test(e.name) && now - e.mtimeMs > maxAgeMs).map((e) => e.name);
}

export function pruneChangeSentinels(vaultBase, { now = Date.now() } = {}) {
  const dir = join(vaultBase, '.brain');
  let entries = [];
  try {
    entries = readdirSync(dir)
      .map((name) => { try { return { name, mtimeMs: statSync(join(dir, name)).mtimeMs }; } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
  const stale = staleSentinelNames(entries, now);
  for (const name of stale) { try { unlinkSync(join(dir, name)); } catch { /* fail-quiet */ } }
  return stale;
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

export function archiveChange(vaultBase, slug, { gate = gateGreen, dateStr, adrNum, adrFlags = {} }) {
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
  // UNIÃO frontmatter + disco (0.31.0): o scaffold deixa `specs: []`, então um delta real
  // preenchido em specs/<cap>/ mas não listado era silenciosamente ignorado. Deltas ainda em
  // placeholder (o `exemplo` do scaffold) são filtrados por discoverSpecDeltas.
  let promoted = [];
  let specWarnings = [];
  try {
    let listed = [];
    try { listed = parseSpecsList(readFileSync(join(src, 'proposta.md'), 'utf8')); } catch { /* proposta ilegível */ }
    const onDisk = discoverSpecDeltas(src);
    const union = [...new Set([...listed, ...onDisk])];
    if (union.length) {
      const res = promoteSpecs(vaultBase, src, union, { changeWikilink, dateStr });
      promoted = res.promoted;
      specWarnings = [
        ...onDisk.filter((c) => !listed.includes(c)).map((c) => `spec no disco não listada no frontmatter da proposta: ${c} — promovida assim mesmo`),
        ...res.warnings,
      ];
    }
  } catch (error) {
    return { ok: false, failing: [`falha ao promover specs: ${error.message}`] };
  }

  let reqIds = [];
  try { reqIds = [...new Set(parseTasks(readFileSync(join(src, 'tarefas.md'), 'utf8')).flatMap((t) => t.reqs ?? []))]; } catch { /* sem tarefas */ }

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

  // O move quebrava TODO wikilink gravado antes (sessões fechadas, decisões, outras changes —
  // links cinza no grafo, visto em produção). Reescreve vault-wide; fail-quiet.
  let linksRewritten = 0;
  try { linksRewritten = rewriteChangeLinks(vaultBase, `${chDir}/${slug}`, destRel.replaceAll('\\', '/')); } catch { /* archive já íntegro */ }

  // ADR goes in the same dated month folder as session-derived decisions (04-Decisões/ano/MM-MMM/)
  // — not the year root — so all ADRs sit together in the vault's convention.
  const adrDirRel = monthFolderRelFromDateStr(loc.folders.decisions, dateStr, vaultBase);
  ensureDir(join(vaultBase, adrDirRel));
  const num = String(adrNum).padStart(4, '0');
  const adrRel = join(adrDirRel, `ADR-${num}-${slug}.md`);
  const capLine = promoted.length
    ? `\n\nCapabilities: ${promoted.map((c) => wikilinkFromRel(join(loc.folders.specs, c))).join(', ')}.`
    : '';
  const reqLine = reqIds.length ? `\n\nRequisitos: ${reqIds.join(', ')}.` : '';
  // Rastro auditável (0.31.0): um archive forçado ou sem prova declarada fica marcado no ADR.
  const flagLines = `${adrFlags.forced ? '\nforced: true' : ''}${adrFlags.trivial ? '\ntrivial: true' : ''}`;
  const forcedNote = adrFlags.forced ? '\n\n> ⚠️ Arquivada com --force — havia tarefa(s) aberta(s) pulada(s) no gate.' : '';
  writeFileSync(join(vaultBase, adrRel), `---
type: decision
status: accepted
date: ${dateStr}${flagLines}
cssclasses:
  - topic-decision
tags:
  - decisao
---

# ADR-${num} — ${slug}

## Decisão

Mudança ${changeWikilink} concluída e arquivada.${capLine}${reqLine}${forcedNote}
`, 'utf8');

  // Only clear the pointer when the archived change IS the active one — archiving some other
  // slug explicitly must not blank the pointer of a different, still-active change.
  if (activeChange(vaultBase) === slug) clearActiveChange(vaultBase);
  return { ok: true, failing: [], archivedRel: destRel, adrRel, promoted, specWarnings, linksRewritten };
}

// --- reescrita de wikilinks pós-move (0.35.0) ----------------------------------
// Todo .md do vault (inclui .brain e _arquivo — uma change arquivada pode linkar outra).
function allVaultMarkdown(vaultBase) {
  const out = [];
  const skip = new Set(['.git', '.obsidian', 'node_modules']);
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      if (e.name.startsWith('.') && e.name !== '.brain') continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith('.md')) out.push(abs);
    }
  };
  walk(vaultBase);
  return out;
}

// Reescreve `[[fromRel/...]]`, `[[fromRel]]` e `[[fromRel|alias]]` em todo o vault.
// NUNCA por basename: `proposta`/`design` existem em toda change — só full-path é seguro.
function rewriteChangeLinks(vaultBase, fromRel, toRel) {
  let touched = 0;
  for (const abs of allVaultMarkdown(vaultBase)) {
    let content;
    try { content = readFileSync(abs, 'utf8'); } catch { continue; }
    const next = content
      .split(`[[${fromRel}/`).join(`[[${toRel}/`)
      .split(`[[${fromRel}]]`).join(`[[${toRel}]]`)
      .split(`[[${fromRel}|`).join(`[[${toRel}|`);
    if (next !== content) {
      try { writeFileSync(abs, next, 'utf8'); touched += 1; } catch { /* nota readonly — segue */ }
    }
  }
  return touched;
}

// Cura retroativa (vaults pré-0.35): wikilinks para changes que já moveram sem reescrita.
// Dry-run por default; match por slug no nome datado do archive (`<data>-<slug>[-abandonada]`);
// ambíguo (mesmo slug arquivado 2×) é reportado e pulado — nunca chuta.
export function relinkChanges(vaultBase, { apply = false } = {}) {
  const chDir = getLocale(vaultBase).folders.changes;
  const archiveAbs = join(vaultBase, chDir, ARCHIVE_DIR);
  let archived = [];
  try { archived = readdirSync(archiveAbs, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* sem arquivo */ }
  const slugOf = (name) => name.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/-abandonada$/, '');

  // Slugs mortos referenciados em algum .md: [[<chDir>/<seg>/...]] | [[<chDir>/<seg>]] | [[...|
  const linkRe = new RegExp(`\\[\\[${chDir.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}/([^/\\]|]+)(?=[/\\]|])`, 'g');
  const files = allVaultMarkdown(vaultBase);
  const dead = new Set();
  for (const abs of files) {
    let content;
    try { content = readFileSync(abs, 'utf8'); } catch { continue; }
    for (const m of content.matchAll(linkRe)) {
      const seg = m[1];
      if (seg === ARCHIVE_DIR) continue;
      if (!existsSync(join(vaultBase, chDir, seg, 'proposta.md'))) dead.add(seg);
    }
  }

  const rewritten = [];
  const ambiguous = [];
  const orphans = [];
  const renames = [];
  for (const seg of dead) {
    const matches = archived.filter((name) => slugOf(name) === seg);
    if (matches.length === 1) renames.push({ from: `${chDir}/${seg}`, to: `${chDir}/${ARCHIVE_DIR}/${matches[0]}` });
    else if (matches.length > 1) ambiguous.push(`${seg} → ${matches.join(', ')}`);
    else orphans.push(seg);
  }

  let filesTouched = 0;
  if (apply) {
    for (const r of renames) filesTouched += rewriteChangeLinks(vaultBase, r.from, r.to);
  }
  rewritten.push(...renames);
  return { applied: apply, scanned: files.length, filesTouched, rewritten, ambiguous, orphans };
}

// Abandono (0.31.0): a saída legítima para uma change que não vai adiante — o que antes só o
// `archive --force` "resolvia", minting um ADR falso. Sem ADR, sem promoteSpecs (abandono não é
// decisão arquitetural nem promove contrato); move para _arquivo com sufixo -abandonada.
export function abandonChange(vaultBase, slug, { dateStr }) {
  const chDir = getLocale(vaultBase).folders.changes;
  const src = join(vaultBase, chDir, slug);
  if (!existsSync(join(src, 'proposta.md'))) return { ok: false, failing: [`change não encontrada: ${slug}`] };
  const destRel = join(chDir, ARCHIVE_DIR, `${dateStr}-${slug}-abandonada`);
  const destAbs = join(vaultBase, destRel);
  if (existsSync(destAbs)) return { ok: false, failing: [`destino já existe: ${destRel}`] };
  ensureDir(join(vaultBase, chDir, ARCHIVE_DIR));
  try { renameSync(src, destAbs); } catch (e) { return { ok: false, failing: [`falha ao mover: ${e.message}`] }; }
  try {
    const pp = join(destAbs, 'proposta.md');
    writeFileSync(pp, readFileSync(pp, 'utf8').replace(/^status:\s*active\s*$/m, 'status: abandoned'), 'utf8');
  } catch { /* proposta sem frontmatter — segue */ }
  let linksRewritten = 0;
  try { linksRewritten = rewriteChangeLinks(vaultBase, `${chDir}/${slug}`, destRel.replaceAll('\\', '/')); } catch { /* abandono já íntegro */ }
  if (activeChange(vaultBase) === slug) clearActiveChange(vaultBase);
  return { ok: true, failing: [], archivedRel: destRel, linksRewritten };
}
