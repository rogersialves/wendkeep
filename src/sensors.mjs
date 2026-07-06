// `wendkeep sensors list` — read-only view over wendkeep.sensors.json (0.7.0).
import { resolve } from 'node:path';
import { loadSensors } from '../hooks/sensors-core.mjs';

export function runSensors(argv) {
  const [sub, ...rest] = argv;
  if (sub !== 'list') {
    process.stderr.write(`wendkeep sensors: unknown subcommand "${sub}". Known: list.\n`);
    process.exit(2);
  }
  let project;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--project') project = rest[++i];
    else if (rest[i].startsWith('--project=')) project = rest[i].slice(10);
  }
  const projectRoot = resolve(project || process.cwd());
  const sensors = loadSensors(projectRoot);
  if (!sensors.length) { process.stdout.write('sensors: (nenhum — crie wendkeep.sensors.json na raiz)\n'); process.exit(0); }
  for (const s of sensors) {
    process.stdout.write(`${s.id}: ${s.type || 'command'} · ${s.severity || 'critical'} · ${s.command}\n`);
  }
  process.exit(0);
}
