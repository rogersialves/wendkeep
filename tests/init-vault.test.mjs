// Tests for the project-derived vault name + generated vault README (wendkeep init).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveVaultDirName, VAULT_FOLDERS } from '../src/taxonomy.mjs';
import { renderVaultReadme } from '../src/vault-readme.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

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

    // .mcp.json written for the context-mode server even under --no-mcp (no vault server).
    const mcp = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8'));
    assert.ok(mcp.mcpServers['context-mode'], 'context-mode MCP server present');
    assert.equal(mcp.mcpServers['wendkeep-vault'], undefined, 'no vault server under --no-mcp');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
