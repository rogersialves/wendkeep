// Tests for the project-derived vault name + generated vault README (wendkeep init).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveVaultDirName, VAULT_FOLDERS } from '../src/taxonomy.mjs';
import { renderVaultReadme } from '../src/vault-readme.mjs';
import { parseLocaleAnswer, promptStrings, initMessages, detectRegisteredVault, readVaultLocale } from '../src/init.mjs';
import { PROJECT_CONFIG_FILE, PROJECT_MARKER_REL } from '../src/project-vault.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

test('re-init recognizes the registered vault + locale and never creates a divergent one', () => {
  const proj = mkdtempSync(join(tmpdir(), 'wk-reinit-'));
  const run = (extra) => spawnSync(process.execPath, [BIN, 'init', '--project', proj, ...extra, '--no-companions', '--no-colors', '--yes'], { encoding: 'utf8' });
  try {
    // first install into a NON-default vault name
    const first = run(['--vault', join(proj, '.CustomVault'), '--locale', 'pt-BR']);
    assert.equal(first.status, 0, first.stderr);
    // it's now registered where a prior init would read it
    assert.equal(detectRegisteredVault(proj), join(proj, '.CustomVault'));
    assert.equal(readVaultLocale(join(proj, '.CustomVault')), 'pt-BR');

    // re-run WITHOUT --vault / --locale (as after `npm i -D wendkeep@latest`)
    const second = run([]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /registrado|registered/);
    assert.match(second.stdout, /\.CustomVault/);
    // the derived default vault (.<project>-vault) was NOT created — no data split
    const derived = join(proj, `.${dirname(proj) ? proj.split(/[\\/]/).pop() : 'x'}-vault`);
    assert.ok(!existsSync(derived), 'no divergent default vault created');
    assert.ok(existsSync(join(proj, '.CustomVault', '02-Sessões')), 'reused the registered vault');
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

test('init persists a provider-neutral project binding and stable vault identity', () => {
  const proj = mkdtempSync(join(tmpdir(), 'wk-binding-init-'));
  const vault = join(proj, '.NutriBrain');
  const run = () => spawnSync(process.execPath, [BIN, 'init', '--project', proj, '--vault', vault, '--locale', 'pt-BR', '--no-mcp', '--no-companions', '--no-colors', '--yes'], { encoding: 'utf8' });
  try {
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const configPath = join(proj, PROJECT_CONFIG_FILE);
    const markerPath = join(vault, ...PROJECT_MARKER_REL.split('/'));
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    assert.equal(config.schemaVersion, 1);
    assert.equal(config.vault, '.NutriBrain');
    assert.equal(config.projectId, marker.projectId);

    // Prova que a descoberta não depende mais do env privado do Claude.
    const settingsPath = join(proj, '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    delete settings.env.OBSIDIAN_VAULT_PATH;
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    assert.equal(detectRegisteredVault(proj), resolve(vault));

    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).projectId, config.projectId);
    assert.equal(JSON.parse(readFileSync(markerPath, 'utf8')).projectId, config.projectId);
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

test('init migrates a legacy Claude-only vault registration without creating a second vault', () => {
  const proj = mkdtempSync(join(tmpdir(), 'wk-legacy-binding-'));
  const legacyVault = join(proj, '.ExistingBrain');
  mkdirSync(join(proj, '.claude'), { recursive: true });
  mkdirSync(join(legacyVault, '.brain'), { recursive: true });
  writeFileSync(join(legacyVault, '.brain', 'config.json'), `${JSON.stringify({ locale: 'pt-BR' }, null, 2)}\n`);
  writeFileSync(join(proj, '.claude', 'settings.json'), `${JSON.stringify({
    env: { OBSIDIAN_VAULT_PATH: legacyVault },
  }, null, 2)}\n`);
  try {
    const result = spawnSync(process.execPath, [BIN, 'init', '--project', proj, '--no-mcp', '--no-companions', '--no-colors', '--yes'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(readFileSync(join(proj, PROJECT_CONFIG_FILE), 'utf8'));
    const marker = JSON.parse(readFileSync(join(legacyVault, ...PROJECT_MARKER_REL.split('/')), 'utf8'));
    assert.equal(config.vault, '.ExistingBrain');
    assert.equal(config.projectId, marker.projectId);
    assert.equal(existsSync(join(proj, `.${proj.split(/[\\/]/).pop()}-vault`)), false, 'no divergent derived vault');
  } finally { rmSync(proj, { recursive: true, force: true }); }
});

test('init output follows the vault locale (summary, steps, next-steps)', () => {
  assert.match(initMessages('pt-BR').nextSteps, /Próximos passos/);
  assert.match(initMessages('en').nextSteps, /Next steps/);
  assert.match(initMessages('pt-BR').step1('/v'), /Abra o vault/);
  assert.match(initMessages('en').step1('/v'), /Open the vault/);

  const pt = mkdtempSync(join(tmpdir(), 'wk-i18n-pt-'));
  const en = mkdtempSync(join(tmpdir(), 'wk-i18n-en-'));
  try {
    const run = (dir, loc) => spawnSync(process.execPath, [BIN, 'init', '--project', dir, '--vault', join(dir, '.v'), '--no-companions', '--no-colors', '--no-mcp', '--yes', '--locale', loc], { encoding: 'utf8' });
    const rpt = run(pt, 'pt-BR');
    assert.equal(rpt.status, 0, rpt.stderr);
    assert.match(rpt.stdout, /taxonomia do vault/);
    assert.match(rpt.stdout, /Próximos passos/);
    assert.doesNotMatch(rpt.stdout, /Next steps/);
    const ren = run(en, 'en');
    assert.match(ren.stdout, /vault taxonomy/);
    assert.match(ren.stdout, /Next steps/);
  } finally { rmSync(pt, { recursive: true, force: true }); rmSync(en, { recursive: true, force: true }); }
});

test('parseLocaleAnswer: 1/pt/empty -> pt-BR; 2/en -> en; unknown -> pt-BR', () => {
  for (const a of ['', '1', 'pt', 'pt-BR', 'PT', 'português', 'xyz']) assert.equal(parseLocaleAnswer(a), 'pt-BR', `"${a}"`);
  for (const a of ['2', 'en', 'EN', 'english']) assert.equal(parseLocaleAnswer(a), 'en', `"${a}"`);
});

test('promptStrings: localized init prompts; en distinct from pt', () => {
  const pt = promptStrings('pt-BR');
  const en = promptStrings('en');
  assert.match(pt.vault('/x'), /vault Obsidian|Caminho/i);
  assert.match(en.vault('/x'), /vault path/i);
  assert.match(en.companionsHeader, /optional/i);
  assert.equal(promptStrings('xx').vault('/x'), pt.vault('/x'), 'unknown falls back to pt');
});

test('deriveVaultDirName: .<project>-vault, case preserved (posix + windows seps)', () => {
  assert.equal(deriveVaultDirName('/home/u/NutriGym-Vision'), '.NutriGym-Vision-vault');
  assert.equal(deriveVaultDirName('C:\\GitHub\\NutriGym-Vision'), '.NutriGym-Vision-vault');
});

test('deriveVaultDirName: trailing separator ignored', () => {
  assert.equal(deriveVaultDirName('/home/u/my-app/'), '.my-app-vault');
  assert.equal(deriveVaultDirName('C:\\x\\my-app\\'), '.my-app-vault');
});

test('deriveVaultDirName: spaces and invalid chars become dashes, collapsed', () => {
  assert.equal(deriveVaultDirName('/x/My App'), '.My-App-vault');
  assert.equal(deriveVaultDirName('/x/foo:bar*baz'), '.foo-bar-baz-vault');
  assert.equal(deriveVaultDirName('/x/a---b'), '.a-b-vault');
});

test('deriveVaultDirName: leading dot stripped (no double-dot vault)', () => {
  assert.equal(deriveVaultDirName('/x/.hidden'), '.hidden-vault');
});

test('deriveVaultDirName: empty/root basename falls back to .wendkeep-vault', () => {
  assert.equal(deriveVaultDirName('/'), '.wendkeep-vault');
  assert.equal(deriveVaultDirName(''), '.wendkeep-vault');
});

test('renderVaultReadme: includes project name and vault path', () => {
  const md = renderVaultReadme({ projectName: 'AcmeApp', vaultPath: '/repo/.AcmeApp-vault' });
  assert.match(md, /AcmeApp/);
  assert.match(md, /\/repo\/\.AcmeApp-vault/);
});

test('renderVaultReadme: documents every created folder including .brain', () => {
  const md = renderVaultReadme({ projectName: 'AcmeApp', vaultPath: '/repo/.AcmeApp-vault' });
  for (const f of VAULT_FOLDERS) {
    assert.ok(md.includes(f), `README should mention folder ${f}`);
  }
});

test('renderVaultReadme: names the real agents, not NutriGym/Copilot specifics', () => {
  const md = renderVaultReadme({ projectName: 'AcmeApp', vaultPath: '/repo/.AcmeApp-vault' });
  assert.match(md, /Claude Code/);
  assert.match(md, /Codex/);
  assert.doesNotMatch(md, /NutriGym/i);
  assert.doesNotMatch(md, /Copilot/i);
  assert.doesNotMatch(md, /Fase [AC]/);
});

test('renderVaultReadme: includes MCP by default', () => {
  const md = renderVaultReadme({ projectName: 'AcmeApp', vaultPath: '/x' });
  assert.match(md, /MCPVault/);
  assert.match(md, /wendkeep-vault/);
});

test('renderVaultReadme: omits MCP mentions when withMcp is false', () => {
  const md = renderVaultReadme({ projectName: 'AcmeApp', vaultPath: '/x', withMcp: false });
  assert.doesNotMatch(md, /MCP/);
});

test('wendkeep init derives .<project>-vault and writes a vault README', () => {
  const parent = mkdtempSync(join(tmpdir(), 'wk-init-'));
  const projectDir = join(parent, 'My-Proj');
  mkdirSync(projectDir);
  try {
    const r = spawnSync(
      process.execPath,
      [BIN, 'init', '--project', projectDir, '--no-mcp', '--no-companions', '--yes'],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0, `init exit 0; stderr=\n${r.stderr}`);

    const vaultDir = join(projectDir, '.My-Proj-vault');
    assert.ok(existsSync(vaultDir), 'vault dir derived from project name exists');

    const readme = join(vaultDir, 'README.md');
    assert.ok(existsSync(readme), 'vault README was generated');
    assert.match(readFileSync(readme, 'utf8'), /My-Proj/);

    const settings = JSON.parse(
      readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8'),
    );
    assert.equal(
      resolve(settings.env.OBSIDIAN_VAULT_PATH),
      resolve(vaultDir),
      'OBSIDIAN_VAULT_PATH points at the derived vault',
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('wendkeep init installs the vault color system into .obsidian', () => {
  const parent = mkdtempSync(join(tmpdir(), 'wk-colors-'));
  const projectDir = join(parent, 'Pretty');
  mkdirSync(projectDir);
  try {
    const r = spawnSync(
      process.execPath,
      [BIN, 'init', '--project', projectDir, '--no-mcp', '--no-companions', '--yes'],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0, `init exit 0; stderr=\n${r.stderr}`);

    const vaultDir = join(projectDir, '.Pretty-vault');
    const css = join(vaultDir, '.obsidian', 'snippets', 'wendkeep-colors.css');
    assert.ok(existsSync(css), 'color snippet written');
    assert.match(readFileSync(css, 'utf8'), /topic-bug/);

    const appearance = JSON.parse(readFileSync(join(vaultDir, '.obsidian', 'appearance.json'), 'utf8'));
    assert.ok(appearance.enabledCssSnippets.includes('wendkeep-colors'), 'snippet enabled');

    const graph = JSON.parse(readFileSync(join(vaultDir, '.obsidian', 'graph.json'), 'utf8'));
    assert.ok(Array.isArray(graph.colorGroups) && graph.colorGroups.length >= 4, 'graph color groups added');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('wendkeep init --no-colors skips the color system', () => {
  const parent = mkdtempSync(join(tmpdir(), 'wk-nocolors-'));
  const projectDir = join(parent, 'Plain');
  mkdirSync(projectDir);
  try {
    const r = spawnSync(
      process.execPath,
      [BIN, 'init', '--project', projectDir, '--no-mcp', '--no-companions', '--no-colors', '--yes'],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0, `init exit 0; stderr=\n${r.stderr}`);
    assert.equal(
      existsSync(join(projectDir, '.Plain-vault', '.obsidian', 'snippets', 'wendkeep-colors.css')),
      false,
      'no snippet when --no-colors',
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('wendkeep init --companions wires plugin layer, UA hook and MCP server', () => {
  const parent = mkdtempSync(join(tmpdir(), 'wk-comp-'));
  const projectDir = join(parent, 'Acme');
  mkdirSync(projectDir);
  try {
    const r = spawnSync(
      process.execPath,
      [BIN, 'init', '--project', projectDir, '--no-mcp', '--companions', 'context-mode,understand-anything', '--yes'],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0, `init exit 0; stderr=\n${r.stderr}`);

    const settings = JSON.parse(readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8'));
    assert.equal(settings.enabledPlugins['context-mode@context-mode'], true);
    assert.equal(settings.enabledPlugins['understand-anything@understand-anything'], true);
    assert.ok(settings.extraKnownMarketplaces['context-mode']);
    const ssCmds = (settings.hooks.SessionStart || []).flatMap((g) => (g.hooks || []).map((h) => h.command));
    assert.ok(ssCmds.includes('npx wendkeep hook understand-inject'), 'UA hook wired');

    // context-mode is plugin-only (its plugin ships its own MCP; wiring both double-registered
    // it). Under --no-mcp with no MCP companion there is nothing to write to .mcp.json.
    if (existsSync(join(projectDir, '.mcp.json'))) {
      const mcp = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8'));
      assert.equal(mcp.mcpServers['context-mode'], undefined, 'no double-registered context-mode MCP');
      assert.equal(mcp.mcpServers['wendkeep-vault'], undefined, 'no vault server under --no-mcp');
    }
    // env: MCP_TIMEOUT headroom set for npx-based MCPs (non-destructive default).
    assert.equal(settings.env.MCP_TIMEOUT, '60000');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
