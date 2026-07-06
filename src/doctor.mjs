// `wendkeep doctor` — vault/session integrity (hooks/vault-health.mjs) PLUS the a2
// harness integrity check (hooks/harness-doctor.mjs). Exits 1 on any error.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHarness } from '../hooks/harness-doctor.mjs';

export function runDoctor(argv) {
  const here = dirname(fileURLToPath(import.meta.url));
  const hookFile = join(here, '..', 'hooks', 'vault-health.mjs');

  let vault;
  let project;
  const passthrough = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--vault') vault = argv[++i];
    else if (a.startsWith('--vault=')) vault = a.slice(8);
    else if (a === '--project') project = argv[++i];
    else if (a.startsWith('--project=')) project = a.slice(10);
    else passthrough.push(a);
  }

  const env = { ...process.env };
  if (vault) env.OBSIDIAN_VAULT_PATH = isAbsolute(vault) ? vault : resolve(process.cwd(), vault);
  if (!env.OBSIDIAN_VAULT_PATH) {
    process.stderr.write('wendkeep doctor: no vault. Pass --vault <path> or set OBSIDIAN_VAULT_PATH.\n');
    process.exit(2);
  }
  const vaultBase = env.OBSIDIAN_VAULT_PATH;
  const projectRoot = resolve(project || process.cwd());

  // 1. Session/vault integrity (existing check).
  let healthStatus = 0;
  if (existsSync(hookFile)) {
    const r = spawnSync(process.execPath, [hookFile, ...passthrough], { stdio: 'inherit', env });
    healthStatus = r.status ?? 0;
  }

  // 2. Harness integrity (Wave B).
  const { errors, warnings } = checkHarness(vaultBase, projectRoot);
  process.stdout.write(`\n[harness] ${errors.length} erro(s), ${warnings.length} aviso(s)\n`);
  for (const e of errors) process.stdout.write(`  ✗ ${e}\n`);
  for (const w of warnings) process.stdout.write(`  ! ${w}\n`);

  process.exit(healthStatus !== 0 || errors.length ? 1 : 0);
}
