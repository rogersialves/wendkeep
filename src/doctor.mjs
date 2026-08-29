// `wendkeep doctor` — vault/session integrity (hooks/vault-health.mjs) PLUS the a2
// harness integrity check (hooks/harness-doctor.mjs). Exits 1 on any error.
import { resolve } from 'node:path';
import { checkHarness, checkVaultLinks, checkSessionActivity, checkStackedFrontmatter, renderStackedFrontmatterLines, checkUnpricedModels, renderUnpricedModelLines, checkStaleDerivedSections, renderStaleDerivedSectionLines, checkSessionObservability, renderSessionObservabilityLines } from '../hooks/harness-doctor.mjs';
import { diagnoseManagedWorktrees } from './worktree.mjs';
import { runVaultHealth } from '../hooks/vault-health.mjs';
import {
  inspectEvidenceSearchHealth,
  renderEvidenceSearchHealthLines,
} from './evidence-search-health.mjs';
import { augmentVaultHealthWithMemoryScale } from './memory-scale-health.mjs';
import { checkSyncDefs } from './sync-defs.mjs';
import { resolveProjectVault } from './project-vault.mjs';
import { inspectObserverSqlOutbox } from './observer-sql-publish.mjs';
import {
  inspectActiveContextHealth,
  renderActiveContextHealthLines,
} from './active-context-health.mjs';
import { inspectPortableState } from './portable.mjs';
import { inspectSyncOutbox, readLocalSyncState } from './sync-outbox.mjs';
import { readProjectForValidation } from '../packages/vault/src/validate-memory.mjs';
import { inspectGitCommitHooks } from './git-commit-hooks.mjs';

const healthStatusLabel = (status) => ({
  healthy: 'saudável', warning: 'atenção', degraded: 'degradada', blocked: 'bloqueada', legacy: 'legado',
}[status] || status || 'desconhecido');

