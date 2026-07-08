// `wendkeep init` — cross-platform replacement for setup-vault.ps1.
// Creates the vault taxonomy, NON-DESTRUCTIVELY merges the session hooks +
// OBSIDIAN_VAULT_PATH into .claude/settings.json, and adds the mcpvault server to
// .mcp.json. Idempotent: re-running only adds what is missing.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  VAULT_FOLDERS,
  SESSION_HOOKS,
  MCP_SERVER_KEY,
  mcpServerEntry,
  hookCommand,
  deriveVaultDirName,
  selectableCompanions,
  resolveCompanions,
  companionSettingsPatch,
  companionMcpPatch,
  companionHookSpecs,
  cavemanInstallCommand,
  DOTCONTEXT_GITIGNORE,
} from './taxonomy.mjs';
import { renderVaultReadme } from './vault-readme.mjs';
import { seedVaultViews } from './vault-views.mjs';
import { canInteractiveSelect, selectCompanionsInteractive } from './companion-select.mjs';
import {
  SNIPPET_NAME,
  renderColorSnippetCss,
  mergeAppearance,
  graphColorGroups,
  mergeGraphColorGroups,
} from './vault-theme.mjs';
import { renderCoreSkeleton, renderCompactionProtocol } from './validate-core.mjs';
import { seedDefinitions, syncDefs } from './sync-defs.mjs';
import { seedWkSkills } from './skills-seed.mjs';
import { LOCALES, DEFAULT_LOCALE, getLocale, clearLocaleCache, vaultFolders } from '../hooks/locale.mjs';
import { seedDotcontext, globalHasDotcontext, resolveDotcontextSkipMcp, renderSensorsJson } from './dotcontext-seed.mjs';

function parseArgs(argv) {
  const args = { mcp: true, yes: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--vault') args.vault = argv[++i];
    else if (a === '--locale') args.locale = argv[++i];
    else if (a.startsWith('--locale=')) args.locale = a.slice(9);
    else if (a === '--project') args.project = argv[++i];
    else if (a === '--no-mcp') args.mcp = false;
    else if (a === '--yes' || a === '-y') args.yes = true;
    else if (a === '--force') args.force = true;
    else if (a === '--no-companions') args.noCompanions = true;
    else if (a === '--no-colors') args.noColors = true;
    else if (a === '--dotcontext-mcp') args.dotcontextMcp = argv[++i];
    else if (a.startsWith('--dotcontext-mcp=')) args.dotcontextMcp = a.slice(17);
    else if (a === '--dotcontext-hooks') args.dotcontextHooks = argv[++i];
    else if (a.startsWith('--dotcontext-hooks=')) args.dotcontextHooks = a.slice(19);
    else if (a === '--companions') args.companions = argv[++i];
    else if (a.startsWith('--companions=')) args.companions = a.slice(13);
    else if (a.startsWith('--vault=')) args.vault = a.slice(8);
    else if (a.startsWith('--project=')) args.project = a.slice(10);
  }
  return args;
}

