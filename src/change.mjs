// `wendkeep change <sub>` — native change lifecycle CLI (Pilar B).
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  newChange,
  activeChange,
  listChanges,
  parseTasks,
  setTaskDone,
  archiveChange,
} from '../hooks/change-core.mjs';
import { evaluateGate, requiredSensors } from '../hooks/sensors-core.mjs';
import { evaluateVerdict, tasksHashOf, parseSpecsList, parseDelta, parseRequirements, applyDelta } from '../hooks/spec-core.mjs';
import { getNextAdrNumber, readControl } from '../hooks/obsidian-common.mjs';
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
  const VALUE_FLAGS = new Set(['--vault', '--change', '--project']);
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

  if (sub === 'list') {
    const { active, archived } = listChanges(vaultBase);
    const cur = activeChange(vaultBase);
    process.stdout.write(`active: ${active.map((s) => (s === cur ? `*${s}` : s)).join(', ') || '(none)'}\n`);
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
    const slug = slugArg() || activeChange(vaultBase);
    if (!slug) { process.stderr.write('wendkeep change status: no change (arg or active)\n'); process.exit(2); }
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
      process.stdout.write(`  [${t.done ? 'x' : ' '}] ${t.id} ${t.text}${t.req ? ` [req:${t.req}]` : ''}${t.sensor ? ` [sensor:${t.sensor}]` : ''}\n`);
    }
    let evidence = null;
    try { evidence = JSON.parse(readFileSync(join(dir, 'evidencia.json'), 'utf8')); } catch { /* sem evidência */ }
    if (evidence) for (const e of evidence) process.stdout.write(`  ${e.status === 'green' ? '✓' : '✗'} ${e.id} (${e.severity || 'critical'})\n`);
    else process.stdout.write('evidencia: ausente\n');
    const reqIds = [...new Set(tasks.map((t) => t.req).filter(Boolean))];
    let verdict = null;
    try { verdict = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8')); } catch { /* sem verdict */ }
    if (!reqIds.length) process.stdout.write('verdict: não exigido (sem [req:])\n');
    else if (!verdict) process.stdout.write('verdict: ausente — rode `wendkeep verify --deep` + wk-verify\n');
    else {
      const v = evaluateVerdict(verdict, reqIds, { tasksHash: tasksHashOf(tarefasMd) });
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
      let tarefasMd = '';
      try { tarefasMd = readFileSync(join(dir, 'tarefas.md'), 'utf8'); } catch { /* no tasks */ }
      const tasks = parseTasks(tarefasMd);
      // G1: uma change não arquiva com tarefa aberta (inclui fix-tasks M.n de mutação).
      const open = tasks.filter((t) => !t.done);
      if (open.length && !rest.includes('--force')) {
        return { ok: false, failing: [`${open.length} tarefa(s) aberta(s) (ex.: ${open[0].id} ${open[0].text}) — conclua ou use --force`] };
      }
      const required = requiredSensors(tasks);
      const reqIds = [...new Set(tasks.map((t) => t.req).filter(Boolean))];
      let evidence = [];
      try { evidence = JSON.parse(readFileSync(join(dir, 'evidencia.json'), 'utf8')); } catch { /* no evidence */ }
      const s = evaluateGate(evidence, required);
      if (!s.ok) return s;
      // Independent verdict (Wave A): required only when the change declares [req:] tasks.
      let verdict = null;
      try { verdict = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8')); } catch { /* none */ }
      const v = evaluateVerdict(verdict, reqIds, { tasksHash: tasksHashOf(tarefasMd) });
      if (!v.ok) {
        if (v.stale) return { ok: false, failing: ['verdict stale (tarefas.md mudou depois da verificação) — re-verifique: `wendkeep verify --deep` + wk-verify'] };
        return { ok: false, failing: verdict ? [`verdict incompleto: falta ${v.missing.join(', ')}`] : ['sem verdict — rode `wendkeep verify --deep` + skill wk-verify'] };
      }
      return { ok: true, failing: [] };
    };
    const r = archiveChange(vaultBase, slug, { dateStr: today(), adrNum: getNextAdrNumber(vaultBase), gate });
    if (!r.ok) {
      process.stderr.write(`change archive BLOCKED (gate): ${r.failing.join('; ')}\n`);
      process.exit(1);
    }
    process.stdout.write(`archived: ${r.archivedRel}; ADR: ${r.adrRel}\n`);
    if (r.promoted && r.promoted.length) process.stdout.write(`specs promovidas: ${r.promoted.join(', ')}\n`);
    if (r.specWarnings && r.specWarnings.length) for (const w of r.specWarnings) process.stderr.write(`  aviso spec: ${w}\n`);
    process.exit(0);
  }

  process.stderr.write(`wendkeep change: unknown subcommand "${sub}". Known: new, list, show, status, done, undone, diff, archive.\n`);
  process.exit(2);
}
