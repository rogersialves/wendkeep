// Shared, data-only constants for the wendkeep installer and CLI.
// Kept free of side effects so both bin/ and src/ can import it cheaply.

// Vault folder taxonomy the hooks read from / write to.
// NOTE: folder names are currently Portuguese (the convention the hooks hardcode
// in obsidian-common.mjs: sessionFolderRel -> '02-Sessões', derived notes ->
// '04-Decisões' / '05-Bugs' / '06-Aprendizados'). Internationalizing these is
// tracked as a known limitation in the README — do not rename here without also
// changing the hooks.
export const VAULT_FOLDERS = [
  '00-Inbox',
  '01-Projeto',
  '02-Sessões',
  '03-Linear',
  '04-Decisões',
  '05-Bugs',
  '06-Aprendizados',
  '07-Specs',
  '08-Mudanças',
  'Templates',
  '.brain',
];

// Every file that must travel together for the hooks to run (shared lib +
// entrypoints + price table). Mirrors the list the old setup-vault.ps1 copied.
export const HOOK_FILES = [
  'obsidian-common.mjs',
  'locale.mjs',
  'session-start.mjs',
  'session-ensure.mjs',
  'session-stop.mjs',
  'linked-notes.mjs',
  'token-usage.mjs',
  'subagent-usage.mjs',
  'pricing.json',
  'brain-core.mjs',
  'change-core.mjs',
  'spec-core.mjs',
  'sensors-core.mjs',
  'harness-doctor.mjs',
  'lessons-core.mjs',
  'brain-inject.mjs',
  'brain-recall.mjs',
  'brain-reindex.mjs',
  'session-backfill.mjs',
  'import-sessions.mjs',
  'decision-capture.mjs',
  'renumber-decisions.mjs',
  'subagent-stop.mjs',
  'task-log.mjs',
  'vault-health.mjs',
  'understand-inject.mjs',
  'change-context.mjs',
  'change-warn.mjs',
  'change-guard.mjs',
  'change-nag.mjs',
  'plan-capture.mjs',
];

// Hook scripts that are safe to invoke directly via `wendkeep hook <name>`.
// (Excludes pure libraries like obsidian-common / linked-notes / token-usage /
// brain-core, which are imported by the entrypoints rather than run standalone.)
export const RUNNABLE_HOOKS = [
  'session-start',
  'session-ensure',
  'session-stop',
  'session-backfill',
  'decision-capture',
  'subagent-stop',
  'task-log',
  'brain-inject',
  'brain-recall',
  'brain-reindex',
  'vault-health',
  'understand-inject',
  'change-context',
  'change-warn',
  'change-guard',
  'change-nag',
  'plan-capture',
];

// The MCP server entry wendkeep wires into .mcp.json so the agent can read/write the
// vault. Uses the published mcpvault server (no secrets).
export function mcpServerEntry(vaultPath) {
  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@bitbonsai/mcpvault@latest', vaultPath],
  };
}
export const MCP_SERVER_KEY = 'wendkeep-vault';

// The three Claude Code session hooks, expressed as `wendkeep hook <name>` so the
// installed package is the single source of truth (update with `npm update wendkeep`,
// no re-copying). Returned as a spec the merge logic folds into settings.json.
export const SESSION_HOOKS = [
  // Memory + active-change injection. Runs FIRST on SessionStart (order -10, folds before
  // session-start) so the agent gets CORE + DIGEST + the active change + lessons as context.
  // matcher 'startup|clear|compact' re-injects after a compaction/clear, not only cold startup.
  // timeout 45 (was 15): measured ~4s warm via npx, but Windows startup contention (several npx
  // cold-starts at once — a sibling MCP took 26s in a real log) blew 15s and silently dropped the
  // memory injection for the whole session.
  { event: 'SessionStart', matcher: 'startup|clear|compact', name: 'brain-inject', timeout: 45, order: -10, statusMessage: 'wendkeep: injecting memory + active change' },
  { event: 'SessionStart', matcher: 'startup', name: 'session-start', timeout: 30, statusMessage: 'wendkeep: opening Obsidian session' },
  { event: 'Stop', matcher: null, name: 'session-stop', timeout: 60, statusMessage: 'wendkeep: writing session checkpoint' },
  { event: 'UserPromptSubmit', matcher: null, name: 'session-ensure', timeout: 30, statusMessage: 'wendkeep: ensuring active session' },
  // Capture an interactive decision (AskUserQuestion) — options + the user's choice — into 04-Decisões.
  { event: 'PostToolUse', matcher: 'AskUserQuestion', name: 'decision-capture', timeout: 15, statusMessage: 'wendkeep: recording decision' },
  // Refresh subagent/workflow telemetry as each subagent finishes (resilient to a missed Stop).
  { event: 'SubagentStop', matcher: null, name: 'subagent-stop', timeout: 20, statusMessage: 'wendkeep: subagent telemetry' },
  // Log plan/task progress into the active session note when a task is marked complete.
  { event: 'TaskCompleted', matcher: null, name: 'task-log', timeout: 10, statusMessage: 'wendkeep: plan progress' },
];

