// `wendkeep doctor` — run the bundled vault-health check against a vault.
// Resolves the vault from --vault or the OBSIDIAN_VAULT_PATH env var, then runs
// hooks/vault-health.mjs (which reads getVaultBase()).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function runDoctor(argv) {
  const here = dirname(fileURLToPath(import.meta.url));
  const hookFile = join(here, '..', 'hooks', 'vault-health.mjs');
  if (!existsSync(hookFile)) {
    process.stderr.write(`wendkeep doctor: vault-health.mjs not found at ${hookFile}\n`);
    process.exit(2);
  }

  let vault;
  const passthrough = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--vault') vault = argv[++i];
    else if (a.startsWith('--vault=')) vault = a.slice(8);
    else passthrough.push(a);
  }

  const env = { ...process.env };
  if (vault) env.OBSIDIAN_VAULT_PATH = isAbsolute(vault) ? vault : resolve(process.cwd(), vault);

  if (!env.OBSIDIAN_VAULT_PATH) {
    process.stderr.write('wendkeep doctor: no vault. Pass --vault <path> or set OBSIDIAN_VAULT_PATH.\n');
    process.exit(2);
  }

  const r = spawnSync(process.execPath, [hookFile, ...passthrough], { stdio: 'inherit', env });
  process.exit(r.status ?? 0);
}
