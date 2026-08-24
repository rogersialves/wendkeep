import { isAbsolute, resolve } from 'node:path';
import { activeChange } from '../hooks/change-core.mjs';
import { resolveActiveContext } from '../hooks/active-context-store.mjs';
import { resolveCommandActiveContext } from './active-context-runtime.mjs';
import { buildTaskContractSnapshot, evaluateTaskContracts } from './task-contracts.mjs';
import { claimTaskLease, releaseTaskLease } from './task-leases.mjs';
import { findProjectRoot } from '../packages/harness/src/sensors-core.mjs';

const HELP = `wendkeep task <list|show|evaluate|claim|release> [task-id]

  --session <id>        select the causal work session
  --change <slug>       select a change matching the active context
  --lease-seconds <n>   claim duration (1..86400; default 900)
  --json                emit structured JSON
`;

function opt(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : '';
}

function fail(error, json = false) {
  const payload = {
    ok: false,
    code: error?.code || 'TASK_COMMAND_FAILED',
    error: String(error?.message || error),
    recovery: error?.recovery || 'inspect the active context and task contract, then retry',
  };
  process.stderr.write(json ? `${JSON.stringify(payload)}\n` : `wendkeep task: ${payload.code}: ${payload.error}\n`);
  return 2;
}

function commandState(argv) {
  const json = argv.includes('--json');
  const vaultRaw = opt(argv, '--vault') || process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultRaw) throw Object.assign(new Error('no vault (--vault or OBSIDIAN_VAULT_PATH)'), { code: 'TASK_VAULT_MISSING' });
  const vaultBase = isAbsolute(vaultRaw) ? vaultRaw : resolve(process.cwd(), vaultRaw);
  const projectRoot = resolve(opt(argv, '--project') || findProjectRoot(process.cwd()) || process.cwd());
  const sessionId = opt(argv, '--session') || process.env.CODEX_THREAD_ID || process.env.CLAUDE_SESSION_ID || '';
  const identity = resolveCommandActiveContext({ vaultBase, projectRoot, sessionId, requireExisting: true });
  if (!identity) throw Object.assign(new Error('active context is required'), { code: 'TASK_ACTIVE_CONTEXT_NOT_FOUND' });
  const context = resolveActiveContext(vaultBase, identity);
  const explicitChange = opt(argv, '--change');
  const changeSlug = explicitChange || activeChange(vaultBase, { context: identity });
  if (!changeSlug) throw Object.assign(new Error('no active change'), { code: 'TASK_CHANGE_NOT_FOUND' });
  if (explicitChange && context.change_slug && explicitChange !== context.change_slug) {
    throw Object.assign(new Error('requested change differs from active context'), { code: 'TASK_CHANGE_CONTEXT_MISMATCH' });
  }
  return {
    json, vaultBase, projectRoot, sessionId: identity.sessionId || sessionId,
    identity, context, changeSlug,
  };
}

function write(value, json, line = '') {
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else process.stdout.write(`${line || String(value)}\n`);
}

export function runTask(argv = []) {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  const json = argv.includes('--json');
  try {
    const state = commandState(argv);
    const snapshot = buildTaskContractSnapshot(state);
    const taskId = String(argv[1] || '').trim();
    const contract = taskId ? snapshot.contracts.find((item) => item.task_id === taskId) : null;
    if (sub !== 'list' && !contract) {
      throw Object.assign(new Error(`task not found: ${taskId || '(missing id)'}`), { code: 'TASK_NOT_FOUND' });
    }

    if (sub === 'list') {
      const value = { change_slug: state.changeSlug, tasks: snapshot.contracts };
      write(value, state.json, snapshot.contracts.map((item) => `${item.task_id} [${item.status}] ${item.title}`).join('\n'));
      return 0;
    }
    if (sub === 'show') {
      write(contract, state.json, `${contract.task_id} [${contract.status}] ${contract.title}`);
      return 0;
    }
    if (sub === 'evaluate') {
      const evaluation = evaluateTaskContracts(snapshot).find((item) => item.task_id === taskId);
      write(evaluation, state.json, `${taskId}: ${evaluation.can_complete ? 'can complete' : 'blocked'}${evaluation.blocking_findings.length ? ` — ${evaluation.blocking_findings.map((item) => item.code).join(', ')}` : ''}`);
      return evaluation.can_complete ? 0 : 1;
    }
    if (sub === 'claim') {
      const lease = claimTaskLease({
        ...state,
        changeSlug: state.changeSlug,
        taskId,
        ownerSessionId: state.sessionId,
        leaseSeconds: Number(opt(argv, '--lease-seconds') || 900),
      });
      write(lease, state.json, `task ${taskId} claimed by ${lease.owner_session_id} until ${lease.expires_at}`);
      return 0;
    }
    if (sub === 'release') {
      const lease = releaseTaskLease({
        ...state,
        changeSlug: state.changeSlug,
        taskId,
        ownerSessionId: state.sessionId,
      });
      write(lease, state.json, `task ${taskId} released`);
      return 0;
    }
    throw Object.assign(new Error(`unknown subcommand: ${sub}`), { code: 'TASK_SUBCOMMAND_UNKNOWN' });
  } catch (error) {
    return fail(error, json);
  }
}
