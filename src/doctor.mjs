// `wendkeep doctor` — vault/session integrity (hooks/vault-health.mjs) PLUS the a2
// harness integrity check (hooks/harness-doctor.mjs). Exits 1 on any error.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHarness, checkVaultLinks, checkSessionActivity, checkStackedFrontmatter, renderStackedFrontmatterLines } from '../hooks/harness-doctor.mjs';
import { checkSyncDefs } from './sync-defs.mjs';
import { resolveProjectVault } from './project-vault.mjs';

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

  const projectRoot = resolve(project || process.cwd());
  let resolution;
  try {
    resolution = resolveProjectVault({
      startDir: projectRoot,
      explicitVault: vault || '',
      validateIdentity: !vault,
    });
  } catch (error) {
    process.stderr.write(`wendkeep doctor: ${error.message}\n`);
    process.exit(2);
  }
  const vaultBase = resolution.base;
  process.stdout.write(`[vault] ${resolution.source}: ${vaultBase} (project: ${projectRoot})\n`);
  if (resolution.source === 'legacy-project-settings') {
    process.stdout.write('  ! migração pendente: rode `wendkeep init --project . --vault "<vault>" --yes` para criar .wendkeep.json\n');
  }

  // 1. Session/vault integrity (existing check).
  let healthStatus = 0;
  if (existsSync(hookFile)) {
    const r = spawnSync(process.execPath, [hookFile, ...passthrough, '--vault', vaultBase], { stdio: 'inherit' });
    healthStatus = r.status ?? 0;
  }

  // 2. Harness integrity (Wave B).
  const { errors, warnings } = checkHarness(vaultBase, projectRoot);
  const defs = checkSyncDefs(vaultBase, projectRoot);
  if (!defs.ok) {
    warnings.push(...defs.issues.map((issue) => `defs: ${issue}`));
    warnings.push('defs stale — rode `wendkeep sync-defs --reseed` e reinicie Claude Code/Codex');
  }
  process.stdout.write(`\n[harness] ${errors.length} erro(s), ${warnings.length} aviso(s)\n`);
  for (const e of errors) process.stdout.write(`  ✗ ${e}\n`);
  for (const w of warnings) process.stdout.write(`  ! ${w}\n`);

  // 3. Link/graph health — órfãos que o grafo do Obsidian mostraria, com o comando de reparo.
  const links = checkVaultLinks(vaultBase);
  const graphLabel = links.graphColors === true ? 'com cores' : links.graphColors === false ? 'sem cores' : 'sem graph.json';
  process.stdout.write(`\n[links] ${links.derivedOrphans} derivada(s) órfã(s) · ${links.artifactOrphans} artefato(s) órfão(s) · grafo: ${graphLabel}\n`);
  if (links.derivedOrphans) process.stdout.write('  → wendkeep note relink --apply\n');
  if (links.artifactOrphans) process.stdout.write('  → wendkeep change backlink --apply\n');
  if (links.graphColors === false) process.stdout.write('  → wendkeep theme sync (feche o Obsidian antes)\n');
  if (!links.derivedOrphans && !links.artifactOrphans && links.graphColors !== false) process.stdout.write('  grafo conectado ✓\n');

  // 3b. Notas de sessão com frontmatter empilhado — dano de escrita concorrente (pré-lock).
  const stacked = checkStackedFrontmatter(vaultBase);
  process.stdout.write(`\n${renderStackedFrontmatterLines(vaultBase, stacked).join('\n')}\n`);

  // 4. Sessão: não mente "inativa" quando há atividade recente (workflow/subagente em background).
  const act = checkSessionActivity(vaultBase);
  if (act.lastSession) {
    const label = act.active
      ? 'ativa'
      : act.backgroundSuspected
        ? `inativa no control, mas escrita há ${Math.round((act.ageMs || 0) / 1000)}s — possível workflow/subagente em background`
        : 'inativa';
    process.stdout.write(`[sessão] última: ${act.lastSession} (${label})\n`);
  }

  process.exit(healthStatus !== 0 || errors.length ? 1 : 0);
}
