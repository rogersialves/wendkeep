import { isAbsolute, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { activeChange } from '../hooks/change-core.mjs';
import { resolveActiveContext } from '../hooks/active-context-store.mjs';
import { resolveHookOperatingProfile } from '../hooks/operating-profile-runtime.mjs';
import { findProjectRoot } from '../packages/harness/src/sensors-core.mjs';
import { resolveCommandActiveContext } from './active-context-runtime.mjs';
import { buildTaskContractSnapshot } from './task-contracts.mjs';
import {
  completeGreenAttestation,
  createRedAttestation,
  evaluateTddAttestation,
  waiveTddAttestation,
} from './tdd-attestation.mjs';
import {
  captureTddSnapshot,
  committedPathsBetween,
  isGitAncestor,
  readTddAttestationStore,
  saveTddAttestation,
} from './tdd-attestation-store.mjs';

const HELP = `wendkeep tdd <red|green|status|waive> <task-id>

  --requirement <id>   requirement bound to the task
  --test <path>        test path (repeatable)
  --command <command>  discriminating test command
  --reason <text>      waiver reason
  --authority <id>     explicit human waiver authority
  --session <id>       causal work session
  --change <slug>      active change override
  --json               emit structured JSON
`;

function opt(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || '' : '';
}

function opts(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1]) values.push(argv[index + 1]);
  }
  return values;
}

function tddError(code, message) {
  return Object.assign(new Error(message), { code });
}

function commandState(argv) {
  const vaultRaw = opt(argv, '--vault') || process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultRaw) throw tddError('TDD_VAULT_MISSING', 'no vault (--vault or OBSIDIAN_VAULT_PATH)');
  const vaultBase = isAbsolute(vaultRaw) ? vaultRaw : resolve(process.cwd(), vaultRaw);
  const projectRoot = resolve(opt(argv, '--project') || findProjectRoot(process.cwd()) || process.cwd());
  const requestedSession = opt(argv, '--session') || process.env.CODEX_THREAD_ID || process.env.CLAUDE_SESSION_ID || '';
  const identity = resolveCommandActiveContext({
    vaultBase, projectRoot, sessionId: requestedSession, requireExisting: true,
  });
  if (!identity) throw tddError('TDD_ACTIVE_CONTEXT_NOT_FOUND', 'active context is required');
  const context = resolveActiveContext(vaultBase, identity);
  const explicitChange = opt(argv, '--change');
  const changeSlug = explicitChange || activeChange(vaultBase, { context: identity });
  if (!changeSlug) throw tddError('TDD_CHANGE_NOT_FOUND', 'no active change');
  if (explicitChange && context.change_slug && explicitChange !== context.change_slug) {
    throw tddError('TDD_CHANGE_CONTEXT_MISMATCH', 'requested change differs from active context');
  }
  const runtime = resolveHookOperatingProfile({
    input: { cwd: projectRoot, session_id: identity.sessionId || requestedSession },
  });
  return {
    vaultBase, projectRoot, identity, context, changeSlug,
    profile: runtime.profile,
    json: argv.includes('--json'),
  };
}

function causalIdentity(state) {
  return {
    project_id: state.identity.projectId,
    repository_id: state.identity.repositoryId,
    worktree_id: state.identity.worktreeId,
    work_session_id: state.identity.workSessionId,
    change_slug: state.changeSlug,
  };
}

function taskAndRequirement(state, taskId, requested = '') {
  const snapshot = buildTaskContractSnapshot({ ...state, profile: state.profile });
  const task = snapshot.contracts.find((item) => item.task_id === taskId);
  if (!task) throw tddError('TDD_TASK_NOT_FOUND', `task not found: ${taskId || '(missing id)'}`);
  const requirementId = String(requested || task.requirement_ids[0] || '').trim();
  if (!requirementId || !task.requirement_ids.includes(requirementId)) {
    throw tddError('TDD_REQUIREMENT_NOT_BOUND', `requirement is not bound to task ${taskId}`);
  }
  return { task, requirementId };
}

