// `wendkeep init` — cross-platform replacement for setup-vault.ps1.
// Creates the vault taxonomy, NON-DESTRUCTIVELY merges the session hooks +
// OBSIDIAN_VAULT_PATH into .claude/settings.json, and adds the mcpvault server to
// .mcp.json. Idempotent: re-running only adds what is missing.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  VAULT_FOLDERS,
  SESSION_HOOKS,
  CHANGE_NUDGE_HOOKS,
  CHANGE_GATE_HOOKS,
  MCP_SERVER_KEY,
  mcpServerEntry,
  hookCommand,
  hookCommandLocal,
  hookCommandLocalLegacy,
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
import { adoptSpecsState, SPECS_STATE_FILE } from '../hooks/spec-core.mjs';

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

// Comando preferido para um hook: node-direto quando o projeto tem o pacote local (alta
// frequência sem cold-start de npx — ver R3 do design 0.31.0); senão o npx portátil.
export function hookCommandFor(name, projectPath) {
  try {
    if (projectPath && existsSync(join(projectPath, 'node_modules', 'wendkeep', 'hooks', `${name}.mjs`))) {
      return hookCommandLocal(name);
    }
  } catch { /* fs indisponível — npx */ }
  return hookCommand(name);
}

function localHookAvailable(name, projectPath) {
  try {
    return !!projectPath && existsSync(join(projectPath, 'node_modules', 'wendkeep', 'hooks', `${name}.mjs`));
  } catch { return false; }
}

function localHookArg(name) {
  return `${'${CLAUDE_PROJECT_DIR}'}/node_modules/wendkeep/hooks/${name}.mjs`;
}

export function mergeSettings(existing, { vaultPath, withMcp, force, companions = [], skipMcp = [], dotcontextHookLevel = 'full', projectPath = '' }) {
  const s = existing && typeof existing === 'object' ? { ...existing } : {};
  s.hooks = { ...(s.hooks || {}) };
  let added = 0;
  // wendkeep's own session hooks + the change-lifecycle hooks (0.31.0, default) + any
  // companion-authored hooks. Stable-sort by `order` (default 0) so higher-order companion
  // hooks (e.g. dotcontext's order 100) fold AFTER wendkeep's own within each event. A spec
  // may carry its own `command` (dotcontext dispatch) instead of a wendkeep hook `name`.
  const allSpecs = [
    ...SESSION_HOOKS,
    ...CHANGE_NUDGE_HOOKS,
    ...CHANGE_GATE_HOOKS,
    ...companionHookSpecs(companions, { dotcontextHookLevel }),
  ].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const h of allSpecs) {
    const useLocal = !h.command && h.preferLocal && localHookAvailable(h.name, projectPath);
    const command = h.command ?? (useLocal ? 'node' : hookCommand(h.name));
    const args = useLocal ? [localHookArg(h.name)] : undefined;
    // Dual-recognition: um hook nomeado é reconhecido tanto na forma npx quanto na node-direta,
    // para que trocar a forma preferida (ou re-initar noutra máquina) nunca duplique o grupo.
    const candidates = h.command ? [h.command] : [hookCommand(h.name), hookCommandLocal(h.name), hookCommandLocalLegacy(h.name)];
    const ownsHook = (x) => candidates.includes(x.command)
      || (x.command === 'node' && Array.isArray(x.args) && x.args[0] === localHookArg(h.name));
    const groups = Array.isArray(s.hooks[h.event]) ? [...s.hooks[h.event]] : [];
    const owning = groups.find((g) => (g.hooks || []).some(ownsHook));
    if (owning) {
      // Already wired: never add a duplicate group (the old `if (present && !force)` fell through
      // under --force and appended a second identical group). Under --force, refresh the managed
      // entry's fields in place — without disturbing any sibling hooks the user grouped with it.
      const hk = owning.hooks.find(ownsHook);
      const brokenRelative = hk?.command === hookCommandLocalLegacy(h.name);
      if (force || brokenRelative) {
        hk.command = command;
        if (args) hk.args = args;
        else delete hk.args;
        hk.timeout = h.timeout;
        if (h.statusMessage) hk.statusMessage = h.statusMessage;
        if (h.matcher && (owning.hooks || []).length === 1) owning.matcher = h.matcher;
      }
      s.hooks[h.event] = groups;
      continue;
    }
    const entry = { type: 'command', command, timeout: h.timeout, statusMessage: h.statusMessage };
    if (args) entry.args = args;
    const group = h.matcher ? { matcher: h.matcher, hooks: [entry] } : { hooks: [entry] };
    groups.push(group);
    s.hooks[h.event] = groups;
    added += 1;
  }
  s.env = { ...(s.env || {}), OBSIDIAN_VAULT_PATH: vaultPath };
  // npx-launched stdio MCPs (wendkeep-vault included) can cold-start near/over Claude Code's 30s
  // default under Windows startup contention (26s observed in a real log). Give them headroom —
  // but never clobber a value the user already set.
  if (!('MCP_TIMEOUT' in s.env)) s.env.MCP_TIMEOUT = '60000';

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

