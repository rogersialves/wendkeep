// `wendkeep theme sync` — re-apply the vault color system into .obsidian on an EXISTING
// vault, idempotently: rewrite the CSS snippet, enable it (non-destructive), and (re)merge
// the graph color groups. The installer is shared with `wendkeep init` so the two never drift.
//
// Why a re-sync exists: .obsidian/graph.json is owned by Obsidian, which can drop the
// colorGroups wendkeep wrote (vault init'd by an older version, or Obsidian rewriting the
// file). Without a re-apply path the only fix was a full re-init. This command restores the
// graph colors without touching anything else.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { getLocale } from '../hooks/locale.mjs';
import {
  SNIPPET_NAME,
  renderColorSnippetCss,
  mergeAppearance,
  graphColorGroups,
  mergeGraphColorGroups,
} from './vault-theme.mjs';

// { ok, data }. ok=false means the file EXISTS but is unparseable — never clobber it.
// Absent -> ok=true, data=null (we create it).
function readJsonSafe(path) {
  if (!existsSync(path)) return { ok: true, data: null };
  try { return { ok: true, data: JSON.parse(readFileSync(path, 'utf8')) }; }
  catch { return { ok: false, data: null }; }
}

function writeJson(path, obj) {
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

// Pure-ish installer (does file I/O, no process exit). Returns a short summary + counts.
// Consumed by both `wendkeep init` (installVaultColors) and `wendkeep theme sync`.
export function syncVaultTheme(vaultPath) {
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
    writeJson(graphPath, mergeGraphColorGroups(graphRead.data || {}, graphColorGroups(loc)));
    groups = graphColorGroups(loc).length;
  }
  return {
    enabled,
    groups,
    summary: `snippet ${SNIPPET_NAME}.css${enabled ? ' (enabled)' : ' (enable by hand: appearance.json unreadable)'} + ${groups} graph group(s)`,
  };
}

function resolveVault(argv) {
  let vault;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--vault') vault = argv[++i];
    else if (a.startsWith('--vault=')) vault = a.slice(8);
  }
  const base = vault || process.env.OBSIDIAN_VAULT_PATH;
  if (!base) {
    process.stderr.write('wendkeep theme: no vault. Pass --vault <path> or set OBSIDIAN_VAULT_PATH.\n');
    process.exit(2);
  }
  return isAbsolute(base) ? base : resolve(process.cwd(), base);
}

export function runTheme(argv) {
  const [sub, ...rest] = argv;
  if (sub !== 'sync') {
    process.stderr.write(`wendkeep theme: unknown subcommand "${sub || ''}". Known: sync.\n`);
    process.exit(2);
  }
  const vaultBase = resolveVault(rest);
  const r = syncVaultTheme(vaultBase);
  process.stdout.write(`theme sync: ${r.summary}\n`);
  process.stdout.write('feche o Obsidian antes de rodar e reabra depois — ele é dono do graph.json e recarrega as cores na abertura.\n');
  process.exit(0);
}
