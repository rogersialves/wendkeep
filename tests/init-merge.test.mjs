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

test('mergeSettings: wires brain-inject on SessionStart before session-start, by default', () => {
  const { settings } = mergeSettings(null, { vaultPath: '/v', withMcp: true, companions: [] });
  const groups = settings.hooks.SessionStart || [];
  const cmds = groups.flatMap((g) => (g.hooks || []).map((h) => h.command));
  const bi = cmds.indexOf('npx wendkeep hook brain-inject');
  const ss = cmds.indexOf('npx wendkeep hook session-start');
  assert.ok(bi >= 0, 'brain-inject wired (memory + active change injection)');
  assert.ok(ss >= 0, 'session-start wired');
  assert.ok(bi < ss, 'brain-inject folds before session-start');

  // Re-inject memory after compaction/clear, not only on a cold startup.
  const biGroup = groups.find((g) => (g.hooks || []).some((h) => h.command === 'npx wendkeep hook brain-inject'));
  assert.equal(biGroup.matcher, 'startup|clear|compact');

  // Idempotent: second merge doesn't duplicate it.
  const second = mergeSettings(settings, { vaultPath: '/v', withMcp: true, companions: [] }).settings;
  const dup = (second.hooks.SessionStart || []).flatMap((g) => g.hooks || []).filter((h) => h.command === 'npx wendkeep hook brain-inject').length;
  assert.equal(dup, 1);
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

test('mergeSettings: enables companion MCP server in enabledMcpjsonServers (dotcontext; context-mode is plugin-only)', () => {
  const { settings } = mergeSettings(null, {
    vaultPath: '/v',
    withMcp: true,
    companions: ['context-mode', 'dotcontext'],
  });
  assert.ok(settings.enabledMcpjsonServers.includes('dotcontext'));
  assert.ok(!settings.enabledMcpjsonServers.includes('context-mode'), 'context-mode MCP not double-registered');
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
  const m = mergeMcp(null, { vaultPath: '/v', withVault: true, companions: ['context-mode', 'dotcontext'] });
  assert.ok(m.mcpServers[MCP_SERVER_KEY], 'vault server present');
  assert.ok(m.mcpServers.dotcontext, 'MCP-only companion present');
  assert.equal(m.mcpServers['context-mode'], undefined, 'context-mode is plugin-only (no double MCP)');
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

test('mergeSettings: dotcontextHookLevel light omits dotcontext PostToolUse (keeps wendkeep\'s)', () => {
  const { settings } = mergeSettings(null, {
    vaultPath: '/v', withMcp: false, companions: ['dotcontext'], dotcontextHookLevel: 'light',
  });
  const post = (settings.hooks.PostToolUse || []).flatMap((g) => (g.hooks || []).map((h) => h.command));
  // dotcontext's per-tool trace hook (Write|Edit|Bash dispatch) is dropped in light mode…
  assert.ok(!post.some((c) => c.includes('@dotcontext/cli')), 'no dotcontext PostToolUse in light mode');
  // …but wendkeep's own decision-capture PostToolUse (AskUserQuestion) is always wired.
  assert.ok(post.includes('npx wendkeep hook decision-capture'), 'decision-capture still present');
  assert.ok((settings.hooks.SessionStart || []).length >= 1, 'SessionStart still present');
});

test('startup-contention fixes: brain-inject timeout 45 + MCP_TIMEOUT default (never clobbered)', async () => {
  const { SESSION_HOOKS } = await import('../src/taxonomy.mjs');
  const bi = SESSION_HOOKS.find((h) => h.name === 'brain-inject');
  assert.equal(bi.timeout, 45, 'brain-inject headroom for npx cold-start contention');

  const fresh = mergeSettings(null, { vaultPath: '/v', withMcp: false, companions: [] }).settings;
  assert.equal(fresh.env.MCP_TIMEOUT, '60000', 'MCP_TIMEOUT default set');
  const user = mergeSettings({ env: { MCP_TIMEOUT: '15000' } }, { vaultPath: '/v', withMcp: false, companions: [] }).settings;
  assert.equal(user.env.MCP_TIMEOUT, '15000', 'user value never clobbered');
});

test('mergeMcp: omits vault server when withVault is false', () => {
  const m = mergeMcp(null, { vaultPath: '/v', withVault: false, companions: ['dotcontext'] });
  assert.equal(m.mcpServers[MCP_SERVER_KEY], undefined);
  assert.ok(m.mcpServers.dotcontext);
});