function runObserved(command, projectRoot) {
  if (!String(command || '').trim()) throw tddError('TDD_COMMAND_REQUIRED', '--command is required');
  const env = { ...process.env };
  // A test command launched by the CLI is a new observation, not a recursive
  // child of WendKeep's own node:test process.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(command, [], {
    cwd: projectRoot,
    shell: true,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env,
  });
}

function currentAttestation(state, taskId) {
  return readTddAttestationStore(state.vaultBase, state.changeSlug).attestations
    .find((item) => item.task_id === taskId) || null;
}

function write(value, json) {
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${value.task_id}: ${value.state}\n`);
}

function fail(error, json) {
  const payload = { ok: false, code: error?.code || 'TDD_COMMAND_FAILED', error: String(error?.message || error) };
  process.stderr.write(json ? `${JSON.stringify(payload)}\n` : `wendkeep tdd: ${payload.code}: ${payload.error}\n`);
  return 2;
}

export function runTdd(argv = []) {
  const sub = argv[0];
  if (!sub || ['help', '--help', '-h'].includes(sub)) {
    process.stdout.write(HELP);
    return 0;
  }
  const json = argv.includes('--json');
  try {
    const state = commandState(argv);
    const taskId = String(argv[1] || '').trim();
    if (!taskId) throw tddError('TDD_TASK_REQUIRED', 'task id is required');

    if (sub === 'red') {
      const { requirementId } = taskAndRequirement(state, taskId, opt(argv, '--requirement'));
      const testPaths = opts(argv, '--test');
      if (!testPaths.length) throw tddError('TDD_TEST_PATH_REQUIRED', 'at least one --test is required');
      const command = opt(argv, '--command');
      const attestation = createRedAttestation({
        identity: causalIdentity(state), taskId, requirementId, testPaths,
        profile: state.profile, command, result: runObserved(command, state.projectRoot),
        snapshot: captureTddSnapshot(state.projectRoot),
      });
      saveTddAttestation(state.vaultBase, state.changeSlug, attestation);
      write(attestation, state.json);
      return attestation.state === 'red-observed' ? 0 : 1;
    }

    if (sub === 'green') {
      const current = currentAttestation(state, taskId);
      if (!current) throw tddError('TDD_RED_REQUIRED', 'no RED attestation exists for this task');
      const command = opt(argv, '--command');
      const snapshot = captureTddSnapshot(state.projectRoot);
      const attestation = completeGreenAttestation(current, {
        identity: causalIdentity(state), taskId, requirementId: current.requirement_id,
        testPaths: opts(argv, '--test'), command,
        result: runObserved(command, state.projectRoot), snapshot,
        isAncestor: isGitAncestor(state.projectRoot, current.red?.head_sha, snapshot.head_sha),
        committedPaths: committedPathsBetween(state.projectRoot, current.red?.head_sha, snapshot.head_sha),
      });
      saveTddAttestation(state.vaultBase, state.changeSlug, attestation);
      write(attestation, state.json);
      return attestation.state === 'green-observed' ? 0 : 1;
    }

    if (sub === 'waive') {
      const { requirementId } = taskAndRequirement(state, taskId, opt(argv, '--requirement'));
      const attestation = waiveTddAttestation({
        identity: causalIdentity(state), taskId, requirementId, profile: state.profile,
        reason: opt(argv, '--reason'), authority: opt(argv, '--authority'),
      });
      saveTddAttestation(state.vaultBase, state.changeSlug, attestation);
      write(attestation, state.json);
      return 0;
    }

    if (sub === 'status') {
      const current = currentAttestation(state, taskId);
      if (!current) throw tddError('TDD_ATTESTATION_NOT_FOUND', `no attestation for task ${taskId}`);
      const evaluated = evaluateTddAttestation(current, captureTddSnapshot(state.projectRoot));
      write(evaluated, state.json);
      return ['green-observed', 'waived'].includes(evaluated.state) ? 0 : 1;
    }
    throw tddError('TDD_SUBCOMMAND_UNKNOWN', `unknown subcommand: ${sub}`);
  } catch (error) {
    return fail(error, json);
  }
}
