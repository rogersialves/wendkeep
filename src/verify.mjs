// `wendkeep verify [--change <slug>]` — run a change's task sensors, record evidence.
// Sensors run at the PROJECT root (--project or cwd); the change + evidence live in
// the VAULT. Writes 08-Mudanças/<slug>/evidencia.json; exit 1 if a critical sensor is red.
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseTasks, activeChange, appendFixTasks } from '../hooks/change-core.mjs';
import { loadSensors, requiredSensors, runSensors, evaluateGate } from '../hooks/sensors-core.mjs';

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
  const projectRoot = resolve(opt(argv, '--project') || process.cwd());
  const slug = opt(argv, '--change') || activeChange(vaultBase);
  if (!slug) { process.stderr.write('wendkeep verify: no change (--change or active).\n'); process.exit(2); }

  const changeDir = join(vaultBase, '08-Mudanças', slug);
  let tarefas = '';
  try { tarefas = readFileSync(join(changeDir, 'tarefas.md'), 'utf8'); }
  catch { process.stderr.write(`wendkeep verify: change not found: ${slug}\n`); process.exit(2); }

  const ids = requiredSensors(parseTasks(tarefas));
  const sensors = loadSensors(projectRoot);
  const evidence = runSensors(sensors, ids, { cwd: projectRoot });
  writeFileSync(join(changeDir, 'evidencia.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  // Mutation survivors -> fix tasks (Wave B), bounded at 3 rounds then escalate.
  const withSurvivors = evidence.filter((e) => e.survivors && e.survivors.length);
  if (withSurvivors.length) {
    const roundFile = join(changeDir, '.mutation-round');
    let round = 0;
    try { round = Number(readFileSync(roundFile, 'utf8').trim()) || 0; } catch { /* first round */ }
    if (round >= 3) {
      process.stderr.write('verify: mutantes ainda sobrevivem após 3 rodadas — revise os testes à mão.\n');
    } else {
      let added = 0;
      for (const e of withSurvivors) added += appendFixTasks(changeDir, e.survivors, e.id);
      writeFileSync(roundFile, String(round + 1), 'utf8');
      process.stdout.write(`verify: ${added} fix-task(s) de mutação (rodada ${round + 1}/3)\n`);
    }
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
    const reqIds = [...new Set(tasks.map((t) => t.req).filter(Boolean))];
    const pkg = {
      slug,
      requirements: reqIds.map((id) => ({ id })),
      tasks: tasks.map((t) => ({ id: t.id, text: t.text, req: t.req || null, done: t.done })),
      sensors: evidence,
    };
    writeFileSync(join(changeDir, 'verificacao.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    if (reqIds.length === 0) {
      writeFileSync(join(changeDir, 'verdict.json'), `${JSON.stringify({ slug, ok: true, coverage: [], notes: ['trivial: sem requisito'] }, null, 2)}\n`, 'utf8');
      process.stdout.write('verify --deep: pacote + verdict trivial escritos\n');
    } else {
      process.stdout.write('verify --deep: pacote escrito — rode a skill wk-verify pra gravar verdict.json\n');
    }
    process.exit(0);
  }
  process.stdout.write(`verify OK (${ids.length} sensor(s))\n`);
  process.exit(0);
}