const artifactStatusLabel = (status) => ({
  ok: 'saudável', healthy: 'saudável', warning: 'atenção', degraded: 'degradado',
  missing: 'ausente', empty: 'vazio', invalid: 'inválido', corrupt: 'corrompido',
  blocked: 'bloqueado', unknown: 'desconhecido',
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
  const repairableHandoffs = Number(memory.repairableHandoffs || 0);
  lines.push(`  ledger: ${metricValue(memory.ledgerEvents)} evento(s) · outbox: ${metricValue(memory.pendingOutbox)} · candidates: ${metricValue(memory.candidates)} · conflitos: ${metricValue(memory.activeConflicts)}${repairableHandoffs ? ` · handoffs reparáveis: ${repairableHandoffs}` : ''}`);
  if (memory.scaleSchemaVersion === 1) {
    lines.push(
      `  replay: snapshot ${artifactStatusLabel(memory.snapshotStatus)} · cobertos: ${metricValue(memory.snapshotEvents)} evento(s) · tail: ${metricValue(memory.snapshotTailEvents)} evento(s)/${metricValue(memory.snapshotTailBytes)} bytes · ledger no snapshot: ${metricValue(memory.snapshotLedgerBytes)} bytes`,
    );
    if (memory.snapshotReason) lines.push(`    ↳ snapshot: ${memory.snapshotReason}`);
    lines.push(
      `  segmentos: ${artifactStatusLabel(memory.segmentStatus)} · ${metricValue(memory.segmentCount)} segmento(s) · cobertos: ${metricValue(memory.segmentCoveredEvents)} evento(s)/${metricValue(memory.segmentCoveredBytes)} bytes · pendentes: ${metricValue(memory.segmentPendingEvents)}`,
    );
    lines.push(
      `  rotação: geração ${artifactStatusLabel(memory.generationStatus)} #${metricValue(memory.generation)} · origem: ${metricValue(memory.generationSourceEvents)} · tail ativo: ${metricValue(memory.generationActiveTailEvents)} · journal: ${artifactStatusLabel(memory.rotationJournal)} · receipts: ${metricValue(memory.rotationReceipts)} (${artifactStatusLabel(memory.rotationReceiptCheckpoint)})`,
    );
    if (memory.scaleErrorCode) lines.push(`    ↳ escala: ${memory.scaleErrorCode}`);
  }
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
  let scope = 'all';
  let strict = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--vault') vault = argv[++i];
    else if (a.startsWith('--vault=')) vault = a.slice(8);
    else if (a === '--project') project = argv[++i];
    else if (a.startsWith('--project=')) project = a.slice(10);
    else if (a === '--session') session = argv[++i] || '';
    else if (a.startsWith('--session=')) session = a.slice(10);
    else if (a === '--scope') scope = argv[++i] || '';
    else if (a.startsWith('--scope=')) scope = a.slice(8);
    else if (a === '--strict') strict = true;
  }
  if (!['all', 'core', 'runtime'].includes(scope)) {
    process.stderr.write('wendkeep doctor: --scope deve ser all, core ou runtime\n');
    return 2;
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
    health = augmentVaultHealthWithMemoryScale(
      runVaultHealth({ vaultBase, session }),
      vaultBase,
    );
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
  const recall = scope === 'runtime'
    ? { status: 'skipped' }
    : inspectEvidenceSearchHealth(vaultBase);
  if (scope !== 'runtime') {
    process.stdout.write(`${renderVaultHealthLines(health).join('\n')}\n`);
    process.stdout.write(`${renderEvidenceSearchHealthLines(recall).join('\n')}\n`);
  }
  const healthStatus = health.ok ? 0 : 1;
  const recallStatus = recall.status === 'blocked' ? 1 : 0;

  if (scope === 'core') {
    const strictDebt = strict && (
      (health.warnings || []).length > 0
      || !['healthy'].includes(health.memoryStatus)
      || !['healthy', 'missing'].includes(recall.status)
    );
    process.stdout.write(`\n[core] ${healthStatus || recallStatus ? 'erro estrutural' : health.memoryStatus === 'degraded' ? 'saudável com memória degradada' : 'saudável'}\n`);
    return healthStatus || recallStatus || strictDebt ? 1 : 0;
  }

  // 2. Harness integrity (Wave B).
  const { errors, warnings, attention, repairable } = checkHarness(vaultBase, projectRoot);
  const defs = checkSyncDefs(vaultBase, projectRoot);
  if (!defs.ok) {
    repairable.push(...defs.issues.map((issue) => `defs: ${issue}`));
    repairable.push('defs stale — rode `wendkeep sync-defs --reseed` e reinicie Claude Code/Codex');
  }
  process.stdout.write(`\n[runtime] ${errors.length} erro(s) estrutural(is), ${attention.length} atenção(ões), ${repairable.length} reparável(is), ${warnings.length} aviso(s)\n`);
  for (const e of errors) process.stdout.write(`  ✗ ${e}\n`);
  for (const item of attention) process.stdout.write(`  ! ${item}\n`);
  for (const item of repairable) process.stdout.write(`  → ${item}\n`);
  for (const w of warnings) process.stdout.write(`  ! ${w}\n`);

  const worktrees = diagnoseManagedWorktrees({ startDir: projectRoot });
  process.stdout.write(`\n[worktrees] ${worktrees.initialized ? `${worktrees.issues.length} problema(s)` : 'não inicializado'}\n`);
  for (const issue of worktrees.issues) {
    process.stdout.write(`  → ${issue.slug}: ${issue.errorCode} — ${issue.repair}\n`);
  }

  const commitHooks = inspectGitCommitHooks({ projectRoot });
  process.stdout.write(`\n[commit-hooks] ${commitHooks.status}\n`);
  for (const issue of commitHooks.issues) process.stdout.write(`  ! ${issue}\n`);
  if (commitHooks.repair) process.stdout.write(`  → ${commitHooks.repair}\n`);

  const activeContexts = inspectActiveContextHealth({ vaultBase, projectRoot });
  process.stdout.write(`\n${renderActiveContextHealthLines(activeContexts).join('\n')}\n`);

  const portable = inspectPortableState({ vaultBase, projectRoot });
  process.stdout.write(`\n[portable] ${portable.status}${portable.issues.length ? ` — ${portable.issues.length} divergência(s)` : ''}\n`);
  if (portable.status === 'diverged') process.stdout.write('  → wendkeep portable diff; revise e rode `wendkeep portable export`\n');
  if (portable.status === 'invalid') process.stdout.write(`  ✗ ${portable.issues.join(', ')}\n`);

  const sync = inspectSyncOutbox(vaultBase);
  let syncConflicts = 0;
  if (sync.status !== 'disabled' && sync.status !== 'corrupt') {
    try {
      const projectIdentity = readProjectForValidation(vaultBase);
      const syncState = readLocalSyncState(vaultBase, resolution.projectId || projectIdentity.projectId || 'unknown');
      syncConflicts = Object.values(syncState.conflicts || {}).filter((item) => item?.status === 'open').length;
    } catch {
      sync.status = 'corrupt';
      sync.code = 'WENDKEEP_SYNC_STATE_CORRUPT';
    }
  }
  process.stdout.write(`\n[sync] ${sync.status} · ${sync.pending} pendente(s) · ${syncConflicts} conflito(s) aberto(s)\n`);
  if (sync.status === 'pending') process.stdout.write('  → wendkeep sync push --remote <diretório> (ou --url <endpoint>)\n');
  if (sync.status === 'corrupt') process.stdout.write(`  ✗ ${sync.code || 'WENDKEEP_SYNC_OUTBOX_CORRUPT'}\n`);
  if (syncConflicts) process.stdout.write('  → wendkeep sync conflicts; resolva cada conflito explicitamente\n');

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
  const unpriced = checkUnpricedModels(vaultBase);
  process.stdout.write(`\n${renderUnpricedModelLines(unpriced).join('\n')}\n`);

  // 3d. Seções derivadas do corpo que ficaram para trás do Encerramento (notas pré-0.53.0).
  const staleDerived = checkStaleDerivedSections(vaultBase);
  process.stdout.write(`\n${renderStaleDerivedSectionLines(staleDerived).join('\n')}\n`);

  // 3e. Observabilidade materializada: schema vigente não basta sem frontier + manifest frescos.
  const observability = checkSessionObservability(vaultBase);
  process.stdout.write(`\n${renderSessionObservabilityLines(observability).join('\n')}\n`);
  const observerOutbox = inspectObserverSqlOutbox(vaultBase);
  const oldestSeconds = Math.round(observerOutbox.oldest_age_ms / 1000);
  process.stdout.write(`[observer] outbox SQL: ${observerOutbox.batches} lote(s) · ${observerOutbox.events} evento(s) · ${observerOutbox.bytes} bytes${observerOutbox.batches ? ` · mais antigo: ${oldestSeconds}s` : ''}\n`);
  if (observerOutbox.batches) process.stdout.write('  → wendkeep observer reconcile --project . (ou inicie o servidor para o hook drenar a fila)\n');

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
  const strictDebt = strict && (
    (scope !== 'runtime' && (health.warnings || []).length)
    || (scope !== 'runtime' && health.memoryStatus !== 'healthy')
    || (scope !== 'runtime' && !['healthy', 'missing'].includes(recall.status))
    || attention.length
    || repairable.length
    || warnings.length
    || worktrees.issues.length
    || (commitHooks.configured && commitHooks.status !== 'healthy')
    || activeContexts.issues.length
    || ['diverged', 'invalid'].includes(portable.status)
    || sync.status === 'corrupt'
    || syncConflicts
    || links.derivedOrphans
    || links.artifactOrphans
    || links.graphColors === false
    || stacked.count
    || (unpriced.models || unpriced.items || []).length
    || (staleDerived.notes || staleDerived.items || []).length
    || !observability.ok
  );
  return (scope !== 'runtime' && (healthStatus !== 0 || recallStatus !== 0)) || errors.length || strictDebt ? 1 : 0;
}
