// hooks/harness-doctor.mjs — integrity checks for the a2 harness state (Wave B).
// Pure-ish (fs reads only). `wendkeep doctor` reports errors (exit 1) + warnings.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { activeChange, parseTasks, backfillArtifactLinks } from './change-core.mjs';
import { relinkDerivedNotes } from './linked-notes.mjs';
import { buildEffectiveRequirementPackage, checkSpecsState, evaluateVerdict, tasksHashOf, validateSpecImpact } from './spec-core.mjs';
import { getLocale } from './locale.mjs';
import { priceForModel } from './token-usage.mjs';
import { countMissing, indexDerivedBySession, listSessionNotes, missingDerivedLinks } from './derived-sections.mjs';
import { readControl, readSessionRegistry } from './obsidian-common.mjs';
import { parseObservabilityCheckpoint } from './session-observability-state.mjs';
import { readObservabilityStore } from './session-observability-store.mjs';
import { assessObservabilityFreshness } from './session-observability-lifecycle.mjs';

export function checkSessionObservability(vaultBase, deps = {}) {
  const readRegistry = deps.readRegistry || readSessionRegistry;
  const readStore = deps.readStore || readObservabilityStore;
  const readNote = deps.readNote || readFileSync;
  const statSource = deps.statSource || statSync;
  const registry = readRegistry(vaultBase);
  const result = { ok: true, scanned: 0, healthy: 0, issues: [] };
  const entries = Object.entries(registry?.sessions || {})
    .map(([sessionId, entry]) => ({ sessionId, ...entry }))
    .filter((entry) => entry.session_file)
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));

  for (const entry of entries) {
    if (entry.provider && entry.provider !== 'codex') continue;
    const notePath = join(vaultBase, entry.session_file);
    let content;
    try { content = readNote(notePath, 'utf8'); } catch { continue; }
    if (!entry.provider && /^provider:\s*["']?claude/m.test(content)) continue;
    result.scanned += 1;
    const command = `wendkeep cost rebuild --session ${entry.sessionId} --json`;
    const checkpoint = parseObservabilityCheckpoint(content);
    if (!checkpoint) {
      result.issues.push({
        sessionId: entry.sessionId, status: 'legacy', diagnostics: [], command,
      });
      continue;
    }
    if (checkpoint.state === 'degraded') {
      result.issues.push({
        sessionId: entry.sessionId,
        status: 'degraded',
        diagnostics: checkpoint.diagnostics,
        command,
      });
      continue;
    }

    let runtime;
    try { runtime = readStore(vaultBase, entry.sessionId); } catch {
      runtime = null;
    }
    const assessment = assessObservabilityFreshness({
      checkpoint,
      runtimeState: runtime,
      statSource,
    });
    if (!assessment.fresh) {
      result.issues.push({
        sessionId: entry.sessionId,
        status: assessment.status,
        diagnostics: assessment.diagnostics,
        command,
      });
      continue;
    }
    result.healthy += 1;
  }
  result.ok = result.issues.length === 0;
  return result;
}

export function renderSessionObservabilityLines(result) {
  const issues = result?.issues || [];
  const lines = [
    `[observabilidade] ${result?.healthy || 0} saudável(is) · ${issues.length} reparável(is)`,
  ];
  for (const issue of issues) {
    const diagnostics = issue.diagnostics?.length
      ? ` (${issue.diagnostics.map(({ code, count }) => `${code}:${count}`).join(', ')})`
      : '';
    lines.push(`  ✗ ${issue.sessionId}: ${issue.status}${diagnostics}`);
    lines.push(`    → ${issue.command}`);
    lines.push(`    → ${issue.command} --apply`);
  }
  if (!issues.length) lines.push('  ✓ frontiers, checkpoints e manifests consistentes');
  return lines;
}

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

// Um modelo fora de `pricing.json` faz `priceForModel` devolver null e a parcela dele do custo
// virar zero — sem erro, sem aviso. Modelo novo (claude-opus-5, claude-mythos-5) cai nisso por
// default. A checagem é sobre o vault, não sobre o caminho de cálculo: o cálculo roda em hook a
// cada turno, onde avisar viraria ruído e lançar derrubaria a captura da sessão.
//
// Cada modelo citado na nota é consultado direto em `priceForModel` — NÃO se infere pelo
// sintoma "custo zerado". Numa sessão multi-modelo (`modelo: "claude-opus-4.8 + claude-opus-5"`)
// os modelos precificados mantêm o total acima de zero e escondem o que falta: no vault que
// motivou esta change, a nota fecha com $415 e a fatia do Opus 5 é a única zerada.
export function checkUnpricedModels(vaultBase) {
  const counts = new Map();

  const modelsOf = (frontmatter) => {
    // `modelos:` é a lista canônica; `modelo:` é o rótulo agregado (junta com " + ").
    const list = frontmatter.match(/^modelos:\n((?:\s+- .*\n?)+)/m);
    if (list) return list[1].split('\n').map((l) => l.replace(/^\s*-\s*/, '')).filter(Boolean);
    const label = (frontmatter.match(/^modelo:\s*(.+)$/m) || [])[1] || '';
    return label.split('+');
  };

  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      if (!entry.name.endsWith('.md')) continue;
      let content;
      try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
      const fm = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fm) continue;
      // Sessão sem uso registrado não é sintoma de nada — custo zero ali é correto.
      if (!(Number((fm[1].match(/^tokens_total:\s*(.+)$/m) || [])[1]) > 0)) continue;
      for (const raw of modelsOf(fm[1])) {
        const model = raw.trim().replace(/^["']|["']$/g, '');
        if (!model || model === 'unknown') continue;
        if (priceForModel(model)) continue;
        counts.set(model, (counts.get(model) || 0) + 1);
      }
    }
  };

  walk(join(vaultBase, '02-Sessões'));
  return { models: [...counts].map(([model, notes]) => ({ model, notes })) };
}

