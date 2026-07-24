// hooks/harness-doctor.mjs — integrity checks for the a2 harness state (Wave B).
// Pure-ish (fs reads only). `wendkeep doctor` reports errors (exit 1) + warnings.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { activeChange, parseTasks, backfillArtifactLinks } from './change-core.mjs';
import { relinkDerivedNotes } from './linked-notes.mjs';
import { buildEffectiveRequirementPackage, checkSpecsState, evaluateVerdict, tasksHashOf, validateSpecImpact } from './spec-core.mjs';
import { getLocale } from './locale.mjs';
import { readControl } from './obsidian-common.mjs';

export function checkHarness(vaultBase, projectRoot) {
  const loc = getLocale(vaultBase);
  const CHANGES_DIR = loc.folders.changes;
  const errors = [];
  const warnings = [];

  // 1. wendkeep.sensors.json well-formed.
  const sensorsPath = join(projectRoot, 'wendkeep.sensors.json');
  if (existsSync(sensorsPath)) {
    try {
      const data = JSON.parse(readFileSync(sensorsPath, 'utf8'));
      if (!Array.isArray(data.sensors)) errors.push('wendkeep.sensors.json: "sensors" não é lista');
      else for (const s of data.sensors) if (!s.id || !s.command) errors.push(`sensor sem id/command: ${JSON.stringify(s.id || '?')}`);
    } catch { errors.push('wendkeep.sensors.json: JSON inválido'); }
  }

  const specState = checkSpecsState(vaultBase);
  if (specState.missing) warnings.push('SPECS_STATE ausente — rode `wendkeep spec migrate`; 07-Specs deve ser gerado/read-only');
  else if (!specState.ok) errors.push(`07-Specs alterado fora do WendKeep: ${specState.changed.join(', ')} — mova a alteração para 08-Mudanças/<change>/specs`);

  // 2/3. Changes: malformed dirs; the active change's deltas add to knownReqs.
  const active = activeChange(vaultBase);
  let names = [];
  try { names = readdirSync(join(vaultBase, CHANGES_DIR)).filter((n) => n !== '_arquivo'); } catch { /* none */ }
  for (const name of names) {
    const dir = join(vaultBase, CHANGES_DIR, name);
    let entries;
    try { entries = readdirSync(dir); } catch { continue; } // a file, not a change dir
    if (!entries.includes('proposta.md')) { errors.push(`change sem proposta.md: ${name}`); continue; }
    const impact = validateSpecImpact(dir);
    errors.push(...impact.errors.map((e) => `${name}: ${e}`));
    warnings.push(...impact.warnings.map((w) => `${name}: ${w}`));
    let tasks = [];
    let tarefasMd = '';
    try { tarefasMd = readFileSync(join(dir, 'tarefas.md'), 'utf8'); tasks = parseTasks(tarefasMd); } catch { /* sem tarefas */ }
    const reqIds = [...new Set(tasks.flatMap((t) => t.reqs ?? []))];
    const effective = buildEffectiveRequirementPackage(vaultBase, dir, reqIds);
    errors.push(...effective.errors.map((e) => `${name}: spec efetiva inválida: ${e}`));
    if (effective.missing.length) errors.push(`req órfão em ${name}: ${effective.missing.map((id) => `[req:${id}]`).join(', ')} não existe na spec efetiva`);
    let verdict = null;
    try { verdict = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8')); } catch { /* sem verdict */ }
    if (verdict && reqIds.length) {
      const v = evaluateVerdict(verdict, reqIds, { tasksHash: tasksHashOf(tarefasMd), effectiveSpecHash: effective.hash });
      if (!v.ok) warnings.push(`verdict stale/incompleto em ${name}${v.missing.length ? `: falta cobrir ${v.missing.join(', ')}` : ''}`);
    }
  }

  // 4/5. Active-change pointer resolves; [req:] orphans; stale verdict.
  if (active) {
    const dir = join(vaultBase, CHANGES_DIR, active);
    if (!existsSync(join(dir, 'proposta.md'))) {
      errors.push(`ponteiro CURRENT_CHANGE aponta pra change inexistente: ${active}`);
    }
  }

  return { errors, warnings };
}

// --- diagnóstico de links do grafo (read-only, reusa os reparos em dry-run) -----
// Surfaça os órfãos que o doctor não enxergava: notas derivadas sem sessão-fonte,
// artefatos de change sem backlink, e o estado das cores do grafo. Cada não-zero tem um
// comando de reparo (note relink / change backlink / theme sync).
export function checkVaultLinks(vaultBase) {
  let derivedOrphans = 0;
  try { derivedOrphans = relinkDerivedNotes(vaultBase, {}).linked.length; } catch { /* sem notas derivadas */ }
  let artifactOrphans = 0;
  try { artifactOrphans = backfillArtifactLinks(vaultBase, {}).changed.length; } catch { /* sem changes */ }
  let graphColors = null; // true=com grupos · false=vazio/ausente de cores · null=sem graph.json
  try {
    const g = JSON.parse(readFileSync(join(vaultBase, '.obsidian', 'graph.json'), 'utf8'));
    graphColors = Array.isArray(g.colorGroups) && g.colorGroups.length > 0;
  } catch { graphColors = null; }
  return { derivedOrphans, artifactOrphans, graphColors };
}

const unquoteControl = (v) => String(v ?? '').replace(/^"(.*)"$/, '$1').trim();

// O control marca `inactive` quando a sessão-mãe encerra, mesmo com um workflow/subagente
// ainda vivo em background. Se a nota da sessão foi escrita há pouco apesar do `inactive`,
// sinaliza a atividade recente — o doctor deixa de dizer "inativa" quando não está.
// Conta blocos de frontmatter empilhados no TOPO da nota — a assinatura do prepend que a
// escrita concorrente sem lock produzia. `---` no corpo (regra horizontal, separador de
// tabela) não conta: só reabertura imediata após o fechamento do bloco anterior.
function stackedFrontmatterBlocks(content) {
  let rest = content;
  let blocks = 0;
  while (/^---\n/.test(rest)) {
    const close = rest.indexOf('\n---', 4);
    if (close < 0) break;
    blocks += 1;
    rest = rest.slice(close + 4).trimStart();
  }
  return blocks;
}

export function checkStackedFrontmatter(vaultBase) {
  const root = join(vaultBase, '02-Sessões');
  const notes = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      if (!entry.name.endsWith('.md')) continue;
      try {
        if (stackedFrontmatterBlocks(readFileSync(abs, 'utf-8')) > 1) notes.push(abs);
      } catch { /* nota ilegível não é o dano que esta checagem descreve */ }
    }
  };
  walk(root);
  return { count: notes.length, notes };
}

// Formatador puro pra que a saída do doctor seja testável sem process.exit.
export function renderStackedFrontmatterLines(vaultBase, stacked) {
  const lines = [`[notas] ${stacked.count} sessão(ões) com frontmatter empilhado`];
  for (const abs of stacked.notes) lines.push(`  ✗ ${relative(vaultBase, abs)}`);
  if (!stacked.count) lines.push('  frontmatter íntegro ✓');
  return lines;
}

export function checkSessionActivity(vaultBase, { now = Date.now(), windowMs = 5 * 60000 } = {}) {
  const control = readControl(vaultBase);
  const active = unquoteControl(control.status) === 'active';
  const sessionRel = unquoteControl(active ? control.session_file : (control.last_session_file || control.session_file));
  let ageMs = null;
  if (sessionRel) {
    try { ageMs = now - statSync(join(vaultBase, sessionRel)).mtimeMs; } catch { ageMs = null; }
  }
  const backgroundSuspected = !active && sessionRel !== '' && ageMs !== null && ageMs >= 0 && ageMs < windowMs;
  return { lastSession: sessionRel, active, ageMs, backgroundSuspected };
}
