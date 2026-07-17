// `wendkeep verify [--change <slug>]` — run a change's task sensors, record evidence.
// Sensors run at the PROJECT root (--project or cwd); the change + evidence live in
// the VAULT. Writes 08-Mudanças/<slug>/evidencia.json; exit 1 if a critical sensor is red.
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseTasks, activeChange, appendFixTasks } from '../hooks/change-core.mjs';
import { loadSensorsDetailed, findProjectRoot, requiredSensors, runSensors, evaluateGate } from '../hooks/sensors-core.mjs';
import {
  buildEffectiveRequirementPackage,
  captureSpecBaseline,
  formatOrphanReqs,
  tasksHashOf,
} from '../hooks/spec-core.mjs';
import { addLesson } from '../hooks/lessons-core.mjs';
import { getLocale } from '../hooks/locale.mjs';

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function opt(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

export function runVerify(argv) {
  const vaultRaw = opt(argv, '--vault') || process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultRaw) { process.stderr.write('wendkeep verify: no vault (--vault or OBSIDIAN_VAULT_PATH).\n'); process.exit(2); }
  const vaultBase = isAbsolute(vaultRaw) ? vaultRaw : resolve(process.cwd(), vaultRaw);
  // --project wins; otherwise climb from cwd to the nearest project marker (agent shells
  // keep their cwd across commands, so verify from a subdirectory is a recurring miss).
  const projectRoot = resolve(opt(argv, '--project') || findProjectRoot(process.cwd()) || process.cwd());
  const slug = opt(argv, '--change') || activeChange(vaultBase);
  if (!slug) { process.stderr.write('wendkeep verify: no change (--change or active).\n'); process.exit(2); }

  const changeDir = join(vaultBase, getLocale(vaultBase).folders.changes, slug);
  let tarefas = '';
  try { tarefas = readFileSync(join(changeDir, 'tarefas.md'), 'utf8'); }
  catch { process.stderr.write(`wendkeep verify: change not found: ${slug}\n`); process.exit(2); }

  const ids = requiredSensors(parseTasks(tarefas));
  const loaded = loadSensorsDetailed(projectRoot);
  if (loaded.error) {
    process.stderr.write(`wendkeep verify: wendkeep.sensors.json inválido em ${loaded.path}: ${loaded.error}\n`);
    process.exit(2);
  }
  if (loaded.missing && ids.length) {
    process.stderr.write(`wendkeep verify: wendkeep.sensors.json não encontrado em ${loaded.path} — rode da raiz do projeto ou use --project <raiz>\n`);
  }
  const sensors = loaded.sensors;
  const evidence = runSensors(sensors, ids, { cwd: projectRoot });
  writeFileSync(join(changeDir, 'evidencia.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  // Freshness seal: bind this evidence to the tarefas.md it was produced against, so the archive
  // gate can reject evidence gone stale (a sensor task added after this verify run).
  writeFileSync(join(changeDir, '.evidence-hash'), tasksHashOf(tarefas), 'utf8');

  // Mutation survivors -> fix tasks (Wave B), bounded at 3 rounds then escalate. A surviving
  // mutant always fails verify (exit 1): the suite does not discriminate yet. A clean report
  // resets the round counter so a future survivor starts a fresh cycle.
  const withSurvivors = evidence.filter((e) => e.survivors && e.survivors.length);
  const roundFile = join(changeDir, '.mutation-round');
  if (!withSurvivors.length) {
    try { unlinkSync(roundFile); } catch { /* nunca houve rodada */ }
  } else {
    let round = 0;
    try { round = Number(readFileSync(roundFile, 'utf8').trim()) || 0; } catch { /* first round */ }
    if (round >= 3) {
      process.stderr.write('verify: mutantes ainda sobrevivem após 3 rodadas — revise os testes à mão.\n');
      const flat = withSurvivors.flatMap((e) => e.survivors.map((s) => `${s.file}:${s.line}`));
      try {
        addLesson(vaultBase, {
          trigger: `mutantes persistentes em ${slug}`,
          lesson: `3 rodadas de fix-tasks não mataram: ${flat.join(', ')} — os testes desses pontos não discriminam.`,
          sourceChange: slug,
          dateStr: today(),
        });
      } catch { /* lesson é bônus, nunca derruba o verify */ }
    } else {
      let added = 0;
      for (const e of withSurvivors) added += appendFixTasks(changeDir, e.survivors, e.id);
      writeFileSync(roundFile, String(round + 1), 'utf8');
      process.stdout.write(`verify: ${added} fix-task(s) de mutação (rodada ${round + 1}/3)\n`);
    }
    process.stderr.write('verify: mutantes sobreviventes — a suíte não discrimina ainda.\n');
    process.exit(1);
  }

  // Same rule as the archive gate: evidence carries severity, so evaluateGate blocks
  // only on critical/missing — a red warning is advisory and passes verify.
  const { ok, failing } = evaluateGate(evidence, ids);
  for (const e of evidence) {
    const mark = e.status === 'green' ? '✓' : (e.severity === 'warning' ? '!' : '✗');
    process.stdout.write(`  ${mark} ${e.id}${e.severity === 'warning' && e.status === 'red' ? ' (warning)' : ''}\n`);
  }
  if (!ok) { process.stderr.write(`verify: critical sensors red: ${failing.join(', ')}\n`); process.exit(1); }

  // --deep (Q2=B): assemble the verification package the wk-verify skill judges. A trivial
  // change (no [req:] tasks, sensors green) gets an auto verdict — no agent pass needed.
  if (argv.includes('--deep')) {
    const tasks = parseTasks(tarefas);
    const reqIds = [...new Set(tasks.flatMap((t) => t.reqs ?? []))];
    const tasksHash = tasksHashOf(tarefas);
    captureSpecBaseline(vaultBase, changeDir);
    const effective = buildEffectiveRequirementPackage(vaultBase, changeDir, reqIds);
    if (effective.errors.length) {
      process.stderr.write(`verify --deep: spec efetiva inválida: ${effective.errors.join('; ')}\n`);
      process.exit(1);
    }
    if (effective.missing.length) {
      process.stderr.write(`verify --deep: ${formatOrphanReqs(effective.missing)}\n`);
      process.exit(1);
    }
    const pkg = {
      slug,
      tasksHash,
      effectiveSpecHash: effective.hash,
      requirements: effective.requirements.map((req) => {
        return {
          id: req.id,
          name: req.name,
          capability: req.capability,
          operation: req.operation,
          source: req.source,
          body: req.body,
        };
      }),
      tasks: tasks.map((t) => ({ id: t.id, text: t.text, req: t.req || null, reqs: t.reqs || [], done: t.done })),
      sensors: evidence,
    };
    writeFileSync(join(changeDir, 'verificacao.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    if (reqIds.length === 0) {
      writeFileSync(join(changeDir, 'verdict.json'), `${JSON.stringify({ slug, ok: true, coverage: [], tasksHash, effectiveSpecHash: effective.hash, notes: ['trivial: sem requisito'] }, null, 2)}\n`, 'utf8');
      process.stdout.write('verify --deep: pacote + verdict trivial escritos\n');
    } else {
      process.stdout.write('verify --deep: pacote escrito — rode a skill wk-verify pra gravar verdict.json\n');
    }
    process.exit(0);
  }
  process.stdout.write(`verify OK (${ids.length} sensor(s))\n`);
  process.exit(0);
}