export function renderUnpricedModelLines(unpriced) {
  const lines = [`[preços] ${unpriced.models.length} modelo(s) sem preço na tabela`];
  for (const { model, notes } of unpriced.models) {
    lines.push(`  ✗ ${model} (${notes} nota(s) com custo zerado)`);
  }
  if (unpriced.models.length) lines.push('  → adicione o modelo em hooks/pricing.json');
  else lines.push('  tabela de preços completa ✓');
  return lines;
}

// As seções derivadas do corpo da nota de sessão ficavam para trás do Encerramento: num
// vault real, 15 decisões e 5 aprendizados listados no fecho contra 3 e um placeholder no
// corpo. Notas fechadas antes da correção não se consertam sozinhas — o doctor as aponta.
export function checkStaleDerivedSections(vaultBase) {
  const index = indexDerivedBySession(vaultBase);
  const notes = [];

  for (const abs of listSessionNotes(vaultBase)) {
    const rel = relative(vaultBase, abs).replaceAll('\\', '/');
    const entry = index.get(rel.replace(/\.md$/, '')) || index.get(rel);
    if (!entry) continue;
    let content;
    try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
    // Só falta conta. Link a mais pode ser curadoria do dono do vault, não sintoma.
    const missing = countMissing(missingDerivedLinks(content, entry));
    if (missing) notes.push({ file: rel, missing });
  }
  return { notes };
}

export function renderStaleDerivedSectionLines(stale) {
  const lines = [`[derivadas] ${stale.notes.length} sessão(ões) com seções desatualizadas`];
  for (const { file, missing } of stale.notes) lines.push(`  ✗ ${file} (${missing} link(s) faltando)`);
  if (stale.notes.length) lines.push('  → wendkeep note repair-sections --apply');
  else lines.push('  seções derivadas em dia ✓');
  return lines;
}

// Formatador puro pra que a saída do doctor seja testável sem process.exit.
export function renderStackedFrontmatterLines(vaultBase, stacked) {
  const lines = [`[notas] ${stacked.count} sessão(ões) com frontmatter empilhado`];
  for (const abs of stacked.notes) lines.push(`  ✗ ${relative(vaultBase, abs)}`);
  // Como as demais checagens do doctor: nunca apontar um problema sem oferecer o conserto.
  if (stacked.count) lines.push('  → wendkeep note repair-frontmatter --apply');
  else lines.push('  frontmatter íntegro ✓');
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
