import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'acorn';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = resolve(ROOT, 'bin', 'wendkeep.mjs');
const CLI_RUNTIME = resolve(ROOT, 'packages', 'cli', 'src', 'index.mjs');

const COMMAND_MODULES = new Set([
  'change.mjs',
  'cost.mjs',
  'doctor.mjs',
  'flow.mjs',
  'import.mjs',
  'init.mjs',
  'lessons.mjs',
  'memory.mjs',
  'note.mjs',
  'profile.mjs',
  'renumber.mjs',
  'sensors.mjs',
  'session.mjs',
  'spec.mjs',
  'stats.mjs',
  'sync-defs.mjs',
  'sync.mjs',
  'theme.mjs',
  'validate-core.mjs',
  'vault-views.mjs',
  'verify.mjs',
]);

function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  visit(node, ancestors);
  const nextAncestors = [...ancestors, node];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child?.type) walk(child, visit, nextAncestors);
      }
    } else if (value?.type) {
      walk(value, visit, nextAncestors);
    }
  }
}

function parsed(source) {
  return parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
}

function assertCliRuntimeOwnership(source) {
  const declarations = new Set();
  const switches = [];
  walk(parsed(source), (node) => {
    if (node.type === 'FunctionDeclaration' && node.id) declarations.add(node.id.name);
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
      declarations.add(node.id.name);
    }
    if (node.type === 'SwitchStatement' && node.discriminant.type === 'Identifier'
      && node.discriminant.name === 'cmd') {
      switches.push(node);
    }
  });

  for (const name of ['HELP', 'runHook', 'preferProjectVault', 'main', 'runCli']) {
    assert.ok(declarations.has(name), `CLI runtime must own ${name}`);
  }
  assert.ok(
    switches.some((node) => node.cases.length >= 20),
    'CLI runtime must own the command dispatch switch',
  );
}

function commandModule(specifier) {
  if (typeof specifier !== 'string') return false;
  const name = specifier.split('/').at(-1);
  return COMMAND_MODULES.has(name);
}

function assertLazyCommandLoading(source) {
  const eager = [];
  const lazy = new Set();
  walk(parsed(source), (node, ancestors) => {
    if (node.type === 'ImportDeclaration' && commandModule(node.source.value)) {
      eager.push(node.source.value);
    }
    if (node.type === 'ImportExpression' && commandModule(node.source.value)) {
      const insideFunction = ancestors.some((ancestor) => (
        ancestor.type === 'FunctionDeclaration'
        || ancestor.type === 'FunctionExpression'
        || ancestor.type === 'ArrowFunctionExpression'
      ));
      if (!insideFunction) eager.push(node.source.value);
      else lazy.add(node.source.value);
    }
  });

  assert.deepEqual(eager, [], `command modules must remain lazy: ${eager.join(', ')}`);
  for (const specifier of [
    '../../../src/init.mjs',
    '../../../src/flow.mjs',
    '../../../src/verify.mjs',
  ]) {
    assert.ok(lazy.has(specifier), `command modules must remain lazy: missing ${specifier}`);
  }
}

test('[req:MOD-14] the executable is a thin facade over the canonical CLI runtime', () => {
  assert.ok(existsSync(CLI_RUNTIME), 'packages/cli/src/index.mjs must own the CLI runtime');

  const source = readFileSync(BIN, 'utf8');
  assert.match(source, /^#!\/usr\/bin\/env node\r?\n/);
  assert.doesNotMatch(source, /const HELP|preferProjectVault|spawnSync|runVerify/);

  const program = parse(source.replace(/^#!.*\r?\n/, ''), {
    ecmaVersion: 'latest',
    sourceType: 'module',
  });
  assert.equal(program.body.length, 2, 'bin must contain only one import and one invocation');
  assert.equal(program.body[0].type, 'ImportDeclaration');
  assert.equal(program.body[0].source.value, '../packages/cli/src/index.mjs');
  assert.equal(program.body[1].type, 'ExpressionStatement');
  assert.equal(program.body[1].expression.type, 'AwaitExpression');
});

test('[req:MOD-14] the canonical workspace owns composition instead of delegating it', () => {
  const source = readFileSync(CLI_RUNTIME, 'utf8');
  assertCliRuntimeOwnership(source);

  const delegatedRuntime = `
    import { runCli as delegatedRunCli } from '../../../src/cli-runtime.mjs';
    export const runCli = (...args) => delegatedRunCli(...args);
  `;
  assert.throws(
    () => assertCliRuntimeOwnership(delegatedRuntime),
    /CLI runtime must own/,
  );
});

test('[req:MOD-15] importing the canonical CLI runtime is side-effect free', () => {
  const runtimeUrl = pathToFileURL(CLI_RUNTIME).href;
  const probe = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `const runtime = await import(${JSON.stringify(runtimeUrl)}); process.stdout.write(typeof runtime.runCli);`,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, OBSIDIAN_VAULT_PATH: '' },
  });

  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stderr, '');
  assert.equal(probe.stdout, 'function');
});

test('[req:MOD-15] command implementations remain lazy imports', () => {
  const source = readFileSync(CLI_RUNTIME, 'utf8');
  assertLazyCommandLoading(source);

  const eagerMutant = `import { runInit as eagerRunInit } from '../../../src/init.mjs';\n${source}`;
  assert.throws(
    () => assertLazyCommandLoading(eagerMutant),
    /command modules must remain lazy/,
  );

  const eagerDynamicMutant = `const eagerInit = await import('../../../src/init.mjs');\n${source}`;
  assert.throws(
    () => assertLazyCommandLoading(eagerDynamicMutant),
    /command modules must remain lazy/,
  );
});
