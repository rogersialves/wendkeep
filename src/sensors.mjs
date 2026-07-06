// `wendkeep sensors <list|add>` — view/edit wendkeep.sensors.json (0.7.0 / 0.9.0).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadSensors } from '../hooks/sensors-core.mjs';

const SCHEMA = 'https://raw.githubusercontent.com/rogersialves/wendkeep/main/schema/wendkeep.sensors.schema.json';

function opt(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

function resolveProject(rest) {
  return resolve(opt(rest, '--project') || process.cwd());
}

export function runSensors(argv) {
  const [sub, ...rest] = argv;

  if (sub === 'list') {
    const sensors = loadSensors(resolveProject(rest));
    if (!sensors.length) { process.stdout.write('sensors: (nenhum — crie wendkeep.sensors.json na raiz)\n'); process.exit(0); }
    for (const s of sensors) process.stdout.write(`${s.id}: ${s.type || 'command'} · ${s.severity || 'critical'} · ${s.command}\n`);
    process.exit(0);
  }

  if (sub === 'add') {
    const flags = new Set(['--severity', '--type', '--report', '--name', '--description', '--project']);
    const positional = rest.filter((a, i) => !a.startsWith('--') && !flags.has(rest[i - 1]));
    const [id, command] = positional;
    if (!id || !command) { process.stderr.write('wendkeep sensors add: precisa <id> "<command>"\n'); process.exit(2); }
    const projectRoot = resolveProject(rest);
    const path = join(projectRoot, 'wendkeep.sensors.json');
    let cfg = { $schema: SCHEMA, version: 1, source: 'manual', sensors: [] };
    if (existsSync(path)) {
      try { cfg = JSON.parse(readFileSync(path, 'utf8')); } catch { process.stderr.write('wendkeep sensors add: wendkeep.sensors.json inválido\n'); process.exit(2); }
      if (!Array.isArray(cfg.sensors)) cfg.sensors = [];
      if (!cfg.$schema) cfg.$schema = SCHEMA;
    }
    if (cfg.sensors.some((s) => s.id === id)) { process.stderr.write(`wendkeep sensors add: sensor "${id}" já existe\n`); process.exit(2); }
    const severity = opt(rest, '--severity') === 'warning' ? 'warning' : 'critical';
    const type = opt(rest, '--type') === 'mutation' ? 'mutation' : 'command';
    const sensor = { id, name: opt(rest, '--name') || id, description: opt(rest, '--description') || command, severity, type, command };
    if (type === 'mutation') sensor.report = opt(rest, '--report') || 'reports/mutation/mutation.json';
    cfg.sensors.push(sensor);
    writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    process.stdout.write(`sensor added: ${id} (${type} · ${severity})\n`);
    process.exit(0);
  }

  process.stderr.write(`wendkeep sensors: unknown subcommand "${sub}". Known: list, add.\n`);
  process.exit(2);
}
