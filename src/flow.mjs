// Public FLOW CLI. The durable contract lives in the Vault runtime store; this
// module only parses the canonical command surface and renders deterministic exits.
import {
  finishFlow, flowStatus, promoteFlow, startFlow,
} from '../hooks/flow-core.mjs';
import { resolveProjectVault } from './project-vault.mjs';

export const FLOW_HELP = `wendkeep flow <subcommand>

  start <slug> --allow <path>... --sensor <id>... --reason <text> [--session <id>]
  status [<id>]
  show <id>
  finish <id>
  promote <id> [--change-slug <slug>]

Common options: --project <path> --vault <path> --session <id> --json
FLOW has no --force option.
`;

function usage(message) {
  const error = new Error(message);
  error.code = 'FLOW_USAGE';
  return error;
}

const VALUE_OPTIONS = new Map([
  ['--allow', 'allow'],
  ['--sensor', 'sensor'],
  ['--reason', 'reason'],
  ['--session', 'session'],
  ['--project', 'project'],
  ['--vault', 'vault'],
  ['--change-slug', 'changeSlug'],
]);

function parseOptions(argv) {
  const values = {
    allow: [], sensor: [], reason: '', session: '', project: '', vault: '', changeSlug: '', json: false,
  };
  const positionals = [];
  const seenSingletons = new Set();
  const setOption = (name, key, value) => {
    if (key === 'allow' || key === 'sensor') {
      values[key].push(String(value));
      return;
    }
    if (seenSingletons.has(name)) throw usage(`opção duplicada: ${name}`);
    seenSingletons.add(name);
    values[key] = String(value);
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg === '--json') {
      if (seenSingletons.has(arg)) throw usage(`opção duplicada: ${arg}`);
      seenSingletons.add(arg);
      values.json = true;
      continue;
    }
    if (VALUE_OPTIONS.has(arg)) {
      const value = argv[++index];
      if (value === undefined || String(value).startsWith('--')) throw usage(`valor ausente para ${arg}`);
      const key = VALUE_OPTIONS.get(arg);
      setOption(arg, key, value);
      continue;
    }
    if (arg.startsWith('--')) {
      const at = arg.indexOf('=');
      const name = at === -1 ? arg : arg.slice(0, at);
      if (!VALUE_OPTIONS.has(name)) throw usage(`opção desconhecida: ${name}`);
      const value = arg.slice(at + 1);
      if (!value) throw usage(`valor ausente para ${name}`);
      const key = VALUE_OPTIONS.get(name);
      setOption(name, key, value);
      continue;
    }
    positionals.push(arg);
  }
  return { ...values, positionals };
}

