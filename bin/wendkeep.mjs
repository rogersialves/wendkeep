#!/usr/bin/env node
// wendkeep CLI — single entrypoint.
//   wendkeep init [--vault <path>] [--project <path>] [--no-mcp] [--yes] [--force]
//   wendkeep hook <name>      (invoked by the agent's settings.json; pipes stdin/stdout)
//   wendkeep doctor [--vault <path>]
//   wendkeep --version | --help
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNNABLE_HOOKS } from '../src/taxonomy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const hooksDir = join(pkgRoot, 'hooks');

function version() {
  try {
    return JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

const HELP = `wendkeep ${version()} — capture AI coding agent sessions into your Obsidian vault.

Usage:
  wendkeep init [options]      Set up wendkeep in a project (cross-platform).
    --vault <path>         Obsidian vault folder (default: <project>/.<project-name>-vault).
    --project <path>       Project root to wire (default: current directory).
    --no-mcp               Do not add the mcpvault MCP server to .mcp.json.
    --companions <csv>     Companion plugins/MCP to pin: context-mode,caveman,understand-anything
                           (default: none — opt in explicitly). dotcontext is legacy — the native a2 loop replaces it.
    --no-companions        Skip companion plugins/MCP entirely.
    --no-colors            Skip the Obsidian color system (.obsidian snippet + graph groups).
    --dotcontext-mcp <v>   dotcontext MCP placement: auto (default; skip project entry
                           if already global), project, or none.
    --dotcontext-hooks <v> dotcontext hooks: full (default), light (no PostToolUse), none.
    --yes, -y              Non-interactive; accept defaults.
    --force                Overwrite existing wendkeep config blocks.

  wendkeep hook <name>         Run a session hook (used by settings.json). Reads the
                           agent's JSON on stdin. Names: ${RUNNABLE_HOOKS.join(', ')}.

  wendkeep doctor [--vault P]  Run a vault health check.
  wendkeep change <sub>        Change lifecycle: new [--simple] | use | bind <slug> --session <id> | continue | list | show |
                           status | done <id> | undone <id> | diff | archive [--force] | abandon.
                           archive exige verdict (rode verify --deep); abandon descarta sem ADR.
  wendkeep session <sub>       Session registry: list | show <id> | use <id>.
  wendkeep spec <sub>          Specs: list | show | effective [--change] [--json] | migrate | rebase.
  wendkeep sensors <sub>       list | add <id> "<command>" [--severity --type --report].
  wendkeep cost [opts]         Aggregate AI-coding spend across the vault's sessions.
                           --since <date> · --top [N] (priciest) · --trend [day|week|month]
                           (+ run-rate projection) · --write (generate 00-Custo.md) · --json.
  wendkeep cost rebuild        Recalculate historical parent + subagent costs from SESSION_REGISTRY.
                           Dry-run by default · --apply writes notes + .brain/COST_REBUILD.json
                           · --session <id|file> · --limit N · --json.
  wendkeep stats [--vault P]   One shareable line: sessions · prompts · spend · span · models (--json).
  wendkeep import [opts]       Backfill: import this project's past Claude + Codex sessions into
                           the vault (deduped by session_id). --source all|claude|codex (default
                           all) · --stamp-ids (backfill session_id in existing notes) ·
                           --rescan-decisions (capture prose decisions from already-imported transcripts) ·
                           --from <dir> · --codex-from <dir> · --since <date> · --limit N ·
                           --dry-run · --json.
  wendkeep verify [--deep] [--change s]  Run a change's task sensors + record evidence (the gate);
                           --deep assembles the verification package for the wk-verify pass.
  wendkeep dashboard [--force]  (Re)generate the vault's folder-filtered Bases + 00-Dashboard MOC.
  wendkeep renumber-decisions   Renumber 04-Decisões to ADR-<NNNN>-<slug> in chronological order,
                           renaming files + rewriting every wikilink. Preview by default; --apply to
                           write. --vault P · --json.
  wendkeep lesson add "t" "l"   Record a project-local lesson (injected at SessionStart).
  wendkeep validate-memory [path]  Validate .brain/CORE.md against the compaction
                           protocol (cap 25, 3 sections, no secrets/PII). Uses
                           --vault <path> or OBSIDIAN_VAULT_PATH if no path given.
  wendkeep sync-defs [opts]    Copy versioned defs from the vault's .brain into the
                           project: .brain/agents/*.toml -> .codex/agents,
                           .brain/skills/<name> -> .claude/skills + .agents/skills. --vault P --project P.
                           --reseed re-semeia as skills wk-* com os seeds da versão instalada
                           (sobrescreve edições manuais nas wk-*) antes de copiar.
                           --check detecta drift sem modificar arquivos.
  wendkeep --version           Print version.
  wendkeep --help              Show this help.
`;

function runHook(name) {
  if (!name) {
    process.stderr.write('wendkeep hook: missing hook name\n');
    process.exit(2);
  }
  if (!RUNNABLE_HOOKS.includes(name)) {
    process.stderr.write(`wendkeep hook: unknown hook "${name}". Known: ${RUNNABLE_HOOKS.join(', ')}\n`);
    process.exit(2);
  }
  const file = join(hooksDir, `${name}.mjs`);
  if (!existsSync(file)) {
    process.stderr.write(`wendkeep hook: hook file not found: ${file}\n`);
    process.exit(2);
  }
  // Spawn exactly as the agent would run `node <hook>.mjs`: stdio inherited so the
  // hook's stdin (agent JSON) and stdout (hookSpecificOutput) pass through untouched.
  const r = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1] || '';
  return argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

async function preferProjectVault(argv) {
  // Existing command modules still consume OBSIDIAN_VAULT_PATH internally. Populate it
  // only inside this CLI process from the provider-neutral project binding, overriding
  // any inherited machine-global value. An explicit --vault remains authoritative.
  if (optionValue(argv, '--vault')) return;
  try {
    const { resolveProjectVault } = await import('../src/project-vault.mjs');
    const resolved = resolveProjectVault({ startDir: optionValue(argv, '--project') || process.cwd() });
    process.env.OBSIDIAN_VAULT_PATH = resolved.base;
  } catch {
    // Backward-compatible manual CLI behavior: individual commands still explain
    // --vault / legacy env when no project binding exists. Hooks do not use this path.
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  // Universal --help: any subcommand with --help/-h prints usage and never executes.
  // Intercepted BEFORE vault resolution so it works anywhere — help must never depend
  // on project state, and no command may treat --help as a runnable default.
  if (cmd && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (cmd && !['init', 'hook', '--version', '-v', '--help', '-h', 'help'].includes(cmd)) {
    await preferProjectVault(rest);
  }
  switch (cmd) {
    case 'init': {
      const { runInit } = await import('../src/init.mjs');
      await runInit(rest);
      break;
    }
    case 'hook':
      runHook(rest[0]);
      break;
    case 'doctor': {
      const { runDoctor } = await import('../src/doctor.mjs');
      runDoctor(rest);
      break;
    }
    case 'validate-memory': {
      const { runValidateMemory } = await import('../src/validate-core.mjs');
      runValidateMemory(rest);
      break;
    }
    case 'sync-defs': {
      const { runSyncDefs } = await import('../src/sync-defs.mjs');
      runSyncDefs(rest);
      break;
    }
    case 'change': {
      const { runChange } = await import('../src/change.mjs');
      runChange(rest);
      break;
    }
    case 'session': {
      const { runSession } = await import('../src/session.mjs');
      runSession(rest);
      break;
    }
    case 'verify': {
      const { runVerify } = await import('../src/verify.mjs');
      runVerify(rest);
      break;
    }
    case 'lesson': {
      const { runLesson } = await import('../src/lessons.mjs');
      runLesson(rest);
      break;
    }
    case 'spec': {
      const { runSpec } = await import('../src/spec.mjs');
      runSpec(rest);
      break;
    }
    case 'sensors': {
      const { runSensors } = await import('../src/sensors.mjs');
      runSensors(rest);
      break;
    }
    case 'cost': {
      const { runCost } = await import('../src/cost.mjs');
      runCost(rest);
      break;
    }
    case 'stats': {
      const { runStats } = await import('../src/stats.mjs');
      runStats(rest);
      break;
    }
    case 'import': {
      const { runImportCli } = await import('../src/import.mjs');
      runImportCli(rest);
      break;
    }
    case 'dashboard': {
      const { runDashboard } = await import('../src/vault-views.mjs');
      runDashboard(rest);
      break;
    }
    case 'renumber-decisions': {
      const { runRenumberDecisions } = await import('../src/renumber.mjs');
      runRenumberDecisions(rest);
      break;
    }
    case '--version':
    case '-v':
      process.stdout.write(`${version()}\n`);
      break;
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(HELP);
      break;
    default:
      process.stderr.write(`wendkeep: unknown command "${cmd}"\n\n${HELP}`);
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`wendkeep: ${err?.stack || err}\n`);
  process.exit(1);
});
