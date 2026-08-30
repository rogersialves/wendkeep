import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scope = process.argv[2] || 'all';
if (!['all', 'core', 'observer'].includes(scope)) {
  process.stderr.write(`Escopo de teste desconhecido: ${scope}. Use all, core ou observer.\n`);
  process.exit(2);
}

const tests = readdirSync(join(root, 'tests'))
  .filter((name) => name.endsWith('.test.mjs'))
  .filter((name) => scope !== 'core' || !name.startsWith('observer-'))
  .filter((name) => scope !== 'observer' || name.startsWith('observer-'))
  .sort()
  .map((name) => join('tests', name));

const result = spawnSync(process.execPath, ['--test', '--test-concurrency=2', ...tests], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
