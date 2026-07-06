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
  'vault-health.mjs',
  'understand-inject.mjs',
];

// Hook scripts that are safe to invoke directly via `wendkeep hook <name>`.
// (Excludes pure libraries like obsidian-common / linked-notes / token-usage /
// brain-core, which are imported by the entrypoints rather than run standalone.)
export const RUNNABLE_HOOKS = [
  'session-start',
  'session-ensure',
  'session-stop',
  'session-backfill',
  'brain-inject',
  'brain-recall',
  'brain-reindex',
  'vault-health',
  'understand-inject',
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
  { event: 'SessionStart', matcher: 'startup', name: 'session-start', timeout: 30, statusMessage: 'wendkeep: opening Obsidian session' },
  { event: 'Stop', matcher: null, name: 'session-stop', timeout: 60, statusMessage: 'wendkeep: writing session checkpoint' },
  { event: 'UserPromptSubmit', matcher: null, name: 'session-ensure', timeout: 30, statusMessage: 'wendkeep: ensuring active session' },
];

export function hookCommand(name) {
  return `npx wendkeep hook ${name}`;
}

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
    label: 'context-mode — otimizador de contexto + memória FTS5 (principal)',
    default: true,
    marketplace: { source: 'git', url: 'https://github.com/mksglu/context-mode.git' },
    plugin: 'context-mode',
    // Agent-agnostic: MCP server, self-updating via unpinned npx.
    mcp: { key: 'context-mode', entry: { type: 'stdio', command: 'npx', args: ['-y', 'context-mode'] } },
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
    // MCP-only (no Claude Code plugin). Agent-agnostic server, @latest surface.
    mcp: { key: 'dotcontext', entry: { type: 'stdio', command: 'npx', args: ['-y', '@dotcontext/mcp@latest'], env: {} } },
    // Lifecycle hooks via the pinned CLI; wired by wendkeep (single writer).
    dotcontextHooks: { cliVersion: '1.1.1', source: 'claude-code' },
    // Seed a starter .context/config (one neutral sensor).
    contextSeed: true,
  },
];

const COMPANION_BY_ID = Object.fromEntries(COMPANIONS.map((c) => [c.id, c]));

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
