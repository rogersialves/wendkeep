// mergeSettings / mergeMcp fold the companion layers into the agent config,
// idempotently and without clobbering unrelated keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSettings, mergeMcp } from '../src/init.mjs';
import { MCP_SERVER_KEY } from '../src/taxonomy.mjs';

const UA_CMD = 'npx wendkeep hook understand-inject';

test('mergeSettings: adds companion marketplaces + enabledPlugins', () => {
  const { settings } = mergeSettings(null, {
    vaultPath: '/v',
    withMcp: true,
    companions: ['context-mode', 'understand-anything'],
  });
  assert.deepEqual(settings.extraKnownMarketplaces['context-mode'], {
    source: { source: 'git', url: 'https://github.com/mksglu/context-mode.git' },
  });
  assert.equal(settings.enabledPlugins['context-mode@context-mode'], true);
  assert.equal(settings.enabledPlugins['understand-anything@understand-anything'], true);
});

test('mergeSettings: wires understand-inject SessionStart hook when UA selected', () => {
  const { settings } = mergeSettings(null, {
    vaultPath: '/v',
    withMcp: true,
    companions: ['understand-anything'],
  });
  const cmds = (settings.hooks.SessionStart || []).flatMap((g) => (g.hooks || []).map((h) => h.command));
  assert.ok(cmds.includes(UA_CMD), 'understand-inject wired into SessionStart');
});

test('mergeSettings: enables companion MCP server in enabledMcpjsonServers', () => {
  const { settings } = mergeSettings(null, {
    vaultPath: '/v',
    withMcp: true,
    companions: ['context-mode'],
  });
  assert.ok(settings.enabledMcpjsonServers.includes('context-mode'));
  assert.ok(settings.enabledMcpjsonServers.includes(MCP_SERVER_KEY));
});

test('mergeSettings: idempotent — no duplicate hook groups on re-run', () => {
  const first = mergeSettings(null, { vaultPath: '/v', withMcp: true, companions: ['understand-anything'] }).settings;
  const second = mergeSettings(first, { vaultPath: '/v', withMcp: true, companions: ['understand-anything'] }).settings;
  const count = (second.hooks.SessionStart || []).flatMap((g) => (g.hooks || []))
    .filter((h) => h.command === UA_CMD).length;
  assert.equal(count, 1);
});

test('mergeSettings: preserves unrelated existing enabledPlugins', () => {
  const existing = { enabledPlugins: { 'foo@bar': true } };
  const { settings } = mergeSettings(existing, { vaultPath: '/v', withMcp: false, companions: ['caveman'] });
  assert.equal(settings.enabledPlugins['foo@bar'], true);
  assert.equal(settings.enabledPlugins['caveman@caveman'], true);
});

test('mergeMcp: adds companion MCP servers alongside the vault server', () => {
  const m = mergeMcp(null, { vaultPath: '/v', withVault: true, companions: ['context-mode'] });
  assert.ok(m.mcpServers[MCP_SERVER_KEY], 'vault server present');
  assert.deepEqual(m.mcpServers['context-mode'], { type: 'stdio', command: 'npx', args: ['-y', 'context-mode'] });
});

test('mergeSettings: dotcontext wires MCP + 3 lifecycle hooks, no plugin layer', () => {
  const { settings } = mergeSettings(null, { vaultPath: '/v', withMcp: false, companions: ['dotcontext'] });
  assert.ok(!settings.enabledPlugins || !('undefined@dotcontext' in settings.enabledPlugins));
  assert.ok(settings.enabledMcpjsonServers.includes('dotcontext'));
  const disp = (ev) => (settings.hooks[ev] || []).flatMap((g) => (g.hooks || []).map((h) => h.command));
  assert.ok(disp('SessionStart').some((c) => /@dotcontext\/cli@1\.1\.1 hook dispatch/.test(c)));
  assert.ok(disp('Stop').some((c) => /@dotcontext\/cli/.test(c)));
  const ptu = settings.hooks.PostToolUse || [];
  assert.ok(ptu.some((g) => g.matcher === 'Write|Edit|Bash' && (g.hooks || []).some((h) => /@dotcontext/.test(h.command))));
});

test('mergeSettings: dotcontext SessionStart folds AFTER wendkeep session-start', () => {
  for (const companions of [['dotcontext'], ['context-mode', 'dotcontext']]) {
    const { settings } = mergeSettings(null, { vaultPath: '/v', withMcp: false, companions });
    const cmds = settings.hooks.SessionStart.flatMap((g) => (g.hooks || []).map((h) => h.command));
    const iStart = cmds.findIndex((c) => /wendkeep hook session-start/.test(c));
    const iDot = cmds.findIndex((c) => /@dotcontext/.test(c));
    assert.ok(iStart >= 0 && iDot > iStart, `dotcontext after session-start for ${companions}`);
  }
});

test('mergeSettings: dotcontext idempotent (no duplicate hook groups on re-run)', () => {
  const first = mergeSettings(null, { vaultPath: '/v', withMcp: false, companions: ['dotcontext'] }).settings;
  const second = mergeSettings(first, { vaultPath: '/v', withMcp: false, companions: ['dotcontext'] }).settings;
  const count = second.hooks.PostToolUse.flatMap((g) => g.hooks || []).filter((h) => /@dotcontext/.test(h.command)).length;
  assert.equal(count, 1);
});

test('mergeSettings/mergeMcp: skipMcp omits dotcontext server but keeps hooks', () => {
  const { settings } = mergeSettings(null, {
    vaultPath: '/v', withMcp: false, companions: ['dotcontext'], skipMcp: ['dotcontext'],
  });
  assert.ok(!(settings.enabledMcpjsonServers || []).includes('dotcontext'), 'no dotcontext in enabled servers');
  const ss = (settings.hooks.SessionStart || []).flatMap((g) => (g.hooks || []).map((h) => h.command));
  assert.ok(ss.some((c) => /@dotcontext/.test(c)), 'hooks still wired');
  const m = mergeMcp(null, { vaultPath: '/v', withVault: false, companions: ['dotcontext'], skipMcp: ['dotcontext'] });
  assert.equal(m.mcpServers.dotcontext, undefined, 'no project MCP entry');
});

test('mergeSettings: dotcontextHookLevel light omits PostToolUse', () => {
  const { settings } = mergeSettings(null, {
    vaultPath: '/v', withMcp: false, companions: ['dotcontext'], dotcontextHookLevel: 'light',
  });
  assert.equal(settings.hooks.PostToolUse, undefined, 'no PostToolUse hook in light mode');
  assert.ok((settings.hooks.SessionStart || []).length >= 1, 'SessionStart still present');
});

test('mergeMcp: omits vault server when withVault is false', () => {
  const m = mergeMcp(null, { vaultPath: '/v', withVault: false, companions: ['context-mode'] });
  assert.equal(m.mcpServers[MCP_SERVER_KEY], undefined);
  assert.ok(m.mcpServers['context-mode']);
});
