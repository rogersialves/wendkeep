// `wendkeep change <sub>` — native change lifecycle CLI (Pilar B).
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  newChange,
  useChange,
  continueChange,
  activeChange,
  allChangesState,
  listChanges,
  renderOpenChanges,
  parseTasks,
  setTaskDone,
  archiveChange,
  abandonChange,
  relinkChanges,
  backfillArtifactLinks,
  scaffoldPlaceholders,
} from '../hooks/change-core.mjs';
import { evaluateGate, requiredSensors } from '../hooks/sensors-core.mjs';
import { buildEffectiveRequirementPackage, evaluateVerdict, formatOrphanReqs, tasksHashOf, parseSpecsList, parseDelta, parseRequirements, applyDelta, validateSpecImpact } from '../hooks/spec-core.mjs';
import { getNextAdrNumber, readControl, readSessionRegistry, upsertSessionRegistry } from '../hooks/obsidian-common.mjs';
import { getLocale } from '../hooks/locale.mjs';

function resolveVault(argv) {
  let vault;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--vault') vault = argv[++i];
    else if (a.startsWith('--vault=')) vault = a.slice(8);
  }
  const base = vault || process.env.OBSIDIAN_VAULT_PATH;
  if (!base) {
    process.stderr.write('wendkeep change: no vault. Pass --vault <path> or set OBSIDIAN_VAULT_PATH.\n');
    process.exit(2);
  }
  return isAbsolute(base) ? base : resolve(process.cwd(), base);
}