function readJsonSafe(path) {
  // Returns { ok, data }. ok=false means the file exists but is not parseable —
  // caller must NOT clobber it (we write a *.new beside it instead).
  if (!existsSync(path)) return { ok: true, data: null };
  try {
    return { ok: true, data: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { ok: false, data: null };
  }
}

function writeJson(path, obj) {
  ensureParent(path);
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function ensureParent(path) {
  const dir = resolve(path, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function backup(path) {
  const bak = `${path}.bak`;
  if (!existsSync(bak)) copyFileSync(path, bak);
  return bak;
}

// --- merges -----------------------------------------------------------------

export function mergeSettings(existing, { vaultPath, withMcp, force, companions = [], skipMcp = [], dotcontextHookLevel = 'full' }) {
  const s = existing && typeof existing === 'object' ? { ...existing } : {};
  s.hooks = { ...(s.hooks || {}) };
  let added = 0;
  // wendkeep's own session hooks + any companion-authored hooks. Stable-sort by
  // `order` (default 0) so higher-order companion hooks (e.g. dotcontext's order 100)
  // fold AFTER wendkeep's own within each event. A spec may carry its own `command`
  // (dotcontext dispatch) instead of a wendkeep hook `name`.
  const allSpecs = [...SESSION_HOOKS, ...companionHookSpecs(companions, { dotcontextHookLevel })].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0),
  );
  for (const h of allSpecs) {
    const command = h.command ?? hookCommand(h.name);
    const groups = Array.isArray(s.hooks[h.event]) ? [...s.hooks[h.event]] : [];
    const owning = groups.find((g) => (g.hooks || []).some((x) => x.command === command));
    if (owning) {
      // Already wired: never add a duplicate group (the old `if (present && !force)` fell through
      // under --force and appended a second identical group). Under --force, refresh the managed
      // entry's fields in place — without disturbing any sibling hooks the user grouped with it.
      if (force) {
        const hk = owning.hooks.find((x) => x.command === command);
        hk.timeout = h.timeout;
        if (h.statusMessage) hk.statusMessage = h.statusMessage;
        if (h.matcher && (owning.hooks || []).length === 1) owning.matcher = h.matcher;
      }
      s.hooks[h.event] = groups;
      continue;
    }
    const entry = { type: 'command', command, timeout: h.timeout, statusMessage: h.statusMessage };
    const group = h.matcher ? { matcher: h.matcher, hooks: [entry] } : { hooks: [entry] };
    groups.push(group);
    s.hooks[h.event] = groups;
    added += 1;
  }
  s.env = { ...(s.env || {}), OBSIDIAN_VAULT_PATH: vaultPath };

  // Claude Code plugin layer for the selected companions (additive, non-clobbering).
  const cp = companionSettingsPatch(companions);
  if (Object.keys(cp.extraKnownMarketplaces).length) {
    s.extraKnownMarketplaces = { ...(s.extraKnownMarketplaces || {}), ...cp.extraKnownMarketplaces };
  }
  if (Object.keys(cp.enabledPlugins).length) {
    s.enabledPlugins = { ...(s.enabledPlugins || {}), ...cp.enabledPlugins };
  }

  const companionMcp = Object.keys(companionMcpPatch(companions, skipMcp));
  if (withMcp || companionMcp.length) {
    const set = new Set(Array.isArray(s.enabledMcpjsonServers) ? s.enabledMcpjsonServers : []);
    if (withMcp) set.add(MCP_SERVER_KEY);
    for (const key of companionMcp) set.add(key);
    s.enabledMcpjsonServers = [...set];
  }
  return { settings: s, added };
}

export function mergeMcp(existing, { vaultPath, withVault = true, companions = [], skipMcp = [] }) {
  const m = existing && typeof existing === 'object' ? { ...existing } : {};
  m.mcpServers = { ...(m.mcpServers || {}) };
  if (withVault) m.mcpServers[MCP_SERVER_KEY] = mcpServerEntry(vaultPath);
  Object.assign(m.mcpServers, companionMcpPatch(companions, skipMcp));
  return m;
}

// Run caveman's cross-agent installer (non-Claude skill coverage). Downloads the
// script to a temp file and runs it as a FILE — piping to iex/bash leaves the
// script's self-path null and the installer aborts. Best-effort, fail-soft: the
// Claude Code plugin entry is already wired regardless.
function runCavemanInstaller(log) {
  const cmd = cavemanInstallCommand();
  log(`\n  caveman: running cross-agent installer (best-effort, Gemini skipped):\n    ${cmd}`);
  try {
    const r = spawnSync(cmd, { stdio: 'inherit', shell: true });
    if (r.status !== 0) {
      log(`  [!] caveman installer exited ${r.status ?? '?'} — Claude Code plugin entry still wired; rerun manually if needed.`);
    }
  } catch (e) {
    log(`  [!] caveman installer skipped (${e.message}) — Claude Code plugin entry still wired.`);
  }
}

// Install the vault color system into .obsidian: write wendkeep's CSS snippet,
// enable it (non-destructive), and add graph color groups. Returns a short note.
// Unparseable user JSON is left untouched (we only merge into valid/absent files).
function installVaultColors(vaultPath) {
  const loc = getLocale(vaultPath);
  const obsidianDir = join(vaultPath, '.obsidian');
  const snippetsDir = join(obsidianDir, 'snippets');
  mkdirSync(snippetsDir, { recursive: true });
  writeFileSync(join(snippetsDir, `${SNIPPET_NAME}.css`), renderColorSnippetCss(loc), 'utf8');

  let enabled = false;
  const appPath = join(obsidianDir, 'appearance.json');
  const appRead = readJsonSafe(appPath);
  if (appRead.ok) {
    writeJson(appPath, mergeAppearance(appRead.data || {}, SNIPPET_NAME));
    enabled = true;
  }

  let groups = 0;
  const graphPath = join(obsidianDir, 'graph.json');
  const graphRead = readJsonSafe(graphPath);
  if (graphRead.ok) {
    const merged = mergeGraphColorGroups(graphRead.data || {}, graphColorGroups(loc));
    writeJson(graphPath, merged);
    groups = graphColorGroups(loc).length;
  }
  return `snippet ${SNIPPET_NAME}.css${enabled ? ' (enabled)' : ' (enable by hand: appearance.json unreadable)'} + ${groups} graph group(s)`;
}

// --- main -------------------------------------------------------------------

// Interactive prompt strings by locale. The language question itself is bilingual (asked
// before the locale is known); everything after follows the answer.
const PROMPTS = {
  'pt-BR': {
    vault: (f) => `Caminho do vault Obsidian (Enter aceita o padrão, ou digite outro)\n  [${f}]\n> `,
    companionsHeader: '\nCompanions (plugins/MCP opcionais — nenhum vem pré-marcado):',
    companionsAsk: (def) => `Digite os ids separados por vírgula (Enter aceita [${def}], "none" p/ nenhum): `,
    menu: { hint: 'Espaço marca/desmarca · ↑/↓ move · a=todos · n=nenhum · Enter confirma', header: 'Companions' },
  },
  en: {
    vault: (f) => `Obsidian vault path (Enter for the default, or type another)\n  [${f}]\n> `,
    companionsHeader: '\nCompanions (optional plugins/MCP — none pre-selected):',
    companionsAsk: (def) => `Enter ids comma-separated (Enter for [${def}], "none" for none): `,
    menu: { hint: 'Space toggles · ↑/↓ move · a=all · n=none · Enter confirms', header: 'Companions' },
  },
};

export function promptStrings(localeId) {
  return PROMPTS[localeId] || PROMPTS['pt-BR'];
}

// Map the language answer to a locale id. 2/en → en; 1/pt/empty/unknown → pt-BR.
export function parseLocaleAnswer(ans) {
  const a = String(ans || '').trim().toLowerCase();
  if (a === '2' || a === 'en' || a === 'english') return 'en';
  return 'pt-BR';
}

export async function runInit(argv) {
  const args = parseArgs(argv);
  const projectPath = resolve(args.project || process.cwd());
  const log = (s) => process.stdout.write(`${s}\n`);

  // Language first (i18n): an interactive TTY without --locale is asked the vault language;
  // folders, prompts and scaffold all follow the answer.
  if (!args.locale && process.stdin.isTTY && !args.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question('Idioma do vault / Vault language:\n  [1] Português (pt-BR)   [2] English (en)\n> ');
    rl.close();
    args.locale = parseLocaleAnswer(ans);
  }
  const P = promptStrings(args.locale && LOCALES[args.locale] ? args.locale : DEFAULT_LOCALE);

  let vaultPath = args.vault;
  if (!vaultPath) {
    const fallback = join(projectPath, deriveVaultDirName(projectPath));
    if (process.stdin.isTTY && !args.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ans = (await rl.question(P.vault(fallback))).trim();
      rl.close();
      vaultPath = ans || fallback;
    } else {
      vaultPath = fallback;
    }
  }
  vaultPath = isAbsolute(vaultPath) ? vaultPath : resolve(projectPath, vaultPath);

  // Companion plugins/MCP selection. --no-companions wins; --companions <csv> is
  // explicit; an interactive TTY gets a multi-choice prompt (context-mode pre-checked);
  // otherwise the non-interactive default (context-mode only).
  let companions;
  if (args.noCompanions) {
    companions = [];
  } else if (args.companions !== undefined) {
    companions = resolveCompanions({ companionsFlag: args.companions });
  } else if (process.stdin.isTTY && !args.yes) {
    if (canInteractiveSelect()) {
      log(''); // the checkbox menu renders its own header
      companions = await selectCompanionsInteractive(selectableCompanions(), { labels: P.menu });
    } else {
      // Text fallback (no raw-mode TTY): list + comma input with clear instructions.
      log(P.companionsHeader);
      for (const c of selectableCompanions()) log(`  ${c.default ? '[x]' : '[ ]'} ${c.label}`);
      const def = resolveCompanions({}).join(',');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ans = (await rl.question(P.companionsAsk(def))).trim();
      rl.close();
      companions = ans.toLowerCase() === 'none' ? [] : resolveCompanions({ companionsFlag: ans || def });
    }
  } else {
    companions = resolveCompanions({});
  }

  log('\nwendkeep init');
  log(`  project    : ${projectPath}`);
  log(`  vault      : ${vaultPath}`);
  log(`  mcp        : ${args.mcp ? 'mcpvault (wendkeep-vault)' : 'skipped'}`);
  log(`  companions : ${companions.length ? companions.join(', ') : 'none'}`);
  log(`  colors     : ${args.noColors ? 'skipped' : 'wendkeep-colors (snippet + graph groups)'}\n`);

  // dotcontext controls (only relevant when selected): hook level + MCP placement.
  // Skip the project MCP entry when dotcontext is already global (avoids a duplicate
  // server / version clash); --dotcontext-mcp project|none and --dotcontext-hooks
  // full|light|none override.
  const dotcontextHookLevel = args.dotcontextHooks || 'full';
  const skipMcp = [];
  if (companions.includes('dotcontext') && resolveDotcontextSkipMcp(args.dotcontextMcp, globalHasDotcontext())) {
    skipMcp.push('dotcontext');
  }

  // 1. Vault taxonomy ---------------------------------------------------------
  // Locale (0.8.0): a vault property, locked at init. Written BEFORE folder creation so
  // the folder names follow it. Invalid/absent = pt-BR (backward compat).
  if (!existsSync(vaultPath)) mkdirSync(vaultPath, { recursive: true });
  const localeId = args.locale && LOCALES[args.locale] ? args.locale : DEFAULT_LOCALE;
  if (args.locale && !LOCALES[args.locale]) {
    log(`  ! locale desconhecido "${args.locale}" — usando ${DEFAULT_LOCALE} (opções: ${Object.keys(LOCALES).join(', ')})`);
  }
  mkdirSync(join(vaultPath, '.brain'), { recursive: true });
  const configPath = join(vaultPath, '.brain', 'config.json');
  if (!existsSync(configPath)) writeFileSync(configPath, `${JSON.stringify({ locale: localeId }, null, 2)}\n`, 'utf8');
  clearLocaleCache();
  const loc = getLocale(vaultPath);
  const folders = vaultFolders(loc);
  let created = 0;
  for (const f of folders) {
    const p = join(vaultPath, f);
    if (!existsSync(p)) {
      mkdirSync(p, { recursive: true });
      created += 1;
    }
  }
  // Generate a project-templated vault README (non-destructive: never clobber one).
  const readmePath = join(vaultPath, 'README.md');
  let readmeNote = '';
  if (!existsSync(readmePath)) {
    writeFileSync(readmePath, renderVaultReadme({ projectName: basename(projectPath), vaultPath, withMcp: args.mcp, locale: loc.id }), 'utf8');
    readmeNote = ', README.md created';
  }
  // Seed the curated memory layer (CORE.md) + the compaction-protocol doc. The
  // DIGEST/index are auto-generated by the hooks; CORE is hand-curated, so we
  // bootstrap it with the 3 required sections. Non-destructive.
  const brainDir = join(vaultPath, '.brain');
  mkdirSync(brainDir, { recursive: true });
  const corePath = join(brainDir, 'CORE.md');
  if (!existsSync(corePath)) writeFileSync(corePath, renderCoreSkeleton(loc.id), 'utf8');
  const protoPath = join(brainDir, 'COMPACTION_PROTOCOL.md');
  if (!existsSync(protoPath)) writeFileSync(protoPath, renderCompactionProtocol(), 'utf8');
  // Seed the definitions layer (.brain/agents + .brain/skills): versioned source of
  // truth for custom agents/skills. `wendkeep sync-defs` copies them to the agent dirs.
  seedDefinitions(brainDir);
  seedWkSkills(brainDir, loc.id); // Pilar A: native process skills, in the vault locale.
  // Seed the change/spec layer starters (Pilar B) — non-destructive.
  const en = loc.id === 'en';
  const specsReadme = join(vaultPath, loc.folders.specs, 'README.md');
  if (!existsSync(specsReadme)) {
    writeFileSync(specsReadme, en
      ? `# Specs — living contract\n\nThe project's capabilities (requirements/scenarios). Changes in \`${loc.folders.changes}/\` promote deltas here on \`wendkeep change archive\`.\n`
      : `# Specs — contrato vivo\n\nCapacidades do projeto (requisitos/cenários). Changes em \`${loc.folders.changes}/\` promovem deltas aqui no \`wendkeep change archive\`.\n`, 'utf8');
  }
  const changeTpl = join(vaultPath, 'Templates', 'Change.md');
  if (!existsSync(changeTpl)) {
    writeFileSync(changeTpl, en
      ? '---\ntype: change\nstatus: active\ncssclasses:\n  - topic-change\n---\n\n# <slug>\n\n## Why\n\n## What changes\n'
      : '---\ntype: change\nstatus: active\ncssclasses:\n  - topic-change\n---\n\n# <slug>\n\n## Por quê\n\n## O que muda\n', 'utf8');
  }
  // Seed the native sensor config (Pilar C) at project root — non-destructive.
  const sensorsFile = join(projectPath, 'wendkeep.sensors.json');
  if (!existsSync(sensorsFile)) {
    let scripts = {};
    try { scripts = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf8')).scripts || {}; } catch { /* no package.json */ }
    writeFileSync(sensorsFile, renderSensorsJson(scripts), 'utf8');
  }
  // Generated Bases + Dashboard MOC (folder-filtered views over the taxonomy) — non-destructive.
  let viewsNote = '';
  try {
    const views = seedVaultViews(vaultPath);
    if (views.length) viewsNote = `, ${views.length} view(s) + dashboard`;
  } catch { /* views são bônus — nunca derrubam o init */ }
  log(`  [1/4] vault taxonomy: ${folders.length} folders (${created} created, locale ${loc.id})${readmeNote}, .brain + change/spec + sensors seeded${viewsNote}`);
  // Deliver the seeded defs (agents + wk process skills) to the project so they're
  // usable immediately — no separate `wendkeep sync-defs` step needed.
  const synced = syncDefs(vaultPath, projectPath);
  if (synced.skills.length || synced.agents.length) {
    log(`        defs delivered: ${synced.skills.length} skill(s) -> .claude/skills, ${synced.agents.length} agent(s) -> .codex/agents`);
  }

  // 2. .claude/settings.json --------------------------------------------------
  const settingsPath = join(projectPath, '.claude', 'settings.json');
  const settingsRead = readJsonSafe(settingsPath);
  if (!settingsRead.ok) {
    // Unparseable existing file — never clobber. Drop a .new for manual merge.
    const fresh = mergeSettings(null, { vaultPath, withMcp: args.mcp, force: true, companions, skipMcp, dotcontextHookLevel }).settings;
    writeJson(`${settingsPath}.new`, fresh);
    log(`  [2/4] settings.json exists but is not valid JSON -> wrote ${settingsPath}.new (merge by hand)`);
  } else {
    const hadFile = settingsRead.data !== null;
    const { settings, added } = mergeSettings(settingsRead.data, { vaultPath, withMcp: args.mcp, force: args.force, companions, skipMcp, dotcontextHookLevel });
    if (hadFile) backup(settingsPath);
    writeJson(settingsPath, settings);
    log(`  [2/4] settings.json ${hadFile ? 'merged' : 'created'} (${added} hook(s) wired, OBSIDIAN_VAULT_PATH set${hadFile ? ', .bak saved' : ''})`);
  }

  // 3. .mcp.json --------------------------------------------------------------
  // Written when mcpvault is wanted OR a selected companion ships an MCP server.
  const companionMcp = companionMcpPatch(companions, skipMcp);
  if (args.mcp || Object.keys(companionMcp).length) {
    const mcpPath = join(projectPath, '.mcp.json');
    const mcpRead = readJsonSafe(mcpPath);
    const mcpOpts = { vaultPath, withVault: args.mcp, companions, skipMcp };
    const names = [args.mcp && MCP_SERVER_KEY, ...Object.keys(companionMcp)].filter(Boolean).join(', ');
    if (!mcpRead.ok) {
      writeJson(`${mcpPath}.new`, mergeMcp(null, mcpOpts));
      log(`  [3/4] .mcp.json exists but is not valid JSON -> wrote ${mcpPath}.new (merge by hand)`);
    } else {
      const hadFile = mcpRead.data !== null;
      if (hadFile) backup(mcpPath);
      writeJson(mcpPath, mergeMcp(mcpRead.data, mcpOpts));
      log(`  [3/4] .mcp.json ${hadFile ? 'merged' : 'created'} (${names}${hadFile ? ', .bak saved' : ''})`);
    }
  } else {
    log('  [3/4] .mcp.json skipped (--no-mcp, no MCP companions)');
  }

  // 4. Vault color system (.obsidian) -----------------------------------------
  if (args.noColors) {
    log('  [4/4] colors skipped (--no-colors)');
  } else {
    log(`  [4/4] colors: ${installVaultColors(vaultPath)}`);
  }

  // caveman has no MCP / agnostic-hook path: on non-Claude agents its skills come
  // from its own cross-agent installer. Best-effort, fail-soft — the Claude Code
  // plugin entry is already wired in settings.json regardless.
  if (companions.includes('caveman')) runCavemanInstaller(log);

  // dotcontext: MCP + lifecycle hooks are wired by mergeSettings/mergeMcp above;
  // here we seed the versioned .context/config starter and print the gitignore note.
  if (companions.includes('dotcontext')) {
    const seeded = seedDotcontext(projectPath);
    const mcpNote = skipMcp.includes('dotcontext') ? 'MCP global (project entry skipped)' : 'MCP (project)';
    log(`\n  dotcontext: ${mcpNote} + hooks(${dotcontextHookLevel}); .context/config seeded (${seeded.length} file(s)).`);
    log(`  [!] add to .gitignore (wendkeep não toca git): ${DOTCONTEXT_GITIGNORE.join(' ')}`);
  }

  log('\nNext steps:');
  log(`  1. Open the vault in Obsidian: "Open folder as vault" -> ${vaultPath}`);
  log('  2. Make sure wendkeep is installed where the agent runs (npm i -D wendkeep, or -g).');
  log('  3. Open Claude Code in this project and send a test prompt.');
  log('  4. Confirm a note appears under 02-Sessões/<year>/<month>/DIA <dd>/ in the vault.');
  log('  Update later with: npm update wendkeep  (no re-copying — hooks live in the package).\n');
}