export function hookCommand(name) {
  return `npx wendkeep hook ${name}`;
}

// Forma node-direta do comando de hook: 1 processo (~100-250ms) em vez dos 3 do npx (cold-start
// de segundos no Windows). Usada pelos hooks de ALTA FREQUÊNCIA (por prompt / por tool-call)
// quando o projeto tem wendkeep instalado localmente; o init decide (hookCommandFor).
export function hookCommandLocal(name) {
  return `node node_modules/wendkeep/hooks/${name}.mjs`;
}

// Hooks do lifecycle de change (0.31.0) — enforcement do loop a2. Nudges (contexto/aviso/
// cobrança/captura de plano) e gate (deny/ask no Bash). Separados em dois grupos para
// preservar a opção futura de gates opt-in; hoje o init wira TODOS por default.
// preferLocal: alta frequência → invocação node-direta quando houver instalação local.
export const CHANGE_NUDGE_HOOKS = [
  { event: 'UserPromptSubmit', matcher: null, name: 'change-context', timeout: 15, order: 10, preferLocal: true, statusMessage: 'wendkeep: change ping' },
  { event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit', name: 'change-warn', timeout: 10, order: 10, preferLocal: true, statusMessage: 'wendkeep: change warn' },
  { event: 'PostToolUse', matcher: 'ExitPlanMode', name: 'plan-capture', timeout: 15, order: 10, preferLocal: true, statusMessage: 'wendkeep: capturing approved plan' },
  { event: 'Stop', matcher: null, name: 'change-nag', timeout: 15, order: 10, preferLocal: true, statusMessage: 'wendkeep: open tasks check' },
];
export const CHANGE_GATE_HOOKS = [
  { event: 'PreToolUse', matcher: 'Bash', name: 'change-guard', timeout: 10, order: 10, preferLocal: true, statusMessage: 'wendkeep: change gate' },
];

// --- companion plugins / MCP --------------------------------------------------
// Optional tools wendkeep init can pin alongside the vault. Each is wired through
// the MOST agent-agnostic mechanism it supports; the Claude Code plugin entry
// (extraKnownMarketplaces + enabledPlugins) is an additive bonus, never the base.
//   - mcp:          .mcp.json server entry (works on any MCP-capable agent)
//   - wendkeepHook: a wendkeep-authored hook (runs via `npx wendkeep hook`, any agent)
//   - installer:    cross-agent install script (used on non-Claude agents)
// marketplace/plugin shapes are verified against a real ~/.claude/settings.json.
export const COMPANIONS = [
  {
    id: 'context-mode',
    label: 'context-mode — otimizador de contexto + memória FTS5 (opcional)',
    // Not a default: wendkeep is a neutral harness and does not presume a third-party plugin.
    // Opt in interactively or with `--companions context-mode`.
    default: false,
    marketplace: { source: 'git', url: 'https://github.com/mksglu/context-mode.git' },
    plugin: 'context-mode',
    // NO .mcp.json entry on purpose: the plugin ships its OWN MCP server, so wiring both
    // double-registered it (two concurrent `npx context-mode` cold-starts at session start —
    // both timed out in a real log). Plugin is the single source; on non-Claude agents add the
    // MCP manually (`npx -y context-mode`).
  },
  {
    id: 'understand-anything',
    label: 'Understand-Anything — domain-graph do projeto',
    default: false,
    marketplace: { source: 'github', repo: 'Egonex-AI/Understand-Anything' },
    plugin: 'understand-anything',
    // No native SessionStart: wendkeep authors a conditional domain-graph injector.
    wendkeepHook: 'understand-inject',
  },
  {
    id: 'caveman',
    label: 'caveman — modo compressão de tokens',
    default: false,
    marketplace: { source: 'git', url: 'https://github.com/JuliusBrussee/caveman.git' },
    plugin: 'caveman',
    // No MCP, no agnostic hook: on non-Claude agents, run its own installer
    // (see cavemanInstallCommand — npx, non-interactive, Gemini excluded).
  },
  {
    id: 'dotcontext',
    // Legacy: wendkeep's native a2 loop (change/verify/gate) recreates dotcontext's role,
    // so it is no longer recommended — installing it would duplicate the native harness.
    // Kept selectable for anyone already invested in it; not a default.
    label: 'dotcontext — legado (o loop a2 nativo do wendkeep substitui; não recomendado)',
    default: false,
    // Hidden from the interactive/text companion picker — the native a2 loop replaces it.
    // Still reachable for anyone already invested via explicit `--companions dotcontext`.
    hidden: true,
    // MCP-only (no Claude Code plugin). Agent-agnostic server, @latest surface.
    mcp: { key: 'dotcontext', entry: { type: 'stdio', command: 'npx', args: ['-y', '@dotcontext/mcp@latest'], env: {} } },
    // Lifecycle hooks via the pinned CLI; wired by wendkeep (single writer).
    dotcontextHooks: { cliVersion: '1.1.1', source: 'claude-code' },
    // Seed a starter .context/config (one neutral sensor).
    contextSeed: true,
  },
];

const COMPANION_BY_ID = Object.fromEntries(COMPANIONS.map((c) => [c.id, c]));

// Companions offered in the interactive / text picker. Excludes `hidden` ones (e.g. the legacy
// dotcontext) — those stay reachable only via an explicit `--companions <id>`.
export function selectableCompanions() {
  return COMPANIONS.filter((c) => !c.hidden);
}

// Resolve the companion ids for the NON-interactive path (the interactive prompt
// supplies its own selection). --no-companions wins; an explicit flag selects the
// named ids (unknown dropped) in registry order; otherwise the defaults.
export function resolveCompanions({ companionsFlag, noCompanions } = {}) {
  if (noCompanions) return [];
  let wanted;
  if (typeof companionsFlag === 'string' && companionsFlag.trim()) {
    const set = new Set(companionsFlag.split(',').map((s) => s.trim()).filter(Boolean));
    wanted = (id) => set.has(id);
  } else {
    wanted = (id) => COMPANION_BY_ID[id]?.default === true;
  }
  return COMPANIONS.filter((c) => wanted(c.id)).map((c) => c.id);
}

// The settings.json fragment (Claude Code plugin layer) for the selected companions.
export function companionSettingsPatch(ids) {
  const extraKnownMarketplaces = {};
  const enabledPlugins = {};
  for (const id of ids) {
    const c = COMPANION_BY_ID[id];
    if (!c) continue;
    if (!c.marketplace || !c.plugin) continue; // MCP-only companions (e.g. dotcontext) have no plugin layer
    extraKnownMarketplaces[c.id] = { source: c.marketplace };
    enabledPlugins[`${c.plugin}@${c.id}`] = true;
  }
  return { extraKnownMarketplaces, enabledPlugins };
}

// The .mcp.json fragment (agent-agnostic layer) for MCP-capable companions only.
// `skip` omits ids whose MCP is already configured elsewhere (e.g. dotcontext set
// globally in ~/.claude.json — avoids a duplicate project-scoped server).
export function companionMcpPatch(ids, skip = []) {
  const skipSet = new Set(skip);
  const servers = {};
  for (const id of ids) {
    if (skipSet.has(id)) continue;
    const c = COMPANION_BY_ID[id];
    if (c?.mcp) servers[c.mcp.key] = c.mcp.entry;
  }
  return servers;
}

// SessionStart hook specs wendkeep must author for companions that lack a native
// one (only Understand-Anything's domain-graph injector today). Same shape as
// SESSION_HOOKS so the same merge logic wires them.
// `dotcontextHookLevel`: 'full' (SessionStart+Stop+PostToolUse), 'light' (drops the
// per-tool PostToolUse trace hook — cuts latency when other PostToolUse hooks exist),
// or 'none' (MCP only, no lifecycle hooks).
export function companionHookSpecs(ids, { dotcontextHookLevel = 'full' } = {}) {
  const specs = [];
  for (const id of ids) {
    const c = COMPANION_BY_ID[id];
    if (c?.wendkeepHook) {
      specs.push({
        event: 'SessionStart',
        matcher: null,
        name: c.wendkeepHook,
        timeout: 15,
        order: 0,
        statusMessage: `wendkeep: ${c.id} domain graph`,
      });
    }
    // dotcontext: lifecycle hooks (SessionStart last + Stop + PostToolUse) that
    // dispatch to its pinned CLI. They carry an explicit `command` (not a wendkeep
    // hook name) and order 100 so they fold AFTER wendkeep's own session hooks.
    if (c?.dotcontextHooks && dotcontextHookLevel !== 'none') {
      const command = dotcontextHookCommand(c.dotcontextHooks.cliVersion, c.dotcontextHooks.source);
      const base = { command, timeout: 8, order: 100, statusMessage: `${c.id}: harness hook` };
      specs.push({ event: 'SessionStart', matcher: null, ...base });
      specs.push({ event: 'Stop', matcher: null, ...base });
      if (dotcontextHookLevel === 'full') {
        specs.push({ event: 'PostToolUse', matcher: 'Write|Edit|Bash', ...base });
      }
    }
  }
  return specs;
}

// The pinned dotcontext CLI hook-dispatch command (runs on each lifecycle event).
export function dotcontextHookCommand(cliVersion, source) {
  return `npx -y @dotcontext/cli@${cliVersion} hook dispatch --source ${source}`;
}

// .context/ subpaths that should be gitignored (runtime/cache/regenerable). wendkeep
// does not touch git — init prints these as a note for the user to add.
export const DOTCONTEXT_GITIGNORE = [
  '.context/runtime/',
  '.context/cache/',
  '.context/logs/',
  '.context/plans/',
  '.context/agents/',
  '.context/skills/',
];

// Agents wendkeep installs caveman into via its cross-agent installer. Gemini is
// excluded on purpose: its CLI rejects caveman's agent tool names and crashes
// (libuv assertion) mid-install. caveman has no --exclude flag — only an --only
// allow-list — so we enumerate the agents we want by their stable slugs.
export const CAVEMAN_AGENTS = ['claude', 'codex', 'cursor', 'copilot', 'amp', 'antigravity'];

// Non-interactive command installing caveman to CAVEMAN_AGENTS (never Gemini). Runs
// the published installer directly via npx (no install.ps1, so no $PSCommandPath
// issue). Returned as a shell string; the caller spawns it with shell: true.
export function cavemanInstallCommand(agents = CAVEMAN_AGENTS) {
  const only = agents.flatMap((a) => ['--only', a]).join(' ');
  return `npx -y github:JuliusBrussee/caveman -- --non-interactive ${only}`;
}

// Derive the default vault folder name from the project folder: `.<project>-vault`.
// Splits on both separators so it is correct regardless of host OS, sanitizes
// filesystem-unsafe characters, preserves case, and falls back to a stable name
// when the basename is empty (root paths). Pure + side-effect free.
export function deriveVaultDirName(projectPath) {
  const base = String(projectPath || '')
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || '';
  const clean = base
    .replace(/^[.\s]+/, '') // drop leading dots/space so we never get `..name`
    .replace(/[<>:"/\\|?* -]/g, '-') // FS-unsafe chars -> dash
    .replace(/\s+/g, '-') // whitespace -> dash
    .replace(/-+/g, '-') // collapse dash runs
    .replace(/^-+|-+$/g, '') // trim edge dashes
    .replace(/\.+$/, ''); // trim trailing dots
  return clean ? `.${clean}-vault` : '.wendkeep-vault';
}
