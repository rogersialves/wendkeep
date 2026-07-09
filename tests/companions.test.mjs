// Companion plugin/MCP registry + the pure patches wendkeep init folds into
// .claude/settings.json and .mcp.json. Mechanism shapes verified against the
// user's real settings.json (extraKnownMarketplaces / enabledPlugins).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPANIONS,
  selectableCompanions,
  resolveCompanions,
  companionSettingsPatch,
  companionMcpPatch,
  companionHookSpecs,
  cavemanInstallCommand,
  CAVEMAN_AGENTS,
  dotcontextHookCommand,
} from '../src/taxonomy.mjs';

test('selectableCompanions: hides legacy dotcontext from the picker, keeps it opt-in-able', () => {
  const ids = selectableCompanions().map((c) => c.id);
  assert.ok(!ids.includes('dotcontext'), 'dotcontext not offered in the picker');
  assert.ok(ids.includes('context-mode'), 'context-mode offered');
  assert.ok(ids.includes('understand-anything') && ids.includes('caveman'), 'the rest still offered');
  // Explicit opt-in still works — hiding is UI-only.
  assert.deepEqual(resolveCompanions({ companionsFlag: 'dotcontext' }), ['dotcontext']);
});

test('COMPANIONS: none pre-checked by default (neutral harness, no presumed plugin)', () => {
  const byId = Object.fromEntries(COMPANIONS.map((c) => [c.id, c]));
  assert.equal(byId['context-mode'].default, false); // opt-in now, not a premise
  assert.equal(byId['dotcontext'].default, false);
  assert.equal(byId['caveman'].default, false);
  assert.equal(byId['understand-anything'].default, false);
  assert.ok(COMPANIONS.every((c) => c.default !== true), 'no companion is a default');
});

test('resolveCompanions: non-interactive default is empty (opt in explicitly)', () => {
  assert.deepEqual(resolveCompanions({}), []);
  assert.deepEqual(resolveCompanions({ companionsFlag: 'context-mode' }), ['context-mode']);
  // dotcontext still selectable when explicitly asked
  assert.deepEqual(resolveCompanions({ companionsFlag: 'dotcontext' }), ['dotcontext']);
});

test('resolveCompanions: --no-companions yields none', () => {
  assert.deepEqual(resolveCompanions({ noCompanions: true }), []);
});

test('resolveCompanions: explicit flag selects those ids, in registry order', () => {
  assert.deepEqual(
    resolveCompanions({ companionsFlag: 'caveman,context-mode' }),
    ['context-mode', 'caveman'],
  );
});

test('resolveCompanions: unknown ids in flag are dropped', () => {
  assert.deepEqual(resolveCompanions({ companionsFlag: 'caveman,bogus' }), ['caveman']);
});

test('companionSettingsPatch: marketplace + enabledPlugins for context-mode (git source)', () => {
  const patch = companionSettingsPatch(['context-mode']);
  assert.deepEqual(patch.extraKnownMarketplaces['context-mode'], {
    source: { source: 'git', url: 'https://github.com/mksglu/context-mode.git' },
  });
  assert.equal(patch.enabledPlugins['context-mode@context-mode'], true);
});

test('companionSettingsPatch: understand-anything uses github source', () => {
  const patch = companionSettingsPatch(['understand-anything']);
  assert.deepEqual(patch.extraKnownMarketplaces['understand-anything'], {
    source: { source: 'github', repo: 'Egonex-AI/Understand-Anything' },
  });
  assert.equal(patch.enabledPlugins['understand-anything@understand-anything'], true);
});

test('companionMcpPatch: only MCP-capable companions get an .mcp.json entry', () => {
  // context-mode is plugin-only now: its plugin ships its OWN MCP server, so wiring an .mcp.json
  // entry too double-registered it (two concurrent npx cold-starts -> both timed out).
  assert.deepEqual(companionMcpPatch(['context-mode']), {});
  assert.deepEqual(companionMcpPatch(['caveman']), {});
  assert.ok(companionMcpPatch(['dotcontext']).dotcontext, 'MCP-only companion still gets one');
});