// Output messages by locale — the summary, the [n/4] steps and the next-steps block follow the
// chosen vault language (before this, a pt-BR install still printed English output).
const MESSAGES = {
  'pt-BR': {
    header: '\nwendkeep init',
    lProject: '  projeto    ', lVault: '  vault      ', lMcp: '  mcp        ',
    lCompanions: '  companions ', lColors: '  cores      ',
    skipped: 'ignorado', none: 'nenhum',
    colorsOn: 'wendkeep-colors (snippet + grupos do grafo)',
    taxonomy: (n, c, loc, readme, views) => `  [1/4] taxonomia do vault: ${n} pastas (${c} criadas, locale ${loc})${readme}, .brain + change/spec + sensores semeados${views}`,
    readmeCreated: ', README.md criado', viewsNote: (n) => `, ${n} view(s) + dashboard`,
    defs: (s, a) => `        defs entregues: ${s} skill(s) -> .claude/skills + .agents/skills, ${a} agent(s) -> .codex/agents`,
    settingsBadJson: (p) => `  [2/4] settings.json existe mas não é JSON válido -> escrevi ${p}.new (mescle à mão)`,
    settings: (verb, added, bak) => `  [2/4] settings.json ${verb} (${added} hook(s) wirados, OBSIDIAN_VAULT_PATH setado${bak})`,
    mcpBadJson: (p) => `  [3/4] .mcp.json existe mas não é JSON válido -> escrevi ${p}.new (mescle à mão)`,
    mcp: (verb, names, bak) => `  [3/4] .mcp.json ${verb} (${names}${bak})`,
    mcpSkipped: '  [3/4] .mcp.json ignorado (--no-mcp, sem companions MCP)',
    colorsSkipped: '  [4/4] cores ignoradas (--no-colors)',
    colors: (r) => `  [4/4] cores: ${r}`,
    merged: 'mesclado', created: 'criado', bakSaved: ', .bak salvo',
    nextSteps: '\nPróximos passos:',
    step1: (v) => `  1. Abra o vault no Obsidian: "Abrir pasta como cofre" -> ${v}`,
    step2: '  2. Garanta que o wendkeep está instalado onde o agente roda (npm i -D wendkeep, ou -g).',
    step3: '  3. Abra o Claude Code neste projeto e envie um prompt de teste.',
    step4: '  4. Confirme que uma nota aparece em 02-Sessões/<ano>/<mês>/DIA <dd>/ no vault.',
    updateLater: '  Atualize depois com: npm update wendkeep  (sem recopiar — os hooks vivem no pacote).\n',
    vaultRegistered: (v, loc) => `\n  cofre já registrado neste projeto: ${v} (locale ${loc}) — pergunta pulada. Use --vault para mudar.`,
  },
  en: {
    header: '\nwendkeep init',
    lProject: '  project    ', lVault: '  vault      ', lMcp: '  mcp        ',
    lCompanions: '  companions ', lColors: '  colors     ',
    skipped: 'skipped', none: 'none',
    colorsOn: 'wendkeep-colors (snippet + graph groups)',
    taxonomy: (n, c, loc, readme, views) => `  [1/4] vault taxonomy: ${n} folders (${c} created, locale ${loc})${readme}, .brain + change/spec + sensors seeded${views}`,
    readmeCreated: ', README.md created', viewsNote: (n) => `, ${n} view(s) + dashboard`,
    defs: (s, a) => `        defs delivered: ${s} skill(s) -> .claude/skills + .agents/skills, ${a} agent(s) -> .codex/agents`,
    settingsBadJson: (p) => `  [2/4] settings.json exists but is not valid JSON -> wrote ${p}.new (merge by hand)`,
    settings: (verb, added, bak) => `  [2/4] settings.json ${verb} (${added} hook(s) wired, OBSIDIAN_VAULT_PATH set${bak})`,
    mcpBadJson: (p) => `  [3/4] .mcp.json exists but is not valid JSON -> wrote ${p}.new (merge by hand)`,
    mcp: (verb, names, bak) => `  [3/4] .mcp.json ${verb} (${names}${bak})`,
    mcpSkipped: '  [3/4] .mcp.json skipped (--no-mcp, no MCP companions)',
    colorsSkipped: '  [4/4] colors skipped (--no-colors)',
    colors: (r) => `  [4/4] colors: ${r}`,
    merged: 'merged', created: 'created', bakSaved: ', .bak saved',
    nextSteps: '\nNext steps:',
    step1: (v) => `  1. Open the vault in Obsidian: "Open folder as vault" -> ${v}`,
    step2: '  2. Make sure wendkeep is installed where the agent runs (npm i -D wendkeep, or -g).',
    step3: '  3. Open Claude Code in this project and send a test prompt.',
    step4: '  4. Confirm a note appears under 02-Sessões/<year>/<month>/DIA <dd>/ in the vault.',
    updateLater: '  Update later with: npm update wendkeep  (no re-copying — hooks live in the package).\n',
    vaultRegistered: (v, loc) => `\n  vault already registered for this project: ${v} (locale ${loc}) — prompt skipped. Use --vault to change.`,
  },
};