function context(options, io) {
  const startDir = options.project || io.cwd || process.cwd();
  if (options.vault) {
    return resolveProjectVault({ startDir, explicitVault: options.vault });
  }
  try {
    return resolveProjectVault({ startDir });
  } catch (bindingError) {
    const fallback = io.env?.OBSIDIAN_VAULT_PATH;
    if (!fallback) throw bindingError;
    return resolveProjectVault({ startDir, explicitVault: fallback });
  }
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function writeState(stream, state, { detailed = false } = {}) {
  const { contract } = state;
  stream.write(`FLOW ${contract.flow_id}: ${state.state} (${contract.slug})\n`);
  stream.write(`session: ${contract.session_id}\n`);
  stream.write(`reason: ${contract.reason}\n`);
  stream.write(`allow: ${contract.allowed_paths.join(', ')}\n`);
  stream.write(`sensors: ${contract.sensor_ids.join(', ')}\n`);
  if (detailed || state.attempts.length) stream.write(`attempts: ${state.attempts.length}\n`);
  if (state.receipt) stream.write(`changed: ${state.receipt.changed_paths.join(', ')}\n`);
  if (state.promotion) stream.write(`change: ${state.promotion.change_slug}\n`);
}

function fail(stream, error, json) {
  const message = error?.message || String(error);
  if (json) writeJson(stream, { ok: false, error: message, code: error?.code || 'FLOW_ERROR' });
  else stream.write(`wendkeep flow: ${message}\n`);
  return 2;
}

function requirePositionals(positionals, count, command) {
  if (positionals.length !== count) {
    const expected = command === 'status' ? '[<id>]' : command === 'start' ? '<slug>' : '<id>';
    throw usage(`use: wendkeep flow ${command} ${expected}`);
  }
}

function rejectStartOnlyOptions(options, command) {
  if (options.allow.length || options.sensor.length || options.reason) {
    throw usage(`--allow, --sensor e --reason só são válidos em flow start (recebido: ${command})`);
  }
}

export async function runFlow(argv = [], streams = {}) {
  const io = {
    stdout: streams.stdout || process.stdout,
    stderr: streams.stderr || process.stderr,
    env: streams.env ?? process.env,
    cwd: streams.cwd || process.cwd(),
  };
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout.write(FLOW_HELP);
    return 0;
  }

  let options;
  let sub;
  try {
    [sub = 'status'] = argv;
    options = parseOptions(argv.slice(sub ? 1 : 0));
    if (!['start', 'status', 'show', 'finish', 'promote'].includes(sub)) {
      throw usage('use start | status | show | finish | promote');
    }
  } catch (error) {
    return fail(io.stderr, error, argv.includes('--json'));
  }

  let resolved;
  try {
    if (options.changeSlug && sub !== 'promote') {
      throw usage(`--change-slug só é válido em flow promote (recebido: ${sub})`);
    }
    if (sub === 'start') {
      requirePositionals(options.positionals, 1, sub);
      if (!options.reason) throw usage('--reason é obrigatório em flow start');
      if (!options.allow.length) throw usage('ao menos um --allow é obrigatório em flow start');
      if (!options.sensor.length) throw usage('ao menos um --sensor é obrigatório em flow start');
    } else {
      rejectStartOnlyOptions(options, sub);
      requirePositionals(options.positionals, sub === 'status' ? (options.positionals.length ? 1 : 0) : 1, sub);
    }
    resolved = context(options, io);

    if (sub === 'start') {
      const state = startFlow({
        vaultBase: resolved.base,
        projectRoot: resolved.projectRoot || io.cwd,
        projectId: resolved.projectId || resolved.config?.projectId || '',
        slug: options.positionals[0],
        allowedPaths: options.allow,
        sensorIds: options.sensor,
        reason: options.reason,
        sessionId: options.session,
        env: io.env,
      });
      if (options.json) writeJson(io.stdout, state);
      else writeState(io.stdout, state, { detailed: true });
      return 0;
    }

    if (sub === 'status' || sub === 'show') {
      const state = flowStatus(resolved.base, {
        flowId: options.positionals[0] || '',
        sessionId: options.session,
        env: io.env,
      });
      if (options.json) writeJson(io.stdout, state);
      else writeState(io.stdout, state, { detailed: sub === 'show' });
      return 0;
    }

    if (sub === 'finish') {
      const result = finishFlow({
        vaultBase: resolved.base,
        projectRoot: resolved.projectRoot || io.cwd,
        flowId: options.positionals[0],
        sessionId: options.session,
      });
      if (options.json) writeJson(io.stdout, result);
      else if (result.ok) writeState(io.stdout, result.state, { detailed: true });
      else {
        io.stdout.write(`FLOW ${options.positionals[0]} bloqueado:\n`);
        for (const failure of result.failures) io.stdout.write(`- ${failure}\n`);
      }
      return result.ok ? 0 : 1;
    }

    const result = promoteFlow({
      vaultBase: resolved.base,
      projectRoot: resolved.projectRoot || io.cwd,
      flowId: options.positionals[0],
      sessionId: options.session,
      changeSlug: options.changeSlug,
    });
    if (options.json) writeJson(io.stdout, result);
    else if (result.ok) writeState(io.stdout, result.state, { detailed: true });
    else {
      io.stdout.write(`FLOW ${options.positionals[0]} com promoção pendente:\n`);
      for (const failure of result.failures) io.stdout.write(`- ${failure}\n`);
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    return fail(io.stderr, error, options?.json);
  }
}