function opt(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function runChange(argv) {
  const [sub, ...rest] = argv;
  const vaultBase = resolveVault(rest);
  const VALUE_FLAGS = new Set(['--vault', '--change', '--project', '--session']);
  const slugArg = () => rest.find((a, i) => !a.startsWith('-') && !VALUE_FLAGS.has(rest[i - 1]));

  if (sub === 'new') {
    const slug = slugArg();
    if (!slug) { process.stderr.write('wendkeep change new: missing <slug>\n'); process.exit(2); }
    // G2: link the active session into the proposta's source: (graph edge proposta->sessão).
    let sessionRel = '';
    try { sessionRel = readControl(vaultBase).session_file || ''; } catch { /* sem control */ }
    const r = newChange(vaultBase, slug, { dateStr: today(), simple: rest.includes('--simple'), sessionRel });
    process.stdout.write(`change ${r.created ? 'created' : 'exists'}: ${r.rel} (active)\n`);
    process.exit(0);
  }

  if (sub === 'use') {
    const slug = slugArg();
    if (!slug) { process.stderr.write('wendkeep change use: missing <slug>\n'); process.exit(2); }
    const r = useChange(vaultBase, slug);
    if (!r.ok) { process.stderr.write(`wendkeep change use: ${r.error}\n`); process.exit(2); }
    process.stdout.write(`current change: ${slug}\n`);
    process.exit(0);
  }

  if (sub === 'bind') {
    const slug = slugArg();
    const sessionId = opt(rest, '--session');
    if (!slug || !sessionId) { process.stderr.write('wendkeep change bind: use <slug> --session <id>\n'); process.exit(2); }
    const state = allChangesState(vaultBase);
    if (!state.changes.some((item) => item.slug === slug)) { process.stderr.write(`wendkeep change bind: open change not found: ${slug}\n`); process.exit(2); }
    if (!readSessionRegistry(vaultBase).sessions?.[sessionId]) { process.stderr.write(`wendkeep change bind: session not found: ${sessionId}\n`); process.exit(2); }
    upsertSessionRegistry(vaultBase, sessionId, { change_slug: slug });
    process.stdout.write(`session ${sessionId} -> change ${slug}\n`);
    process.exit(0);
  }

  if (sub === 'continue') {
    const positionals = rest.filter((a, i) => !a.startsWith('-') && !VALUE_FLAGS.has(rest[i - 1]));
    const [archivedSlug, newSlug] = positionals;
    if (!archivedSlug || !newSlug) {
      process.stderr.write('wendkeep change continue: use <archived-slug> <new-slug>\n');
      process.exit(2);
    }
    let sessionRel = '';
    try { sessionRel = readControl(vaultBase).session_file || ''; } catch { /* no control */ }
    const r = continueChange(vaultBase, archivedSlug, newSlug, {
      dateStr: today(), simple: rest.includes('--simple'), sessionRel,
    });
    if (!r.ok) { process.stderr.write(`wendkeep change continue: ${r.error}\n`); process.exit(2); }
    process.stdout.write(`change created: ${r.rel} (continues ${r.archived}; active)\n`);
    process.exit(0);
  }

  if (sub === 'list') {
    const state = allChangesState(vaultBase);
    const { archived } = listChanges(vaultBase);
    process.stdout.write(`${renderOpenChanges(state, { tag: '' }) || 'open changes: (none)'}\n`);
    process.stdout.write(`archived: ${archived.join(', ') || '(none)'}\n`);
    process.exit(0);
  }

  if (sub === 'show') {
    const slug = slugArg();
    if (!slug) { process.stderr.write('wendkeep change show: missing <slug>\n'); process.exit(2); }
    let md;
    try { md = readFileSync(join(vaultBase, getLocale(vaultBase).folders.changes, slug, 'tarefas.md'), 'utf8'); }
    catch { process.stderr.write(`wendkeep change show: not found: ${slug}\n`); process.exit(2); }
    const tasks = parseTasks(md);
    const open = tasks.filter((t) => !t.done).length;
    process.stdout.write(`${slug}: ${tasks.length} task(s), ${open} open\n`);
    for (const t of tasks) process.stdout.write(`  [${t.done ? 'x' : ' '}] ${t.id} ${t.text}\n`);
    process.exit(0);
  }

  if (sub === 'status') {
    const slug = slugArg();
    if (!slug) {
      const state = allChangesState(vaultBase);
      if (!state.changes.length && !state.pointerWarning) {
        process.stderr.write('wendkeep change status: no open changes\n');
        process.exit(2);
      }
      process.stdout.write(`${renderOpenChanges(state, { tag: '' })}\n`);
      process.exit(0);
    }
    const dir = join(vaultBase, getLocale(vaultBase).folders.changes, slug);
    let tarefasMd;
    try { tarefasMd = readFileSync(join(dir, 'tarefas.md'), 'utf8'); }
    catch { process.stderr.write(`wendkeep change status: not found: ${slug}\n`); process.exit(2); }
    const tasks = parseTasks(tarefasMd);
    const done = tasks.filter((t) => t.done).length;
    process.stdout.write(`change: ${slug}${slug === activeChange(vaultBase) ? ' (ativa)' : ''}\n`);
    let specs = [];
    try { specs = parseSpecsList(readFileSync(join(dir, 'proposta.md'), 'utf8')); } catch { /* sem proposta */ }
    process.stdout.write(`specs: ${specs.join(', ') || '(nenhuma)'}\n`);
    process.stdout.write(`tarefas: ${done} done / ${tasks.length - done} open\n`);
    for (const t of tasks) {
      process.stdout.write(`  [${t.done ? 'x' : ' '}] ${t.id} ${t.text}${(t.reqs ?? []).map((r) => ` [req:${r}]`).join('')}${t.sensor ? ` [sensor:${t.sensor}]` : ''}\n`);
    }
    let evidence = null;
    try { evidence = JSON.parse(readFileSync(join(dir, 'evidencia.json'), 'utf8')); } catch { /* sem evidência */ }
    if (evidence) for (const e of evidence) process.stdout.write(`  ${e.status === 'green' ? '✓' : '✗'} ${e.id} (${e.severity || 'critical'})\n`);
    else process.stdout.write('evidencia: ausente\n');
    const reqIds = [...new Set(tasks.flatMap((t) => t.reqs ?? []))];
    const effective = buildEffectiveRequirementPackage(vaultBase, dir, reqIds);
    if (effective.errors.length || effective.missing.length) {
      process.stdout.write(`spec efetiva: inválida (${[...effective.errors, ...effective.missing.map((id) => `req órfão ${id}`)].join('; ')})\n`);
    }
    let verdict = null;
    try { verdict = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8')); } catch { /* sem verdict */ }
    if (!verdict) process.stdout.write(`verdict: ausente — rode \`wendkeep verify --deep\`${reqIds.length ? ' + wk-verify' : ' (verdict trivial automático)'}\n`);
    else if (!reqIds.length) process.stdout.write(`verdict: ${verdict.ok === true ? 'ok (trivial)' : 'não-ok — re-verifique'}\n`);
    else {
      const v = evaluateVerdict(verdict, reqIds, { tasksHash: tasksHashOf(tarefasMd), effectiveSpecHash: effective.hash });
      process.stdout.write(`verdict: ${v.ok ? 'ok' : v.stale ? 'stale — re-verifique' : `incompleto: falta ${v.missing.join(', ')}`}\n`);
    }
    try { process.stdout.write(`mutation-round: ${readFileSync(join(dir, '.mutation-round'), 'utf8').trim()}/3\n`); } catch { /* sem rodadas */ }
    process.exit(0);
  }

  if (sub === 'done' || sub === 'undone') {
    const taskId = slugArg();
    if (!taskId) { process.stderr.write(`wendkeep change ${sub}: missing <taskId>\n`); process.exit(2); }
    const slug = opt(rest, '--change') || activeChange(vaultBase);
    if (!slug) { process.stderr.write(`wendkeep change ${sub}: no active change\n`); process.exit(2); }
    const dir = join(vaultBase, getLocale(vaultBase).folders.changes, slug);
    let ok = false;
    try { ok = setTaskDone(dir, taskId, sub === 'done'); } catch { /* sem tarefas.md */ }
    if (!ok) { process.stderr.write(`wendkeep change ${sub}: task não encontrada: ${taskId}\n`); process.exit(2); }
    process.stdout.write(`task ${taskId}: ${sub === 'done' ? '[x]' : '[ ]'}\n`);
    process.exit(0);
  }

  if (sub === 'diff') {
    const slug = slugArg() || activeChange(vaultBase);
    if (!slug) { process.stderr.write('wendkeep change diff: no change (arg or active)\n'); process.exit(2); }
    const dir = join(vaultBase, getLocale(vaultBase).folders.changes, slug);
    let specs = [];
    try { specs = parseSpecsList(readFileSync(join(dir, 'proposta.md'), 'utf8')); }
    catch { process.stderr.write(`wendkeep change diff: not found: ${slug}\n`); process.exit(2); }
    if (!specs.length) { process.stdout.write('diff: sem specs declaradas na proposta\n'); process.exit(0); }
    for (const cap of specs) {
      let delta;
      try { delta = parseDelta(readFileSync(join(dir, 'specs', cap, 'spec.md'), 'utf8')); }
      catch { process.stdout.write(`! sem delta para ${cap}\n`); continue; }
      process.stdout.write(`spec: ${cap}\n`);
      for (const r of delta.added) process.stdout.write(`  + ${r.id || r.name} (ADDED)\n`);
      for (const r of delta.modified) process.stdout.write(`  ~ ${r.id || r.name} (MODIFIED)\n`);
      for (const k of delta.removed) process.stdout.write(`  - ${k} (REMOVED)\n`);
      let living = [];
      try { living = parseRequirements(readFileSync(join(vaultBase, getLocale(vaultBase).folders.specs, `${cap}.md`), 'utf8')); } catch { /* nova capability */ }
      for (const w of applyDelta(living, delta).warnings) process.stdout.write(`  ! ${w}\n`);
    }
    process.exit(0);
  }

  if (sub === 'archive') {
    const slug = slugArg() || activeChange(vaultBase);
    if (!slug) { process.stderr.write('wendkeep change archive: missing <slug> and no active change\n'); process.exit(2); }
    // Real gate (Pilar C): every sensor a task declared must be green in evidencia.json.
    const gate = (dir) => {
      // G0: um scaffold nunca preenchido não é uma mudança concluída — arquivar geraria um
      // ADR falso. INESCAPÁVEL desde 0.31.0 (--force não pula — visto em produção: change
      // 100% placeholder arquivada via --force mintou ADR falso). Saída legítima: abandon.
      const placeholders = scaffoldPlaceholders(dir);
      if (placeholders.length) {
        return { ok: false, failing: [`scaffold não preenchido (${placeholders.join('; ')}) — preencha proposta/design/tarefas antes de arquivar, ou \`wendkeep change abandon ${slug}\` se a change não vai adiante (--force não pula este check)`] };
      }
      const impact = validateSpecImpact(dir);
      for (const warning of impact.warnings) process.stderr.write(`aviso spec: ${warning}\n`);
      if (!impact.ok) return { ok: false, failing: impact.errors };
      let tarefasMd = '';
      try { tarefasMd = readFileSync(join(dir, 'tarefas.md'), 'utf8'); } catch { /* no tasks */ }
      const tasks = parseTasks(tarefasMd);
      // G1: uma change não arquiva com tarefa aberta (inclui fix-tasks M.n de mutação).
      const open = tasks.filter((t) => !t.done);
      if (open.length && !rest.includes('--force')) {
        return { ok: false, failing: [`${open.length} tarefa(s) aberta(s) (ex.: ${open[0].id} ${open[0].text}) — conclua ou use --force`] };
      }
      const required = requiredSensors(tasks);
      // Evidence freshness: block if tarefas.md changed since verify sealed the evidence
      // (e.g. a sensor task added/edited after the last green verify).
      if (required.length) {
        let evHash = '';
        try { evHash = readFileSync(join(dir, '.evidence-hash'), 'utf8').trim(); } catch { /* pre-seal evidence */ }
        if (evHash && evHash !== tasksHashOf(tarefasMd)) {
          return { ok: false, failing: ['evidência stale (tarefas.md mudou desde o último verify) — rode `wendkeep verify` de novo'] };
        }
      }
      const reqIds = [...new Set(tasks.flatMap((t) => t.reqs ?? []))];
      const effective = buildEffectiveRequirementPackage(vaultBase, dir, reqIds);
      if (effective.errors.length) return { ok: false, failing: [`spec efetiva inválida: ${effective.errors.join('; ')}`] };
      if (effective.missing.length) return { ok: false, failing: [formatOrphanReqs(effective.missing)] };
      let evidence = [];
      try { evidence = JSON.parse(readFileSync(join(dir, 'evidencia.json'), 'utf8')); } catch { /* no evidence */ }
      const s = evaluateGate(evidence, required);
      if (!s.ok) return s;
      // Verdict SEMPRE exigido (0.31.0) — a exigência universal vive AQUI no gate; a semântica
      // reqless→ok de evaluateVerdict (spec-core) não muda porque `verify --deep` e `change
      // status` dependem dela. Change sem [req:] destrava com o auto-verdict do verify --deep.
      let verdict = null;
      try { verdict = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8')); } catch { /* none */ }
      const hash = tasksHashOf(tarefasMd);
      if (!verdict) {
        return { ok: false, failing: [reqIds.length
          ? 'sem verdict — rode `wendkeep verify --deep` + skill wk-verify'
          : 'sem verdict — rode `wendkeep verify --deep` (verdict trivial automático)'] };
      }
      if (verdict.ok !== true) return { ok: false, failing: ['verdict não-ok — re-verifique a change antes de arquivar'] };
      if (verdict.tasksHash && verdict.tasksHash !== hash) {
        return { ok: false, failing: [`verdict stale (tarefas.md mudou depois da verificação) — re-verifique: \`wendkeep verify --deep\`${reqIds.length ? ' + wk-verify' : ''}`] };
      }
      let verification = null;
      try { verification = JSON.parse(readFileSync(join(dir, 'verificacao.json'), 'utf8')); } catch { /* none */ }
      if (verification?.effectiveSpecHash && verification.effectiveSpecHash !== effective.hash) {
        return { ok: false, failing: ['pacote de verificação stale (spec efetiva mudou) — rode `wendkeep verify --deep` novamente'] };
      }
      if (reqIds.length && verification?.effectiveSpecHash && !verdict.effectiveSpecHash) {
        return { ok: false, failing: ['verdict sem effectiveSpecHash — rode a skill wk-verify novamente'] };
      }
      if (reqIds.length) {
        const v = evaluateVerdict(verdict, reqIds, { tasksHash: hash, effectiveSpecHash: effective.hash });
        if (!v.ok) {
          if (v.stale) return { ok: false, failing: ['verdict stale (tarefas.md mudou depois da verificação) — re-verifique: `wendkeep verify --deep` + wk-verify'] };
          return { ok: false, failing: [`verdict incompleto: falta ${v.missing.join(', ')}`] };
        }
      }
      return { ok: true, failing: [] };
    };
    // Rastro auditável: forced só quando o --force de fato pulou G1 (tarefa aberta); trivial
    // quando a change não declarou nenhuma prova ([req:]/[sensor:]).
    let tasks = [];
    try { tasks = parseTasks(readFileSync(join(vaultBase, getLocale(vaultBase).folders.changes, slug, 'tarefas.md'), 'utf8')); } catch { /* sem tarefas */ }
    const forced = rest.includes('--force') && tasks.some((t) => !t.done);
    const trivial = !tasks.some((t) => t.req) && !tasks.some((t) => t.sensor);
    if (trivial) process.stderr.write('aviso: change trivial (sem [req:]/[sensor:]) — ADR marcado trivial: true\n');
    const r = archiveChange(vaultBase, slug, { dateStr: today(), adrNum: getNextAdrNumber(vaultBase), gate, adrFlags: { forced, trivial } });
    if (!r.ok) {
      process.stderr.write(`change archive BLOCKED (gate): ${r.failing.join('; ')}\n`);
      process.exit(1);
    }
    process.stdout.write(`archived: ${r.archivedRel}; ADR: ${r.adrRel}\n`);
    if (r.promoted && r.promoted.length) process.stdout.write(`specs promovidas: ${r.promoted.join(', ')}\n`);
    if (r.specWarnings && r.specWarnings.length) for (const w of r.specWarnings) process.stderr.write(`  aviso spec: ${w}\n`);
    process.exit(0);
  }

  if (sub === 'relink') {
    const r = relinkChanges(vaultBase, { apply: rest.includes('--apply') });
    if (rest.includes('--json')) { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); process.exit(0); }
    process.stdout.write(`${r.rewritten.length} slug(s) morto(s) mapeado(s)${r.applied ? ` · ${r.filesTouched} arquivo(s) reescritos` : ''}\n`);
    for (const m of r.rewritten) process.stdout.write(`  ${m.from} → ${m.to}\n`);
    for (const a of r.ambiguous) process.stdout.write(`  ambíguo (pulado): ${a}\n`);
    for (const o of r.orphans) process.stdout.write(`  sem archive correspondente: ${o}\n`);
    if (!r.applied) process.stdout.write('\ndry-run — nada foi escrito. Rode com --apply para reescrever os wikilinks.\n');
    process.exit(0);
  }

  if (sub === 'backlink') {
    const r = backfillArtifactLinks(vaultBase, { apply: rest.includes('--apply') });
    if (rest.includes('--json')) { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); process.exit(0); }
    process.stdout.write(`${r.changed.length} artefato(s) órfão(s) em ${r.scanned} change(s)${r.applied ? ' · reescritos' : ''}\n`);
    for (const f of r.changed) process.stdout.write(`  ${f}\n`);
    if (!r.applied && r.changed.length) process.stdout.write('\ndry-run — nada escrito. Rode com --apply para injetar os backlinks.\n');
    process.exit(0);
  }

  if (sub === 'abandon') {
    const slug = slugArg() || activeChange(vaultBase);
    if (!slug) { process.stderr.write('wendkeep change abandon: missing <slug> and no active change\n'); process.exit(2); }
    const r = abandonChange(vaultBase, slug, { dateStr: today() });
    if (!r.ok) { process.stderr.write(`wendkeep change abandon: ${r.failing.join('; ')}\n`); process.exit(2); }
    process.stdout.write(`abandoned: ${r.archivedRel}\n`);
    process.exit(0);
  }

  process.stderr.write(`wendkeep change: unknown subcommand "${sub}". Known: new, use, continue, list, show, status, done, undone, diff, archive, abandon, relink, backlink.\n`);
  process.exit(2);
}
