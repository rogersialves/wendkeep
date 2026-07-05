// `wendkeep verify [--change <slug>]` — run a change's task sensors, record evidence.
// Sensors run at the PROJECT root (--project or cwd); the change + evidence live in
// the VAULT. Writes 08-Mudanças/<slug>/evidencia.json; exit 1 if a critical sensor is red.
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseTasks, activeChange } from '../hooks/change-core.mjs';
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

  // Same rule as the archive gate: evidence carries severity, so evaluateGate blocks
  // only on critical/missing — a red warning is advisory and passes verify.
  const { ok, failing } = evaluateGate(evidence, ids);
  for (const e of evidence) {
    const mark = e.status === 'green' ? '✓' : (e.severity === 'warning' ? '!' : '✗');
    process.stdout.write(`  ${mark} ${e.id}${e.severity === 'warning' && e.status === 'red' ? ' (warning)' : ''}\n`);
  }
  if (!ok) { process.stderr.write(`verify: critical sensors red: ${failing.join(', ')}\n`); process.exit(1); }
  process.stdout.write(`verify OK (${ids.length} sensor(s))\n`);
  process.exit(0);
}