export function initMessages(localeId) {
  return MESSAGES[localeId] || MESSAGES['pt-BR'];
}

// Map the language answer to a locale id. 2/en → en; 1/pt/empty/unknown → pt-BR.
export function parseLocaleAnswer(ans) {
  const a = String(ans || '').trim().toLowerCase();
  if (a === '2' || a === 'en' || a === 'english') return 'en';
  return 'pt-BR';
}

// The vault path this project was set up with — read from .claude/settings.json's
// OBSIDIAN_VAULT_PATH (written by a prior init). Empty when the project isn't configured yet.
export function detectRegisteredVault(projectPath) {
  try {
    const s = JSON.parse(readFileSync(join(projectPath, '.claude', 'settings.json'), 'utf8'));
    const v = s && s.env && s.env.OBSIDIAN_VAULT_PATH;
    return typeof v === 'string' && v ? v : '';
  } catch { return ''; }
}

// The locale locked in a vault's .brain/config.json (empty if absent/invalid).
export function readVaultLocale(vaultPath) {
  try {
    const c = JSON.parse(readFileSync(join(vaultPath, '.brain', 'config.json'), 'utf8'));
    return c && LOCALES[c.locale] ? c.locale : '';
  } catch { return ''; }
}

export async function runInit(argv) {
  const args = parseArgs(argv);
  const projectPath = resolve(args.project || process.cwd());
  const log = (s) => process.stdout.write(`${s}\n`);

  // Recognize an already-configured project: the vault is registered in the project's
  // settings.json (OBSIDIAN_VAULT_PATH) and its locale is locked in the vault's config.json.
  // On re-run (e.g. after `npm i -D wendkeep@latest`) we reuse both and SKIP the language + vault
  // prompts — asking again risks a divergent vault from a mistyped name. `--vault` / `--locale`
  // override; the vault question is a once-per-project thing.
  const registeredVault = args.vault ? '' : detectRegisteredVault(projectPath);
  if (registeredVault && !args.locale) args.locale = readVaultLocale(registeredVault) || args.locale;

  // Language first (i18n): an interactive TTY without --locale (and not already registered) is
  // asked the vault language; folders, prompts and scaffold all follow the answer.
  if (!args.locale && process.stdin.isTTY && !args.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question('Idioma do vault / Vault language:\n  [1] Português (pt-BR)   [2] English (en)\n> ');
    rl.close();
    args.locale = parseLocaleAnswer(ans);
  }
  const resolvedLocale = args.locale && LOCALES[args.locale] ? args.locale : DEFAULT_LOCALE;
  const P = promptStrings(resolvedLocale);
  const M = initMessages(resolvedLocale);

  let vaultPath = args.vault || registeredVault;
  if (registeredVault) {
    log(M.vaultRegistered(registeredVault, resolvedLocale));
  } else if (!vaultPath) {
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

  log(M.header);
  log(`${M.lProject}: ${projectPath}`);
  log(`${M.lVault}: ${vaultPath}`);
  log(`${M.lMcp}: ${args.mcp ? 'mcpvault (wendkeep-vault)' : M.skipped}`);
  log(`${M.lCompanions}: ${companions.length ? companions.join(', ') : M.none}`);
  log(`${M.lColors}: ${args.noColors ? M.skipped : M.colorsOn}\n`);

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
    readmeNote = M.readmeCreated;
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
      ? `# Specs — generated living contract\n\nRead-only: do not author here. Write deltas only in \`${loc.folders.changes}/<slug>/specs/\`; archive promotes them here.\n`
      : `# Specs — contrato consolidado gerado\n\nSomente leitura: não edite aqui. Escreva deltas apenas em \`${loc.folders.changes}/<slug>/specs/\`; o archive promove para cá.\n`, 'utf8');
  }
  if (!existsSync(join(vaultPath, SPECS_STATE_FILE))) {
    const livingSpecs = readdirSync(join(vaultPath, loc.folders.specs)).filter((name) => name.endsWith('.md') && name !== 'README.md');
    if (!livingSpecs.length) adoptSpecsState(vaultPath);
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
    if (views.length) viewsNote = M.viewsNote(views.length);
  } catch { /* views são bônus — nunca derrubam o init */ }
  log(M.taxonomy(folders.length, created, loc.id, readmeNote, viewsNote));
  // Deliver the seeded defs (agents + wk process skills) to the project so they're
  // usable immediately — no separate `wendkeep sync-defs` step needed.
  const synced = syncDefs(vaultPath, projectPath);
  if (synced.skills.length || synced.agents.length) {
    log(M.defs(synced.skills.length, synced.agents.length));
  }

  // 2. .claude/settings.json --------------------------------------------------
  const settingsPath = join(projectPath, '.claude', 'settings.json');
  const settingsRead = readJsonSafe(settingsPath);
  if (!settingsRead.ok) {
    // Unparseable existing file — never clobber. Drop a .new for manual merge.
    const fresh = mergeSettings(null, { vaultPath, withMcp: args.mcp, force: true, companions, skipMcp, dotcontextHookLevel, projectPath }).settings;
    writeJson(`${settingsPath}.new`, fresh);
    log(M.settingsBadJson(settingsPath));
  } else {
    const hadFile = settingsRead.data !== null;
    const { settings, added } = mergeSettings(settingsRead.data, { vaultPath, withMcp: args.mcp, force: args.force, companions, skipMcp, dotcontextHookLevel, projectPath });
    if (hadFile) backup(settingsPath);
    writeJson(settingsPath, settings);
    log(M.settings(hadFile ? M.merged : M.created, added, hadFile ? M.bakSaved : ''));
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
      log(M.mcpBadJson(mcpPath));
    } else {
      const hadFile = mcpRead.data !== null;
      if (hadFile) backup(mcpPath);
      writeJson(mcpPath, mergeMcp(mcpRead.data, mcpOpts));
      log(M.mcp(hadFile ? M.merged : M.created, names, hadFile ? M.bakSaved : ''));
    }
  } else {
    log(M.mcpSkipped);
  }

  log('  [!] ignore runtime do wendkeep no Git quando o vault for versionado: .brain/.change-*');

  // 4. Vault color system (.obsidian) -----------------------------------------
  if (args.noColors) {
    log(M.colorsSkipped);
  } else {
    log(M.colors(installVaultColors(vaultPath)));
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

  log(M.nextSteps);
  log(M.step1(vaultPath));
  log(M.step2);
  log(M.step3);
  log(M.step4);
  log(M.updateLater);
}
