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
    --companions <csv>     Companion plugins/MCP to pin: context-mode,dotcontext,caveman,understand-anything
                           (default when interactive/--yes: context-mode,dotcontext).
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
  wendkeep change <sub>        Change lifecycle: new <slug> | list | show <slug> | archive <slug>.
  wendkeep verify [--change s] Run a change's task sensors + record evidence (the gate).
  wendkeep validate-memory [path]  Validate .brain/CORE.md against the compaction
                           protocol (cap 25, 3 sections, no secrets/PII). Uses
                           --vault <path> or OBSIDIAN_VAULT_PATH if no path given.
  wendkeep sync-defs [opts]    Copy versioned defs from the vault's .brain into the
                           project: .brain/agents/*.toml -> .codex/agents,
                           .brain/skills/<name> -> .claude/skills. --vault P --project P.
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

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
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
    case 'verify': {
      const { runVerify } = await import('../src/verify.mjs');
      runVerify(rest);
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
