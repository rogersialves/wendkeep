// `wendkeep doctor` — vault/session integrity (hooks/vault-health.mjs) PLUS the a2
// harness integrity check (hooks/harness-doctor.mjs). Exits 1 on any error.
import { resolve } from 'node:path';
import { checkHarness, checkVaultLinks, checkSessionActivity, checkStackedFrontmatter, renderStackedFrontmatterLines, checkUnpricedModels, renderUnpricedModelLines, checkStaleDerivedSections, renderStaleDerivedSectionLines, checkSessionObservability, renderSessionObservabilityLines } from '../hooks/harness-doctor.mjs';
import { runVaultHealth } from '../hooks/vault-health.mjs';
import { checkSyncDefs } from './sync-defs.mjs';
import { resolveProjectVault } from './project-vault.mjs';

const healthStatusLabel = (status) => ({
  healthy: 'saudável', warning: 'atenção', blocked: 'bloqueada', legacy: 'legado',
}[status] || status || 'desconhecido');

const metricValue = (value) => value === null || value === undefined || value === '' ? 'n/a' : value;

export function renderVaultHealthLines(result) {
  const memoryFailures = [];
  const memoryWarnings = [];
  const integrityFailures = [];
  const integrityWarnings = [];
  for (const failure of result.failures || []) {
    const match = String(failure).match(/^Memória:\s*(.*)$/s);
    (match ? memoryFailures : integrityFailures).push(match ? match[1] : failure);
  }
  for (const warning of result.warnings || []) {
    const match = String(warning).match(/^Memória:\s*(.*)$/s);
    (match ? memoryWarnings : integrityWarnings).push(match ? match[1] : warning);
  }

  const lines = [
    `[integridade] ${integrityFailures.length ? 'bloqueada' : integrityWarnings.length ? 'atenção' : 'saudável'} — ${integrityFailures.length} falha(s), ${integrityWarnings.length} aviso(s)`,
  ];
  for (const failure of integrityFailures) lines.push(`  ✗ ${failure}`);
  for (const warning of integrityWarnings) lines.push(`  ! ${warning}`);
  if (!integrityFailures.length && !integrityWarnings.length) lines.push('  ✓ sessão e artefatos íntegros');
  lines.push(`  sessão: ${result.session || 'nenhuma'} · registros: ${metricValue(result.metrics?.registrySessions)} · notas derivadas: ${metricValue(result.metrics?.derivedNotes)}`);

  const memory = result.metrics?.memory || {};
  lines.push(
    `[memória] ${healthStatusLabel(result.memoryStatus)} — schema: ${metricValue(memory.schemaVersion)} · revisão: ${metricValue(memory.revision)} · cursor: ${metricValue(memory.eventCursor)} · hash: ${metricValue(memory.stateHash)}`,
  );
  lines.push(`  ledger: ${metricValue(memory.ledgerEvents)} evento(s) · outbox: ${metricValue(memory.pendingOutbox)} · candidates: ${metricValue(memory.candidates)} · conflitos: ${metricValue(memory.activeConflicts)}`);
  const semanticKeys = memory.semanticActiveKeys || [];
  const semanticProjected = memory.semanticProjectedKeys || [];
  const semanticMissing = memory.semanticMissingKeys || [];
  lines.push(`  semântica: ${metricValue(memory.semanticCode)} · ativas: ${semanticKeys.length} [${semanticKeys.join(', ')}] · projetadas: ${semanticProjected.length} · ausentes: ${semanticMissing.length}`);
  for (const failure of memoryFailures) lines.push(`  ✗ ${failure}`);
  for (const warning of memoryWarnings) lines.push(`  ! ${warning}`);
  if (result.memoryStatus === 'healthy' && !memoryFailures.length && !memoryWarnings.length) {
    lines.push('  ✓ bundle de memória íntegro');
  }
  return lines;
}

export function runDoctor(argv) {
  let vault;
  let project;
  let session = '';
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--vault') vault = argv[++i];
    else if (a.startsWith('--vault=')) vault = a.slice(8);
    else if (a === '--project') project = argv[++i];
    else if (a.startsWith('--project=')) project = a.slice(10);
    else if (a === '--session') session = argv[++i] || '';
    else if (a.startsWith('--session=')) session = a.slice(10);
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
    return 2;
  }
  const vaultBase = resolution.base;
  process.stdout.write(`[vault] ${resolution.source}: ${vaultBase} (project: ${projectRoot})\n`);
  if (resolution.source === 'legacy-project-settings') {
    process.stdout.write('  ! migração pendente: rode `wendkeep init --project . --vault "<vault>" --yes` para criar .wendkeep.json\n');
  }

  // 1. Session/vault integrity. The standalone hook remains JSON; doctor renders it for humans.
  let health;
  try {
    health = runVaultHealth({ vaultBase, session });
  } catch (error) {
    health = {
      ok: false,
      session,
      failures: [`Vault health falhou: ${error?.message || error}`],
      warnings: [],
      metrics: { memory: {} },
      memoryStatus: 'blocked',
    };
  }
  process.stdout.write(`${renderVaultHealthLines(health).join('\n')}\n`);
  const healthStatus = health.ok ? 0 : 1;

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

  // 3c. Modelo fora de pricing.json fecha a sessão com custo zero, sem erro — só aparece aqui.
  process.stdout.write(`\n${renderUnpricedModelLines(checkUnpricedModels(vaultBase)).join('\n')}\n`);

  // 3d. Seções derivadas do corpo que ficaram para trás do Encerramento (notas pré-0.53.0).
  process.stdout.write(`\n${renderStaleDerivedSectionLines(checkStaleDerivedSections(vaultBase)).join('\n')}\n`);

  // 3e. Observabilidade materializada: schema vigente não basta sem frontier + manifest frescos.
  process.stdout.write(`\n${renderSessionObservabilityLines(checkSessionObservability(vaultBase)).join('\n')}\n`);

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

  // Devolve o código em vez de sair: `wendkeep sync` encadeia este comando, e um
  // process.exit aqui mataria a cadeia. Quem faz o exit é o bin.
  return healthStatus !== 0 || errors.length ? 1 : 0;
}
