// wendkeep CLI — canonical private runtime.
//   wendkeep init [--vault <path>] [--project <path>] [--no-mcp] [--yes] [--force] [--vscode-worktree-tasks]
//   wendkeep hook <name>      (invoked by the agent's settings.json; pipes stdin/stdout)
//   wendkeep doctor [--vault <path>]
//   wendkeep --version | --help
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNNABLE_HOOKS } from '../../../src/taxonomy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..', '..');
const hooksDir = join(pkgRoot, 'hooks');

function version() {
  try {
    return JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

const HELP = `wendkeep ${version()} — keep durable AI sessions in an Obsidian vault, with optional governance.

Usage:
  wendkeep init [options]      Set up wendkeep in a project (cross-platform).
    --vault <path>         Obsidian vault folder (default: <project>/.<project-name>-vault).
    --project <path>       Project root to wire (default: current directory).
    --profile <name>       Operating profile: OFF, FLOW, GUIDE, GOVERN (default), or ASSURE.
    --no-mcp               Do not add the mcpvault MCP server to .mcp.json.
    --companions <csv>     Companion plugins/MCP to pin: context-mode,caveman,understand-anything
                           (default: none — opt in explicitly). dotcontext is legacy — the native a2 loop replaces it.
    --no-companions        Skip companion plugins/MCP entirely.
    --no-colors            Skip the Obsidian color system (.obsidian snippet + graph groups).
    --vscode-worktree-tasks Create local, Git-excluded VS Code tasks for managed worktrees.
    --dotcontext-mcp <v>   dotcontext MCP placement: auto (default; skip project entry
                           if already global), project, or none.
    --dotcontext-hooks <v> dotcontext hooks: full (default), light (no PostToolUse), none.
    --yes, -y              Non-interactive; accept defaults.
    --force                Overwrite existing wendkeep config blocks.

  wendkeep hook <name>         Run a session hook (used by settings.json). Reads the
                           agent's JSON on stdin. Names: ${RUNNABLE_HOOKS.join(', ')}.

  wendkeep sync [--project P]  Run init -> sync-defs -> doctor on the CURRENT project, in one
                           command — the three steps that repeat identically after every
                           package update. Stops at the first failing step. Install the
                           package first (npm i -D wendkeep@latest); a running process
                           cannot replace itself. · --vault P · --profile <name> · --yes
                           · --vscode-worktree-tasks.

  wendkeep doctor [--vault P]  Health check. --scope core|runtime · --strict for CI/release.
  wendkeep observer <sub>     Local multi-project Observer: serve | register | publish | reconcile | status.
  wendkeep worktree create <slug> [--base ref] [--branch name] [--open vscode|none] [--json]
  wendkeep worktree list [--json]
  wendkeep worktree status [slug] [--json]
  wendkeep worktree open <slug> [--editor vscode] [--json]
                           Managed linked worktrees under .worktrees (branch default wk/<slug>).
  wendkeep context switch <branch> [--create] [--session <id>] [--json]
                           Switch Git branch and the causal session scope in the same worktree.
  wendkeep context status --session <id> [--json]
  wendkeep context recover --session <id> --select reserved|observed --revision <n> --reason <text> [--json]
  wendkeep context repair --key <repository:worktree:work-session> --revision <n> --reason <text> --session <id> [--json]
                           Inspect or explicitly recover a quarantined causal scope conflict.
                           Repair revalidates orphan/removed contexts or expired request leases without deleting history.
  wendkeep task <sub>          Typed task contracts: list | show | evaluate | claim | release.
                           Resolves the change from the causal active context; supports --session/--change/--json.
  wendkeep tdd <sub>           Causal TDD attestations: red | green | status | waive.
                           Binds task, requirement, test paths, worktree and work session.
  wendkeep change <sub>        Change lifecycle: new [--simple|--guide] | use | bind <slug> --session <id> | continue | list | show |
                           status | done <id> | undone <id> | diff | archive [--force] | abandon | relink | backlink.
                           --session <id> selects the causal active_context for implicit change operations.
                           archive exige verdict (rode verify --deep); abandon descarta sem ADR.
                           backlink [--apply]: injeta o backlink pro proposta em design/tarefas/spec órfãos (open + _arquivo).
  wendkeep theme sync          Re-aplica o color system (snippet CSS + graph color groups) num vault
                           existente — recupera o grafo cinza sem re-init. --vault P.
  wendkeep session <sub>       Session registry: list | show <id> | use <id>.
  wendkeep profile <sub>       Operating profile: status | use <OFF|FLOW|GUIDE|GOVERN|ASSURE>.
                           --session <id> sets an audited session override; otherwise changes
                           the project default. The Vault/session/memory core is always active.
  wendkeep flow <sub>          Low-ceremony E -> V contract: start | status | show | finish | promote.
                           FLOW records scope, sensors and a receipt without creating a change.
  wendkeep delivery <sub>      Operational delivery: start | status | finish | abandon.
                           Records authorization and an append-only receipt; never creates a change/spec/ADR.
  wendkeep spec <sub>          Specs: list | show | effective [--change] [--session] [--json] | migrate | rebase.
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
  wendkeep verify [--deep] [--change s] [--session id]  Run a change's task sensors + record evidence (the gate);
                           --deep assembles the verification package for the wk-verify pass.
  wendkeep dashboard [--force]  (Re)generate the vault's folder-filtered Bases + 00-Dashboard MOC.
  wendkeep renumber-decisions   Renumber 04-Decisões to ADR-<NNNN>-<slug> in chronological order,
                           renaming files + rewriting every wikilink. Preview by default; --apply to
                           write. --vault P · --json.
  wendkeep renumber-bugs        Renumber 05-Bugs to BUG-<NNNN>-<slug> chronologically, moving notes
                           out of legacy "DIA N" subfolders into the month folder and rewriting
                           wikilinks. Preview by default; --apply · --vault P · --json.
  wendkeep renumber-learnings   Same for 06-Aprendizados/06-Learnings with APR-<NNNN>-<slug>.
  wendkeep note new --type bug|learning "<título>"  Create a numbered derived note (BUG-/APR-NNNN)
                           in the month folder and print its vault path. --date YYYY-MM-DD · --vault P.
  wendkeep note relink [--apply]  Backfill orphan derived notes (BUG/APR without a source session),
                           linking each to the modal source session of its type/month cohort. Dry-run
                           by default; --apply writes; skips notes with no sibling to infer from.
  wendkeep note repair-frontmatter [--apply]  Merge stacked frontmatter blocks in session notes
                           (damage from pre-lock concurrent writes) into a single block: base keys
                           from the original block, values from the newest. Dry-run by default;
                           --apply writes under the same lock as the hooks · --json.
  wendkeep note repair-sections [--apply]  Rebuild the derived sections (decisions/bugs/learnings)
                           in session notes from the linked derived notes — the body used to lag
                           behind the closing block. Dry-run by default · --apply · --json.
  wendkeep lesson add "t" "l"   Record a project-local lesson (injected at SessionStart).
  wendkeep memory curate         Guide actionable semantic conflicts in an interactive terminal.
                           --all includes historical handoffs and enables confirmed safe batch close;
                           every promote/reject requires confirmation. --vault P.
  wendkeep memory <sub>          Shared memory v2: status | candidates [--active] | curate | migrate [--apply] | rescope [--apply] | repair |
                           recover-attempt <session> [--apply] |
                           reconcile <session> --by-session <session> --reason <text> [--apply] |
                           promote <candidate> [--event <event-id>] | reject <candidate>. --vault P.
                           Reconcile is dry-run by default; the original attempt remains audited.
  wendkeep validate-memory [path]  Validate .brain/CORE.md against the compaction
                           protocol (cap 40, warning 35, 4 KiB, 320 chars/line, 3 sections, no secrets/PII).
                           --vault <path> validates the complete v2 bundle.
  wendkeep sync-defs [opts]    Copy versioned defs from the vault's .brain into the
                           project: .brain/agents/*.toml -> .codex/agents,
                           .brain/skills/<name> -> .claude/skills + .agents/skills. --vault P --project P.
                           --reseed re-semeia as skills wk-* com os seeds da versão instalada
                           (sobrescreve edições manuais nas wk-*) antes de copiar.
                           --check detecta drift sem modificar arquivos.
  wendkeep --version           Print version.
  wendkeep --help              Show this help.
`;

function runHook(name, args = []) {
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
  const r = spawnSync(process.execPath, [file, ...args], { stdio: 'inherit' });
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
    const { resolveProjectVault } = await import('../../../src/project-vault.mjs');
    // A sensor may itself invoke WendKeep. `verify`/`flow finish` already selected the
    // authoritative Vault explicitly, so preserve that choice across the child process
    // instead of letting the sensor cwd's project binding redirect it.
    const sensorVault = process.env.WENDKEEP_SENSOR_VAULT;
    if (sensorVault) {
      const selected = resolveProjectVault({
        startDir: optionValue(argv, '--project') || process.cwd(),
        explicitVault: sensorVault,
      });
      process.env.OBSIDIAN_VAULT_PATH = selected.base;
      return;
    }
    const resolved = resolveProjectVault({ startDir: optionValue(argv, '--project') || process.cwd() });
    process.env.OBSIDIAN_VAULT_PATH = resolved.base;
  } catch (error) {
    // Backward-compatible manual CLI behavior: individual commands still explain
    // --vault / legacy env only when no project binding exists. A configured but
    // corrupt/missing/mismatched binding must abort before dispatch to another Vault.
    if (error?.code !== 'WENDKEEP_VAULT_UNCONFIGURED') throw error;
  }
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  // Universal --help: any subcommand with --help/-h prints usage and never executes.
  // Intercepted BEFORE vault resolution so it works anywhere — help must never depend
  // on project state, and no command may treat --help as a runnable default.
  if (cmd && (rest.includes('--help') || rest.includes('-h'))) {
    if (cmd === 'flow') {
      const { FLOW_HELP } = await import('../../../src/flow.mjs');
      process.stdout.write(FLOW_HELP);
    } else if (cmd === 'delivery') {
      const { DELIVERY_HELP } = await import('../../../src/delivery.mjs');
      process.stdout.write(DELIVERY_HELP);
    } else if (cmd === 'profile') {
      const { PROFILE_HELP } = await import('../../../src/profile.mjs');
      process.stdout.write(PROFILE_HELP);
    } else if (cmd === 'context') {
      const { CONTEXT_HELP } = await import('../../../src/context.mjs');
      process.stdout.write(CONTEXT_HELP);
    } else {
      process.stdout.write(HELP);
    }
    process.exit(0);
  }
  const validatesStandaloneCore = cmd === 'validate-memory'
    && !rest.includes('--vault')
    && !rest.some((item) => item.startsWith('--vault='));
  if (cmd
    && !validatesStandaloneCore
    // `sync` starts with `init` and resolves the freshly bound Vault itself. Pre-resolving
    // here would prevent that repair step from reporting a corrupt binding as its own
    // first-stage failure (and could never make it as far as the guarded init).
    && !['init', 'sync', 'worktree', 'hook', 'observer', '--version', '-v', '--help', '-h', 'help'].includes(cmd)) {
    await preferProjectVault(rest);
  }
  switch (cmd) {
    case 'init': {
      const { runInit } = await import('../../../src/init.mjs');
      await runInit(rest);
      break;
    }
    case 'hook':
      runHook(rest[0], rest.slice(1));
      break;
    case 'doctor': {
      const { runDoctor } = await import('../../../src/doctor.mjs');
      process.exit(runDoctor(rest));
      break;
    }
    case 'observer': {
      const { runObserver } = await import('../../../src/observer.mjs');
      const observerExitCode = await runObserver(rest);
      if (rest[0] !== 'serve') process.exit(observerExitCode);
      break;
    }
    case 'worktree': {
      const { runWorktree } = await import('../../../src/worktree.mjs');
      process.exit(await runWorktree(rest));
      break;
    }
    case 'context': {
      const { runContext } = await import('../../../src/context.mjs');
      process.exit(runContext(rest));
      break;
    }
    case 'sync': {
      const { runSync } = await import('../../../src/sync.mjs');
      process.exit(await runSync(rest));
      break;
    }
    case 'validate-memory': {
      if (rest.includes('--vault') || rest.some((item) => item.startsWith('--vault='))) {
        const { runValidateMemoryBundle } = await import('../../../src/memory.mjs');
        runValidateMemoryBundle(rest);
      } else {
        const { runValidateMemory } = await import('../../../src/validate-core.mjs');
        runValidateMemory(rest);
      }
      break;
    }
    case 'memory': {
      if (rest[0] === 'curate') {
        const { runMemoryCurateCli } = await import('../../../src/memory-curate.mjs');
        process.exitCode = await runMemoryCurateCli(rest.slice(1));
      } else {
        const { runMemory } = await import('../../../src/memory.mjs');
        runMemory(rest);
      }
      break;
    }
    case 'sync-defs': {
      const { runSyncDefs } = await import('../../../src/sync-defs.mjs');
      process.exit(runSyncDefs(rest));
      break;
    }
    case 'change': {
      const { runChange } = await import('../../../src/change.mjs');
      runChange(rest);
      break;
    }
    case 'task': {
      const { runTask } = await import('../../../src/task.mjs');
      process.exit(runTask(rest));
      break;
    }
    case 'tdd': {
      const { runTdd } = await import('../../../src/tdd.mjs');
      process.exit(runTdd(rest));
      break;
    }
    case 'session': {
      const { runSession } = await import('../../../src/session.mjs');
      runSession(rest);
      break;
    }
    case 'profile': {
      const { runProfile } = await import('../../../src/profile.mjs');
      process.exit(runProfile(rest));
      break;
    }
    case 'flow': {
      const { runFlow } = await import('../../../src/flow.mjs');
      process.exit(await runFlow(rest));
      break;
    }
    case 'delivery': {
      const { runDelivery } = await import('../../../src/delivery.mjs');
      process.exit(runDelivery(rest));
      break;
    }
    case 'theme': {
      const { runTheme } = await import('../../../src/theme.mjs');
      runTheme(rest);
      break;
    }
    case 'verify': {
      const { runVerify } = await import('../../../src/verify.mjs');
      runVerify(rest);
      break;
    }
    case 'lesson': {
      const { runLesson } = await import('../../../src/lessons.mjs');
      runLesson(rest);
      break;
    }
    case 'spec': {
      const { runSpec } = await import('../../../src/spec.mjs');
      runSpec(rest);
      break;
    }
    case 'sensors': {
      const { runSensors } = await import('../../../src/sensors.mjs');
      runSensors(rest);
      break;
    }
    case 'cost': {
      const { runCost } = await import('../../../src/cost.mjs');
      runCost(rest);
      break;
    }
    case 'stats': {
      const { runStats } = await import('../../../src/stats.mjs');
      runStats(rest);
      break;
    }
    case 'import': {
      const { runImportCli } = await import('../../../src/import.mjs');
      runImportCli(rest);
      break;
    }
    case 'dashboard': {
      const { runDashboard } = await import('../../../src/vault-views.mjs');
      runDashboard(rest);
      break;
    }
    case 'renumber-decisions': {
      const { runRenumberDecisions } = await import('../../../src/renumber.mjs');
      runRenumberDecisions(rest);
      break;
    }
    case 'renumber-bugs': {
      const { runRenumberBugs } = await import('../../../src/renumber.mjs');
      runRenumberBugs(rest);
      break;
    }
    case 'renumber-learnings': {
      const { runRenumberLearnings } = await import('../../../src/renumber.mjs');
      runRenumberLearnings(rest);
      break;
    }
    case 'note': {
      const { runNote } = await import('../../../src/note.mjs');
      runNote(rest);
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

export async function runCli(argv = process.argv.slice(2)) {
  try {
    await main(argv);
  } catch (err) {
    process.stderr.write(`wendkeep: ${err?.stack || err}\n`);
    process.exit(1);
  }
}