test('companionHookSpecs: only companions with a wendkeep hook (understand-anything)', () => {
  const specs = companionHookSpecs(['understand-anything', 'context-mode', 'caveman']);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].event, 'SessionStart');
  assert.equal(specs[0].name, 'understand-inject');
});

test('companionSettingsPatch: skips MCP-only companions (no undefined@dotcontext)', () => {
  const patch = companionSettingsPatch(['dotcontext']);
  assert.deepEqual(patch.extraKnownMarketplaces, {});
  assert.deepEqual(patch.enabledPlugins, {});
  const mixed = companionSettingsPatch(['context-mode', 'dotcontext']);
  assert.equal(mixed.enabledPlugins['context-mode@context-mode'], true);
  assert.ok(!('undefined@dotcontext' in mixed.enabledPlugins));
  assert.ok(!('dotcontext' in mixed.extraKnownMarketplaces));
});

test('companionMcpPatch: dotcontext MCP server entry', () => {
  assert.deepEqual(companionMcpPatch(['dotcontext']), {
    dotcontext: { type: 'stdio', command: 'npx', args: ['-y', '@dotcontext/mcp@latest'], env: {} },
  });
});

test('companionMcpPatch: skip list omits a companion MCP (e.g. dotcontext already global)', () => {
  assert.deepEqual(companionMcpPatch(['context-mode', 'dotcontext'], ['dotcontext']), {});
  assert.ok(companionMcpPatch(['dotcontext'], []).dotcontext, 'present without skip');
});

test('companionHookSpecs: dotcontextHookLevel light drops PostToolUse; none drops all', () => {
  const light = companionHookSpecs(['dotcontext'], { dotcontextHookLevel: 'light' });
  assert.deepEqual(light.map((s) => s.event).sort(), ['SessionStart', 'Stop']);
  assert.deepEqual(companionHookSpecs(['dotcontext'], { dotcontextHookLevel: 'none' }), []);
  assert.equal(companionHookSpecs(['dotcontext']).length, 3); // full default
});

test('dotcontextHookCommand: pinned npx cli hook dispatch', () => {
  assert.equal(
    dotcontextHookCommand('1.1.1', 'claude-code'),
    'npx -y @dotcontext/cli@1.1.1 hook dispatch --source claude-code',
  );
});

test('companionHookSpecs: dotcontext emits SessionStart+Stop+PostToolUse, order 100', () => {
  const specs = companionHookSpecs(['dotcontext']);
  assert.equal(specs.length, 3);
  const byEvent = Object.fromEntries(specs.map((s) => [s.event, s]));
  assert.ok(byEvent.SessionStart && byEvent.Stop && byEvent.PostToolUse);
  assert.equal(byEvent.PostToolUse.matcher, 'Write|Edit|Bash');
  for (const s of specs) {
    assert.equal(s.timeout, 8);
    assert.equal(s.order, 100);
    assert.match(s.command, /@dotcontext\/cli@1\.1\.1 hook dispatch/);
  }
});

test('CAVEMAN_AGENTS: excludes gemini (its CLI crashes on caveman agent defs)', () => {
  assert.ok(!CAVEMAN_AGENTS.includes('gemini'), 'gemini must not be in the install set');
  assert.ok(CAVEMAN_AGENTS.includes('claude'));
});

test('cavemanInstallCommand: non-interactive npx, --only per agent, never gemini', () => {
  const cmd = cavemanInstallCommand();
  assert.match(cmd, /npx -y github:JuliusBrussee\/caveman/);
  assert.match(cmd, /--non-interactive/);
  assert.match(cmd, /--only claude/);
  assert.match(cmd, /--only amp/);
  assert.doesNotMatch(cmd, /gemini/);
});
