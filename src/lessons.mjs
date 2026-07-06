// `wendkeep lesson add "<trigger>" "<lesson>"` — record a project-local lesson (Wave B).
// The wk-verify / wk-debugging skills call this when a verification fails.
import { isAbsolute, resolve } from 'node:path';
import { addLesson } from '../hooks/lessons-core.mjs';

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

export function runLesson(argv) {
  const [sub, ...rest] = argv;
  if (sub !== 'add') {
    process.stderr.write(`wendkeep lesson: unknown "${sub}". Use: lesson add "<trigger>" "<lesson>"\n`);
    process.exit(2);
  }
  const vaultRaw = opt(rest, '--vault') || process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultRaw) { process.stderr.write('wendkeep lesson: no vault (--vault or OBSIDIAN_VAULT_PATH).\n'); process.exit(2); }
  const vaultBase = isAbsolute(vaultRaw) ? vaultRaw : resolve(process.cwd(), vaultRaw);

  const positional = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--vault' && rest[i - 1] !== '--change');
  const [trigger, lesson] = positional;
  if (!trigger || !lesson) { process.stderr.write('wendkeep lesson add: precisa "<trigger>" "<lesson>"\n'); process.exit(2); }

  const p = addLesson(vaultBase, { trigger, lesson, sourceChange: opt(rest, '--change') || '', dateStr: today() });
  process.stdout.write(`lesson: ${p}\n`);
  process.exit(0);
}
