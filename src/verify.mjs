// `wendkeep verify [--change <slug>]` — run a change's task sensors, record evidence.
// Sensors run at the PROJECT root (--project or cwd); the change + evidence live in
// the VAULT. Writes 08-Mudanças/<slug>/evidencia.json; exit 1 if a critical sensor is red.
import { readFileSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseTasks, activeChange, appendFixTasks, healSpecBacklinks } from '../hooks/change-core.mjs';
import { buildTaskContractSnapshot, evaluateTaskContracts } from './task-contracts.mjs';
import {
  loadSensorsDetailed,
  findProjectRoot,
  requiredSensors,
  runSensors,
  evaluateGate,
  sensorProcessEnv,
} from '../hooks/sensors-core.mjs';
import {
  buildEffectiveRequirementPackage,
  captureSpecBaseline,
  formatOrphanReqs,
  tasksHashOf,
} from '../hooks/spec-core.mjs';
import { addLesson } from '../hooks/lessons-core.mjs';
import { getLocale } from '../hooks/locale.mjs';
import { resolveCommandActiveContext } from './active-context-runtime.mjs';
import { writeVaultFileAtomic } from '../packages/vault/src/vault-path-safety.mjs';
import { evidenceCheckoutBinding } from '../packages/vault/src/evidence-envelope.mjs';
import {
  assertStableHead,
  buildEvidenceEnvelope,
  captureGitSnapshot,
  resolveEvidenceIdentity,
  sensorConfigSha256,
} from './evidence-envelope.mjs';

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function opt(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

export function createChangeAuthorityWriter(vaultBase, changeDir, {
  writeAtomic = writeVaultFileAtomic,
  beforeRename,
} = {}) {
  return (file, content) => writeAtomic(
    vaultBase,
    join(changeDir, file),
    content,
    'utf8',
    {
      scopeRoot: changeDir,
      label: `artefato de evidência ${file}`,
      ...(beforeRename ? { beforeRename: (details) => beforeRename({ file, ...details }) } : {}),
    },
  );
}

export function runVerify(argv) {
  const vaultRaw = opt(argv, '--vault') || process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultRaw) { process.stderr.write('wendkeep verify: no vault (--vault or OBSIDIAN_VAULT_PATH).\n'); process.exit(2); }
  const vaultBase = isAbsolute(vaultRaw) ? vaultRaw : resolve(process.cwd(), vaultRaw);
  // --project wins; otherwise climb from cwd to the nearest project marker (agent shells
  // keep their cwd across commands, so verify from a subdirectory is a recurring miss).
  const projectRoot = resolve(opt(argv, '--project') || findProjectRoot(process.cwd()) || process.cwd());
  const requestedSession = opt(argv, '--session') || process.env.CODEX_THREAD_ID || process.env.CLAUDE_SESSION_ID || '';
  let commandContext = null;
  try {
    commandContext = resolveCommandActiveContext({
      vaultBase,
      projectRoot,
      sessionId: requestedSession,
    });
  } catch (error) {
    process.stderr.write(`wendkeep verify: ${error.code || 'WENDKEEP_ACTIVE_CONTEXT_FAILED'}: ${error.message}\n`);
    process.exit(2);
  }
  const slug = opt(argv, '--change') || activeChange(vaultBase, { context: commandContext });
  if (!slug) { process.stderr.write('wendkeep verify: no change (--change or active).\n'); process.exit(2); }

  const changeDir = join(vaultBase, getLocale(vaultBase).folders.changes, slug);
  const writeAuthority = createChangeAuthorityWriter(vaultBase, changeDir);
  let tarefas = '';
  try { tarefas = readFileSync(join(changeDir, 'tarefas.md'), 'utf8'); }
  catch { process.stderr.write(`wendkeep verify: change not found: ${slug}\n`); process.exit(2); }

  // Backlink dos specs escritos à mão pro hub proposta (grafo conectado). Idempotente, fail-quiet.
  try { healSpecBacklinks(changeDir, vaultBase); } catch { /* heal é bônus */ }

  const tasks = parseTasks(tarefas);
  const ids = requiredSensors(tasks);
  const loaded = loadSensorsDetailed(projectRoot);
  if (loaded.error) {
    process.stderr.write(`wendkeep verify: wendkeep.sensors.json inválido em ${loaded.path}: ${loaded.error}\n`);
    process.exit(2);
  }
  if (loaded.missing && ids.length) {
    process.stderr.write(`wendkeep verify: wendkeep.sensors.json não encontrado em ${loaded.path} — rode da raiz do projeto ou use --project <raiz>\n`);
  }
  const sensors = loaded.sensors;
  const reqIds = [...new Set(tasks.flatMap((task) => task.reqs ?? []))];
  const effective = buildEffectiveRequirementPackage(vaultBase, changeDir, reqIds);
  const tasksHash = tasksHashOf(tarefas);
  const startedAt = new Date().toISOString();
  let startSnapshot;
  let identity;
  try {
    startSnapshot = captureGitSnapshot(projectRoot);
    identity = resolveEvidenceIdentity({
      vaultBase,
      projectRoot,
      changeSlug: slug,
      sessionId: requestedSession,
      context: commandContext,
    });
  } catch (error) {
    process.stderr.write(`wendkeep verify: ${error.code || 'WENDKEEP_EVIDENCE_BINDING_FAILED'}: ${error.message}\n`);
    process.exit(2);
  }
  const evidence = runSensors(sensors, ids, {
    cwd: projectRoot,
    env: sensorProcessEnv(vaultBase),
  });
  let finishSnapshot;
  try {
    finishSnapshot = captureGitSnapshot(projectRoot);
    assertStableHead(startSnapshot, finishSnapshot);
  } catch (error) {
    process.stderr.write(`wendkeep verify: ${error.code || 'WENDKEEP_EVIDENCE_BINDING_FAILED'}: ${error.message}\n`);
    process.exit(2);
  }
  const envelope = buildEvidenceEnvelope({
    identity,
    changeSlug: slug,
    snapshot: startSnapshot,
    tasksSha256: tasksHash,
    effectiveSpecSha256: `sha256:${effective.hash}`,
    sensorConfigSha256: sensorConfigSha256(sensors, ids),
    sensors: evidence,
    startedAt,
    finishedAt: new Date().toISOString(),
  });
  writeAuthority('evidencia.json', `${JSON.stringify(envelope, null, 2)}\n`);
  // Freshness seal: bind this evidence to the tarefas.md it was produced against, so the archive
  // gate can reject evidence gone stale (a sensor task added after this verify run).
  writeAuthority('.evidence-hash', tasksHash);

  // Mutation survivors -> fix tasks (Wave B), bounded at 3 rounds then escalate. A surviving
  // mutant always fails verify (exit 1): the suite does not discriminate yet. A clean report
  // resets the round counter so a future survivor starts a fresh cycle.
  const withSurvivors = evidence.filter((e) => e.survivors && e.survivors.length);
  const roundFile = join(changeDir, '.mutation-round');
  if (!withSurvivors.length) {
    try { unlinkSync(roundFile); } catch { /* nunca houve rodada */ }
  } else {
    let round = 0;
    try { round = Number(readFileSync(roundFile, 'utf8').trim()) || 0; } catch { /* first round */ }
    if (round >= 3) {
      process.stderr.write('verify: mutantes ainda sobrevivem após 3 rodadas — revise os testes à mão.\n');
      const flat = withSurvivors.flatMap((e) => e.survivors.map((s) => `${s.file}:${s.line}`));
      try {
        addLesson(vaultBase, {
          trigger: `mutantes persistentes em ${slug}`,
          lesson: `3 rodadas de fix-tasks não mataram: ${flat.join(', ')} — os testes desses pontos não discriminam.`,
          sourceChange: slug,
          dateStr: today(),
        });
      } catch { /* lesson é bônus, nunca derruba o verify */ }
    } else {
      let added = 0;
      for (const e of withSurvivors) added += appendFixTasks(changeDir, e.survivors, e.id);
      writeAuthority('.mutation-round', String(round + 1));
      process.stdout.write(`verify: ${added} fix-task(s) de mutação (rodada ${round + 1}/3)\n`);
    }
    process.stderr.write('verify: mutantes sobreviventes — a suíte não discrimina ainda.\n');
    process.exit(1);
  }

  // Same rule as the archive gate: evidence carries severity, so evaluateGate blocks
  // only on critical/missing — a red warning is advisory and passes verify.
  const { ok, failing } = evaluateGate(evidence, ids);
  for (const e of evidence) {
    const mark = e.status === 'green' ? '✓' : (e.severity === 'warning' ? '!' : '✗');
    process.stdout.write(`  ${mark} ${e.id}${e.severity === 'warning' && e.status === 'red' ? ' (warning)' : ''}\n`);
  }
  if (!ok) { process.stderr.write(`verify: critical sensors red: ${failing.join(', ')}\n`); process.exit(1); }

  // Execute -> Verify is a causal transition. Sensor execution above is allowed to capture the
  // current envelope, but an active typed task contract must satisfy every authored gate before
  // verify can announce success or assemble the deep package. Legacy projects without an active
  // context preserve their pre-contract behavior until they migrate.
  if (commandContext) {
    const taskSnapshot = buildTaskContractSnapshot({
      vaultBase,
      projectRoot,
      changeSlug: slug,
      identity: commandContext,
    });
    const taskEvaluations = evaluateTaskContracts(taskSnapshot);
    const executeEvaluations = taskEvaluations.filter((task) => task.phase !== 'verify');
    const taskGate = {
      schema_version: 1,
      change_slug: slug,
      evidence_envelope_id: envelope.envelope_id,
      ok: executeEvaluations.every((task) => task.can_complete),
      execute_task_ids: executeEvaluations.map((task) => task.task_id),
      tasks: taskEvaluations,
    };
    writeAuthority('task-evaluation.json', `${JSON.stringify(taskGate, null, 2)}\n`);
    if (!taskGate.ok) {
      const blockers = [...new Set(executeEvaluations.flatMap((task) => (
        task.blocking_findings.map((finding) => `${task.task_id}:${finding.code}`)
      )))];
      process.stderr.write(`verify: task contracts block Execute -> Verify: ${blockers.join(', ')}\n`);
      process.exit(1);
    }
  }

  // --deep (Q2=B): assemble the verification package the wk-verify skill judges. A trivial
  // change (no [req:] tasks, sensors green) gets an auto verdict — no agent pass needed.
  if (argv.includes('--deep')) {
    captureSpecBaseline(vaultBase, changeDir);
    if (effective.errors.length) {
      process.stderr.write(`verify --deep: spec efetiva inválida: ${effective.errors.join('; ')}\n`);
      process.exit(1);
    }
    if (effective.missing.length) {
      process.stderr.write(`verify --deep: ${formatOrphanReqs(effective.missing)}\n`);
      process.exit(1);
    }
    const pkg = {
      slug,
      tasksHash,
      effectiveSpecHash: effective.hash,
      evidenceEnvelopeId: envelope.envelope_id,
      evidenceBinding: evidenceCheckoutBinding(envelope),
      requirements: effective.requirements.map((req) => {
        return {
          id: req.id,
          name: req.name,
          capability: req.capability,
          operation: req.operation,
          source: req.source,
          body: req.body,
        };
      }),
      tasks: tasks.map((t) => ({ id: t.id, text: t.text, req: t.req || null, reqs: t.reqs || [], done: t.done })),
      sensors: evidence,
    };
    writeAuthority('verificacao.json', `${JSON.stringify(pkg, null, 2)}\n`);
    if (reqIds.length === 0) {
      writeAuthority('verdict.json', `${JSON.stringify({ slug, ok: true, coverage: [], tasksHash, effectiveSpecHash: effective.hash, evidenceEnvelopeId: envelope.envelope_id, evidenceBinding: pkg.evidenceBinding, notes: ['trivial: sem requisito'] }, null, 2)}\n`);
      process.stdout.write('verify --deep: pacote + verdict trivial escritos\n');
    } else {
      process.stdout.write('verify --deep: pacote escrito — rode a skill wk-verify pra gravar verdict.json\n');
    }
    process.exit(0);
  }
  process.stdout.write(`verify OK (${ids.length} sensor(s))\n`);
  process.exit(0);
}
