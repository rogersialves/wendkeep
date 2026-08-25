import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'acorn';
import { importSpecifiersFromSource } from './helpers/import-specifiers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MCP_WORKSPACE = resolve(ROOT, 'packages', 'mcp');
const INTEGRATIONS_WORKSPACE = resolve(ROOT, 'packages', 'integrations');
const MCP_PACKAGE = resolve(ROOT, 'packages', 'mcp', 'package.json');
const MCP_INDEX = resolve(ROOT, 'packages', 'mcp', 'src', 'index.mjs');
const MCP_CONFIG = resolve(ROOT, 'packages', 'mcp', 'src', 'config.mjs');
const LEGACY_TAXONOMY = resolve(ROOT, 'src', 'taxonomy.mjs');
const LEGACY_INIT = resolve(ROOT, 'src', 'init.mjs');
const CANONICAL_MCP_IMPORT = '../packages/mcp/src/index.mjs';
const MCP_KERNEL_SYMBOLS = new Set([
  'MCP_SERVER_KEY',
  'mcpServerEntry',
  'selectMcpServers',
  'mergeMcpConfig',
]);

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit);
    } else if (value?.type) {
      walk(value, visit);
    }
  }
}

const FUNCTION_NODES = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
]);

function walkImportPhase(node, visit, functionDepth = 0) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node, functionDepth);
  const childDepth = functionDepth + (FUNCTION_NODES.has(node.type) ? 1 : 0);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) walkImportPhase(child, visit, childDepth);
    } else if (value?.type) {
      walkImportPhase(value, visit, childDepth);
    }
  }
}

function parsed(source, sourceType = 'module') {
  return parse(source, {
    ecmaVersion: 'latest',
    sourceType,
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: sourceType === 'script',
  });
}

function bindingNames(pattern, names = []) {
  if (!pattern) return names;
  if (pattern.type === 'Identifier') {
    names.push(pattern.name);
    return names;
  }
  if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      bindingNames(property.type === 'Property' ? property.value : property.argument, names);
    }
    return names;
  }
  if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements) bindingNames(element, names);
    return names;
  }
  if (pattern.type === 'AssignmentPattern') {
    return bindingNames(pattern.left, names);
  }
  if (pattern.type === 'RestElement') {
    return bindingNames(pattern.argument, names);
  }
  return names;
}

function declarationNames(node) {
  const names = [];
  if (
    node.type === 'FunctionDeclaration'
    || node.type === 'FunctionExpression'
    || node.type === 'ArrowFunctionExpression'
  ) {
    if (node.id) names.push(node.id.name);
    for (const parameter of node.params) bindingNames(parameter, names);
    return names;
  }
  if (node.type === 'VariableDeclarator') return bindingNames(node.id);
  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    return node.id ? [node.id.name] : [];
  }
  if (node.type === 'CatchClause') return bindingNames(node.param);
  return names;
}

function directReturnCallNames(functionNode) {
  const names = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node !== functionNode && FUNCTION_NODES.has(node.type)) return;
    if (node.type === 'ReturnStatement') {
      const argument = node.argument?.type === 'ChainExpression'
        ? node.argument.expression
        : node.argument;
      const callee = argument?.type === 'CallExpression' ? argument.callee : null;
      names.push(callee?.type === 'Identifier' ? callee.name : null);
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
      } else if (value?.type) {
        visit(value);
      }
    }
  };
  visit(functionNode.body);
  return names;
}

function directExportedFunctions(ast, name) {
  return ast.body
    .filter((node) => (
      node.type === 'ExportNamedDeclaration'
      && node.declaration?.type === 'FunctionDeclaration'
      && node.declaration.id?.name === name
    ))
    .map((node) => node.declaration);
}

function namedExportCount(ast, name) {
  let count = 0;
  for (const node of ast.body) {
    if (node.type !== 'ExportNamedDeclaration') continue;
    if (node.declaration?.id?.name === name) count += 1;
    for (const specifier of node.specifiers) {
      const exportedName = specifier.exported?.name ?? specifier.exported?.value;
      if (exportedName === name) count += 1;
    }
  }
  return count;
}

function assignmentBindingNames(node) {
  if (node.type === 'AssignmentExpression') return bindingNames(node.left);
  if (node.type === 'UpdateExpression') return bindingNames(node.argument);
  if (
    (node.type === 'ForInStatement' || node.type === 'ForOfStatement')
    && node.left.type !== 'VariableDeclaration'
  ) {
    return bindingNames(node.left);
  }
  return [];
}

function propertyName(node) {
  if (!node) return null;
  if (node.computed && node.property?.type === 'Literal') return node.property.value;
  if (!node.computed && node.property?.type === 'Identifier') return node.property.name;
  return null;
}

function assertMcpRuntimeOwnership(source) {
  const declarations = new Set();
  const stringValues = new Set();
  let writesMcpServers = false;
  let hasSelectionLoop = false;

  walk(parsed(source), (node) => {
    for (const name of declarationNames(node)) declarations.add(name);
    if (node.type === 'Literal' && typeof node.value === 'string') {
      stringValues.add(node.value);
    }
    if (node.type === 'ForOfStatement') hasSelectionLoop = true;
    if (
      node.type === 'AssignmentExpression'
      && node.left.type === 'MemberExpression'
      && propertyName(node.left) === 'mcpServers'
    ) {
      writesMcpServers = true;
    }
  });

  for (const name of MCP_KERNEL_SYMBOLS) {
    assert.ok(declarations.has(name), `MCP config kernel must own ${name}`);
  }
  for (const value of ['wendkeep-vault', 'npx', '--no-install', 'wendkeep', 'mcp', 'serve']) {
    assert.ok(stringValues.has(value), `MCP config kernel must own ${value}`);
  }
  assert.ok(hasSelectionLoop, 'MCP config kernel must own descriptor selection');
  assert.ok(writesMcpServers, 'MCP config kernel must own mcpServers merge');
}

function assertAllowedMcpImports(source, {
  sourceType = 'module',
  fromFile = resolve(MCP_WORKSPACE, 'src', 'mutant.mjs'),
} = {}) {
  const forbidden = importSpecifiersFromSource(source, { sourceType })
    .filter((specifier) => (
      !specifier.startsWith('.')
      || !isWithin(MCP_WORKSPACE, resolveFileSpecifier(fromFile, specifier) || '')
    ));
  assert.deepEqual(
    forbidden,
    [],
    `MCP config kernel imports only local workspace modules: ${forbidden.join(', ')}`,
  );
}

function assertNoImportPhaseEffects(source, { sourceType = 'module' } = {}) {
  const effects = [];
  const effectNodes = new Set([
    'AssignmentExpression',
    'AwaitExpression',
    'CallExpression',
    'DoWhileStatement',
    'ForInStatement',
    'ForOfStatement',
    'ForStatement',
    'IfStatement',
    'ImportExpression',
    'MemberExpression',
    'NewExpression',
    'SpreadElement',
    'SwitchStatement',
    'TaggedTemplateExpression',
    'ThrowStatement',
    'TryStatement',
    'UpdateExpression',
    'WhileStatement',
  ]);
  walkImportPhase(parsed(source, sourceType), (node, functionDepth) => {
    if (functionDepth !== 0) return;
    if (effectNodes.has(node.type) || (node.type === 'UnaryExpression' && node.operator === 'delete')) {
      effects.push(node.type);
    }
  });
  assert.deepEqual(
    effects,
    [],
    `MCP config kernel has import-time effects: ${effects.join(', ')}`,
  );
}

function workspaceSourceFiles(root) {
  const files = [];
  const visit = (current) => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = resolve(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (['.mjs', '.js', '.cjs'].includes(extname(entry.name))) files.push(absolute);
    }
  };
  visit(root);
  return files.sort();
}

function canonicalPhysicalPath(input) {
  const suffix = [];
  let current = resolve(input);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(input);
    suffix.unshift(basename(current));
    current = parent;
  }
  try {
    const physical = realpathSync.native
      ? realpathSync.native(current)
      : realpathSync(current);
    return resolve(physical, ...suffix);
  } catch {
    return resolve(input);
  }
}

function fileIdentity(input) {
  try {
    const stats = statSync(input, { bigint: true });
    if (!stats.isFile() || stats.ino === 0n) return null;
    return { dev: stats.dev, ino: stats.ino, links: stats.nlink };
  } catch {
    return null;
  }
}

function isHardlinkInto(root, candidate) {
  const candidateIdentity = fileIdentity(candidate);
  if (!candidateIdentity || candidateIdentity.links < 2n) return false;
  const pending = [canonicalPhysicalPath(root)];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = resolve(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isFile()) {
        const identity = fileIdentity(absolute);
        if (
          identity
          && identity.dev === candidateIdentity.dev
          && identity.ino === candidateIdentity.ino
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function isWithin(root, candidate) {
  if (!candidate) return false;
  const physicalRoot = canonicalPhysicalPath(root);
  const physicalCandidate = canonicalPhysicalPath(candidate);
  const rel = relative(physicalRoot, physicalCandidate);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return true;
  return isHardlinkInto(physicalRoot, physicalCandidate);
}

function isFileUrlSpecifier(specifier) {
  try {
    return new URL(specifier).protocol === 'file:';
  } catch {
    return false;
  }
}

function resolveFileSpecifier(fromFile, specifier) {
  try {
    if (specifier.startsWith('.')) {
      const target = new URL(specifier, pathToFileURL(fromFile));
      if (target.protocol !== 'file:') return null;
      return fileURLToPath(target);
    }
    if (isFileUrlSpecifier(specifier)) {
      const target = new URL(specifier);
      if (target.protocol !== 'file:') return null;
      return fileURLToPath(target);
    }
    if (isAbsolute(specifier)) return resolve(specifier);
    return null;
  } catch {
    return null;
  }
}

function targetsAdapter(specifier, fromFile, targetName, targetRoot) {
  if (specifier.startsWith('<dynamic:')) return true;
  const barePrefixes = [
    `@wendkeep/${targetName}`,
    `wendkeep/${targetName}`,
    `wendkeep/packages/${targetName}`,
  ];
  if (barePrefixes.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`))) {
    return true;
  }
  const pathLike = specifier.startsWith('.') || isFileUrlSpecifier(specifier) || isAbsolute(specifier);
  if (!pathLike) return false;
  const resolved = resolveFileSpecifier(fromFile, specifier);
  return resolved === null || isWithin(targetRoot, resolved);
}

function assertSiblingAdapterIsolation(fromAdapter, source, fromFile) {
  const fromRoot = fromAdapter === 'mcp' ? MCP_WORKSPACE : INTEGRATIONS_WORKSPACE;
  const targetName = fromAdapter === 'mcp' ? 'integrations' : 'mcp';
  const targetRoot = fromAdapter === 'mcp' ? INTEGRATIONS_WORKSPACE : MCP_WORKSPACE;
  const absolute = fromFile || resolve(fromRoot, 'src', 'mutant.mjs');
  const sourceType = absolute.endsWith('.cjs') ? 'script' : 'module';
  const violations = importSpecifiersFromSource(source, { sourceType })
    .filter((specifier) => targetsAdapter(specifier, absolute, targetName, targetRoot));
  assert.deepEqual(
    violations,
    [],
    `adapter siblings must not import directly (${fromAdapter} -> ${targetName}): ${violations.join(', ')}`,
  );
}

function ownedKernelNames(source, sourceType) {
  const names = new Set();
  walk(parsed(source, sourceType), (node) => {
    for (const name of declarationNames(node)) {
      if (MCP_KERNEL_SYMBOLS.has(name)) names.add(name);
    }
    if (node.type === 'ExportNamedDeclaration' && !node.source) {
      for (const specifier of node.specifiers) {
        const exportedName = specifier.exported?.name ?? specifier.exported?.value;
        if (MCP_KERNEL_SYMBOLS.has(exportedName)) names.add(exportedName);
      }
    }
  });
  return names;
}

function assertMcpSourceSet(files, { nativeRuntime = false } = {}) {
  assert.ok(files.length > 0, 'MCP source inventory must not be empty');
  const owners = new Map([...MCP_KERNEL_SYMBOLS].map((name) => [name, []]));
  for (const { absolute, source } of files) {
    assert.ok(isWithin(MCP_WORKSPACE, absolute), `MCP source must stay inside its workspace: ${absolute}`);
    const sourceType = absolute.endsWith('.cjs') ? 'script' : 'module';
    const isConfigKernel = canonicalPhysicalPath(absolute) === canonicalPhysicalPath(MCP_CONFIG);
    if (!nativeRuntime || isConfigKernel) {
      assertAllowedMcpImports(source, { sourceType, fromFile: absolute });
      assertNoImportPhaseEffects(source, { sourceType });
    }
    assertSiblingAdapterIsolation('mcp', source, absolute);
    for (const name of ownedKernelNames(source, sourceType)) {
      owners.get(name).push(canonicalPhysicalPath(absolute));
    }
  }
  const canonicalOwner = canonicalPhysicalPath(MCP_CONFIG);
  for (const [name, paths] of owners) {
    assert.deepEqual(
      [...new Set(paths)],
      [canonicalOwner],
      `MCP kernel ${name} must have config.mjs as its single physical owner`,
    );
  }
}

function assertMcpMergePrecedence(merge, { MCP_SERVER_KEY }) {
  const existingCollision = { type: 'stdio', command: 'existing', args: [] };
  const existingVault = { type: 'stdio', command: 'old-vault', args: [] };
  const companionCollision = { type: 'stdio', command: 'companion', args: ['--last'] };
  const companionVault = { type: 'stdio', command: 'companion-vault', args: ['--last'] };
  const existing = {
    keep: true,
    mcpServers: {
      collision: existingCollision,
      [MCP_SERVER_KEY]: existingVault,
    },
  };
  const baseline = structuredClone(existing);
  const merged = merge(existing, {
    vaultPath: 'C:\\Vault',
    servers: {
      collision: companionCollision,
      [MCP_SERVER_KEY]: companionVault,
    },
  });

  assert.strictEqual(
    merged.mcpServers.collision,
    companionCollision,
    'companion descriptors must override existing servers',
  );
  assert.strictEqual(
    merged.mcpServers[MCP_SERVER_KEY],
    companionVault,
    'companion descriptors must apply after the canonical Vault entry',
  );
  assert.deepEqual(existing, baseline, 'precedence merge must leave the input untouched');
}

function assertLegacyMcpComposition(taxonomySource, initSource) {
  const taxonomyAst = parsed(taxonomySource);
  const initAst = parsed(initSource);
  const legacyDeclarations = [];
  const nonCanonicalImports = [];
  const canonicalTaxonomyImports = new Set();
  const canonicalInitImports = new Set();
  const taxonomyReturnCalls = [];
  const initReturnCalls = [];
  const initCalls = new Set();
  const taxonomyCalls = new Set();
  const publicBindingMutations = [];
  let initWritesMcpServers = false;

  const taxonomyWrappers = directExportedFunctions(taxonomyAst, 'companionMcpPatch');
  const initWrappers = directExportedFunctions(initAst, 'mergeMcp');
  for (const wrapper of taxonomyWrappers) {
    taxonomyReturnCalls.push(...directReturnCallNames(wrapper));
  }
  for (const wrapper of initWrappers) {
    initReturnCalls.push(...directReturnCallNames(wrapper));
  }

  const recordKernelImports = (node, label, canonicalImports) => {
    if (node.type !== 'ImportDeclaration') return;
    for (const specifier of node.specifiers) {
      const localName = specifier.local?.name;
      const importedName = specifier.type === 'ImportSpecifier'
        ? (specifier.imported.name ?? specifier.imported.value)
        : null;
      if (!MCP_KERNEL_SYMBOLS.has(localName) && !MCP_KERNEL_SYMBOLS.has(importedName)) continue;
      if (
        node.source.value === CANONICAL_MCP_IMPORT
        && importedName === localName
        && MCP_KERNEL_SYMBOLS.has(importedName)
      ) {
        canonicalImports.add(localName);
      } else {
        nonCanonicalImports.push(`${label}:${importedName ?? 'default'}->${localName}:${node.source.value}`);
      }
    }
  };

  walk(taxonomyAst, (node) => {
    recordKernelImports(node, 'taxonomy', canonicalTaxonomyImports);
    for (const name of declarationNames(node)) {
      if (MCP_KERNEL_SYMBOLS.has(name)) {
        legacyDeclarations.push(`taxonomy:${name}`);
      }
    }
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
      taxonomyCalls.add(node.callee.name);
      if (node.callee.name === 'eval') publicBindingMutations.push('taxonomy:direct-eval');
    }
    if (assignmentBindingNames(node).includes('companionMcpPatch')) {
      publicBindingMutations.push('taxonomy:companionMcpPatch');
    }
  });
  walk(initAst, (node) => {
    recordKernelImports(node, 'init', canonicalInitImports);
    for (const name of declarationNames(node)) {
      if (MCP_KERNEL_SYMBOLS.has(name)) {
        legacyDeclarations.push(`init:${name}`);
      }
    }
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
      initCalls.add(node.callee.name);
      if (node.callee.name === 'eval') publicBindingMutations.push('init:direct-eval');
    }
    if (assignmentBindingNames(node).includes('mergeMcp')) {
      publicBindingMutations.push('init:mergeMcp');
    }
    if (
      node.type === 'AssignmentExpression'
      && node.left.type === 'MemberExpression'
      && propertyName(node.left) === 'mcpServers'
    ) {
      initWritesMcpServers = true;
    }
  });

  assert.deepEqual(legacyDeclarations, [], 'legacy paths must not own MCP kernel declarations');
  assert.deepEqual(nonCanonicalImports, [], 'legacy MCP bindings must import the canonical MCP kernel');
  assert.equal(
    taxonomyWrappers.length === 1 && namedExportCount(taxonomyAst, 'companionMcpPatch') === 1,
    true,
    'legacy taxonomy must directly export exactly one companionMcpPatch function',
  );
  assert.equal(
    initWrappers.length === 1 && namedExportCount(initAst, 'mergeMcp') === 1,
    true,
    'legacy init must directly export exactly one mergeMcp function',
  );
  assert.deepEqual(publicBindingMutations, [], 'legacy wrapper public binding must not be reassigned');
  for (const name of ['MCP_SERVER_KEY', 'mcpServerEntry', 'selectMcpServers']) {
    assert.ok(canonicalTaxonomyImports.has(name), `legacy taxonomy must import ${name} from the canonical MCP kernel`);
  }
  for (const name of ['MCP_SERVER_KEY', 'mergeMcpConfig']) {
    assert.ok(canonicalInitImports.has(name), `legacy init must import ${name} from the canonical MCP kernel`);
  }
  assert.ok(taxonomyCalls.has('selectMcpServers'), 'legacy taxonomy must delegate descriptor selection');
  assert.ok(
    taxonomyReturnCalls.length > 0 && taxonomyReturnCalls.every((name) => name === 'selectMcpServers'),
    'legacy taxonomy companionMcpPatch must return the canonical MCP kernel selectMcpServers call',
  );
  assert.equal(initWritesMcpServers, false, 'legacy init must not own mcpServers merge');
  assert.ok(initCalls.has('mergeMcpConfig'), 'legacy init must delegate MCP merge');
  assert.ok(
    initReturnCalls.length > 0 && initReturnCalls.every((name) => name === 'mergeMcpConfig'),
    'legacy init mergeMcp must return the canonical MCP kernel mergeMcpConfig call',
  );
}

test('[req:MOD-17] MCP workspace declares and owns its private configuration kernel', () => {
  const pkg = JSON.parse(readFileSync(MCP_PACKAGE, 'utf8'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.exports, './src/index.mjs');
  assert.ok(existsSync(MCP_INDEX), 'packages/mcp/src/index.mjs must exist');
  assert.ok(existsSync(MCP_CONFIG), 'packages/mcp/src/config.mjs must exist');

  assertMcpRuntimeOwnership(readFileSync(MCP_CONFIG, 'utf8'));
});

test('[req:MOD-17] MCP ownership and dependency gates reject delegated or cross-adapter mutants', () => {
  const delegated = `
    export {
      MCP_SERVER_KEY,
      mcpServerEntry,
      selectMcpServers,
      mergeMcpConfig,
    } from '../../../src/mcp-config.mjs';
  `;
  assert.throws(
    () => assertMcpRuntimeOwnership(delegated),
    /MCP config kernel must own/,
  );

  const crossAdapter = `import { COMPANIONS } from '../../../src/taxonomy.mjs';`;
  assert.throws(
    () => assertAllowedMcpImports(crossAdapter),
    /imports only local workspace modules/,
  );
});

test('[req:MOD-17] MCP configuration kernel stays import-inert beside the explicit native runtime', () => {
  assertMcpSourceSet(
    workspaceSourceFiles(MCP_WORKSPACE)
      .map((absolute) => ({ absolute, source: readFileSync(absolute, 'utf8') })),
    { nativeRuntime: true },
  );

  const moduleUrl = pathToFileURL(MCP_INDEX).href;
  const probe = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `const m = await import(${JSON.stringify(moduleUrl)}); process.stdout.write([
      m.MCP_SERVER_KEY,
      typeof m.mcpServerEntry,
      typeof m.selectMcpServers,
      typeof m.mergeMcpConfig,
    ].join('|'));`,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, OBSIDIAN_VAULT_PATH: '' },
  });

  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stderr, '');
  assert.equal(probe.stdout, 'wendkeep-vault|function|function|function');
});

test('[req:MOD-17] MCP import gate rejects silent filesystem and subprocess mutants', () => {
  assert.throws(
    () => assertAllowedMcpImports(`
      import { readFileSync } from 'node:fs';
      export const state = readFileSync('silent-input');
    `),
    /local workspace modules/,
  );
  assert.throws(
    () => assertAllowedMcpImports(`
      import { spawnSync } from 'node:child_process';
      spawnSync('node', ['--version'], { stdio: 'ignore' });
    `),
    /local workspace modules/,
  );
  assert.throws(
    () => assertAllowedMcpImports(`
      export * from './nested/../../../../src/taxonomy.mjs';
    `),
    /local workspace modules/,
  );
  assert.throws(
    () => assertAllowedMcpImports(`
      export * from './nested/%2e%2e/%2e%2e/%2e%2e/%2e%2e/src/taxonomy.mjs';
    `),
    /local workspace modules/,
  );
});

test('[req:MOD-17] MCP import-inert gate rejects effects hidden in transitive local modules', () => {
  const indexFile = resolve(MCP_WORKSPACE, 'src', 'index.mjs');
  const hiddenFile = resolve(MCP_WORKSPACE, 'src', 'silent-effects.mjs');
  assert.throws(
    () => assertMcpSourceSet([
      { absolute: indexFile, source: `export * from './silent-effects.mjs';` },
      {
        absolute: hiddenFile,
        source: `process.getBuiltinModule('node:fs').readFileSync('silent-input');`,
      },
    ]),
    /import-time effects/,
  );
  assert.throws(
    () => assertMcpSourceSet([
      { absolute: indexFile, source: `export * from './silent-effects.mjs';` },
      {
        absolute: hiddenFile,
        source: `process.getBuiltinModule('node:child_process').spawnSync('node', ['--version']);`,
      },
    ]),
    /import-time effects/,
  );
});

test('[req:MOD-17] MCP source inventory rejects a second pure kernel implementation', () => {
  const duplicateFile = resolve(MCP_WORKSPACE, 'src', 'duplicate-config.mjs');
  assert.throws(
    () => assertMcpSourceSet([
      { absolute: MCP_CONFIG, source: readFileSync(MCP_CONFIG, 'utf8') },
      { absolute: MCP_INDEX, source: readFileSync(MCP_INDEX, 'utf8') },
      {
        absolute: duplicateFile,
        source: `
          export const MCP_SERVER_KEY = 'duplicate-vault';
          export function mcpServerEntry() { return {}; }
          export function selectMcpServers() { return {}; }
          export function mergeMcpConfig(existing) { return { ...existing }; }
        `,
      },
    ]),
    /single physical owner|unique owner|config\.mjs/,
  );
});

test('[req:MOD-18] MCP and Integrations isolation rejects direct imports in both directions', () => {
  assert.ok(existsSync(MCP_WORKSPACE));
  assert.ok(existsSync(INTEGRATIONS_WORKSPACE));
  for (const [adapter, workspace] of [
    ['mcp', MCP_WORKSPACE],
    ['integrations', INTEGRATIONS_WORKSPACE],
  ]) {
    for (const absolute of workspaceSourceFiles(workspace)) {
      assertSiblingAdapterIsolation(adapter, readFileSync(absolute, 'utf8'), absolute);
    }
  }

  assert.throws(
    () => assertSiblingAdapterIsolation('integrations', `
      import { mergeMcpConfig } from '@wendkeep/mcp';
    `),
    /adapter siblings/,
  );
  assert.throws(
    () => assertSiblingAdapterIsolation('integrations', `
      import { mergeMcpConfig } from '../../mcp/src/index.mjs';
    `),
    /adapter siblings/,
  );
  assert.throws(
    () => assertSiblingAdapterIsolation('integrations', `
      import './nested/%2e%2e/%2e%2e/%2e%2e/mcp/src/index.mjs';
    `),
    /adapter siblings/,
  );
  assert.throws(
    () => assertSiblingAdapterIsolation('mcp', `
      import { projectHooks } from '@wendkeep/integrations';
    `),
    /adapter siblings/,
  );
  assert.throws(
    () => assertSiblingAdapterIsolation('mcp', `
      import { projectHooks } from '../../integrations/src/index.mjs';
    `),
    /adapter siblings/,
  );
  assert.throws(
    () => assertSiblingAdapterIsolation('mcp', `
      import './nested/%2e%2e/%2e%2e/%2e%2e/integrations/src/index.mjs';
    `),
    /adapter siblings/,
  );
  assert.throws(
    () => assertSiblingAdapterIsolation('integrations', `
      import ${JSON.stringify(pathToFileURL(resolve(MCP_WORKSPACE, 'src', 'index.mjs')).href)};
    `),
    /adapter siblings/,
  );
  assert.throws(
    () => assertSiblingAdapterIsolation(
      'integrations',
      `module.require(${JSON.stringify(resolve(MCP_WORKSPACE, 'src', 'index.mjs'))});`,
      resolve(INTEGRATIONS_WORKSPACE, 'src', 'mutant.cjs'),
    ),
    /adapter siblings/,
  );
  assert.throws(
    () => assertSiblingAdapterIsolation('mcp', `
      import ${JSON.stringify(pathToFileURL(resolve(INTEGRATIONS_WORKSPACE, 'src', 'index.mjs')).href)};
    `),
    /adapter siblings/,
  );
  assert.throws(
    () => assertSiblingAdapterIsolation(
      'mcp',
      `require(${JSON.stringify(resolve(INTEGRATIONS_WORKSPACE, 'src', 'index.mjs'))});`,
      resolve(MCP_WORKSPACE, 'src', 'mutant.cjs'),
    ),
    /adapter siblings/,
  );

  const aliasRoot = mkdtempSync(resolve(tmpdir(), 'wk-mcp-adapter-alias-'));
  try {
    const mcpAlias = resolve(aliasRoot, 'mcp-alias');
    const integrationsAlias = resolve(aliasRoot, 'integrations-alias');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(MCP_WORKSPACE, mcpAlias, linkType);
    symlinkSync(INTEGRATIONS_WORKSPACE, integrationsAlias, linkType);
    assert.throws(
      () => assertSiblingAdapterIsolation('integrations', `
        import ${JSON.stringify(pathToFileURL(resolve(mcpAlias, 'src', 'index.mjs')).href)};
      `),
      /adapter siblings/,
    );
    assert.throws(
      () => assertSiblingAdapterIsolation('integrations', `
        import ${JSON.stringify(pathToFileURL(resolve(mcpAlias, 'src', 'future-module.mjs')).href)};
      `),
      /adapter siblings/,
    );
    assert.throws(
      () => assertSiblingAdapterIsolation(
        'mcp',
        `module.require(${JSON.stringify(resolve(integrationsAlias, 'package.json'))});`,
        resolve(MCP_WORKSPACE, 'src', 'mutant.cjs'),
      ),
      /adapter siblings/,
    );
  } finally {
    rmSync(aliasRoot, { recursive: true, force: true });
  }
});

test('[req:MOD-18] adapter isolation recognizes case-insensitive file URLs and static computed require', () => {
  const uppercaseFileUrl = pathToFileURL(MCP_INDEX).href.replace(/^file:/, 'FILE:');
  assert.throws(
    () => assertSiblingAdapterIsolation('integrations', `import ${JSON.stringify(uppercaseFileUrl)};`),
    /adapter siblings/,
  );

  const integrationsPackage = resolve(INTEGRATIONS_WORKSPACE, 'package.json');
  assert.throws(
    () => assertSiblingAdapterIsolation(
      'mcp',
      'module[`require`](' + JSON.stringify(integrationsPackage) + ');',
      resolve(MCP_WORKSPACE, 'src', 'mutant.cjs'),
    ),
    /adapter siblings/,
  );
  assert.throws(
    () => assertSiblingAdapterIsolation(
      'mcp',
      "module['requ' + 'ire'](" + JSON.stringify(integrationsPackage) + ');',
      resolve(MCP_WORKSPACE, 'src', 'mutant.cjs'),
    ),
    /adapter siblings/,
  );
  assert.throws(
    () => assertSiblingAdapterIsolation(
      'mcp',
      "globalThis['requ' + 'ire'](" + JSON.stringify(integrationsPackage) + ');',
      resolve(MCP_WORKSPACE, 'src', 'mutant.cjs'),
    ),
    /adapter siblings/,
  );
  assert.throws(
    () => assertSiblingAdapterIsolation(
      'mcp',
      "module['constructor' + '']._load(" + JSON.stringify(integrationsPackage) + ');',
      resolve(MCP_WORKSPACE, 'src', 'mutant.cjs'),
    ),
    /adapter siblings/,
  );
  assert.throws(
    () => assertSiblingAdapterIsolation(
      'mcp',
      "module.constructor['_' + 'load'](" + JSON.stringify(integrationsPackage) + ');',
      resolve(MCP_WORKSPACE, 'src', 'mutant.cjs'),
    ),
    /adapter siblings/,
  );
  assert.throws(
    () => assertSiblingAdapterIsolation(
      'mcp',
      'const load = module.require.bind(module); load(' + JSON.stringify(integrationsPackage) + ');',
      resolve(MCP_WORKSPACE, 'src', 'mutant.cjs'),
    ),
    /adapter siblings/,
  );
  assert.throws(
    () => assertSiblingAdapterIsolation(
      'mcp',
      'const Loader = module.constructor; Loader._load(' + JSON.stringify(integrationsPackage) + ');',
      resolve(MCP_WORKSPACE, 'src', 'mutant.cjs'),
    ),
    /adapter siblings/,
  );
  assert.throws(
    () => assertSiblingAdapterIsolation(
      'mcp',
      'const invoke = module.require.call; invoke.call(module.require, null, '
        + JSON.stringify(integrationsPackage) + ');',
      resolve(MCP_WORKSPACE, 'src', 'mutant.cjs'),
    ),
    /adapter siblings/,
  );
  assert.throws(
    () => assertSiblingAdapterIsolation(
      'mcp',
      'Reflect.apply(module.require, module, [' + JSON.stringify(integrationsPackage) + ']);',
      resolve(MCP_WORKSPACE, 'src', 'mutant.cjs'),
    ),
    /adapter siblings/,
  );
  assert.throws(
    () => assertSiblingAdapterIsolation(
      'mcp',
      'Reflect.apply(module.constructor._load, module.constructor, ['
        + JSON.stringify(integrationsPackage) + ']);',
      resolve(MCP_WORKSPACE, 'src', 'mutant.cjs'),
    ),
    /adapter siblings/,
  );
  assert.throws(
    () => assertSiblingAdapterIsolation(
      'mcp',
      'Function.prototype.call.call(module.require, module, '
        + JSON.stringify(integrationsPackage) + ');',
      resolve(MCP_WORKSPACE, 'src', 'mutant.cjs'),
    ),
    /adapter siblings/,
  );
  assert.deepEqual(
    importSpecifiersFromSource(
      'Reflect.apply(module.require, module, [' + JSON.stringify(integrationsPackage) + ']);',
      { sourceType: 'script' },
    ),
    [integrationsPackage],
  );
  assert.deepEqual(
    importSpecifiersFromSource(
      'Reflect.apply(module.constructor._load, module.constructor, ['
        + JSON.stringify(integrationsPackage) + ']);',
      { sourceType: 'script' },
    ),
    [integrationsPackage],
  );
  assert.throws(
    () => assertSiblingAdapterIsolation(
      'mcp',
      'const load = module.require; Reflect.apply(load, module, ['
        + JSON.stringify(integrationsPackage) + ']);',
      resolve(MCP_WORKSPACE, 'src', 'mutant.cjs'),
    ),
    /adapter siblings/,
  );
  assert.throws(
    () => assertSiblingAdapterIsolation(
      'mcp',
      'const invoke = Reflect.apply; invoke(module.require, module, ['
        + JSON.stringify(integrationsPackage) + ']);',
      resolve(MCP_WORKSPACE, 'src', 'mutant.cjs'),
    ),
    /adapter siblings/,
  );
  assert.deepEqual(
    importSpecifiersFromSource(
      'const args = [' + JSON.stringify(integrationsPackage)
        + ']; Reflect.apply(module.require, module, args);',
      { sourceType: 'script' },
    ),
    ['<dynamic:require>'],
  );
  for (const source of [
    'globalThis.Reflect.apply(module.require, module, ['
      + JSON.stringify(integrationsPackage) + ']);',
    'Reflect.apply.call(null, module.require, module, ['
      + JSON.stringify(integrationsPackage) + ']);',
    'const load = Function.prototype.call.bind(module.require); load(module, '
      + JSON.stringify(integrationsPackage) + ');',
    'const load = Function.prototype.apply.bind(module.constructor._load); '
      + 'load(module.constructor, [' + JSON.stringify(integrationsPackage) + ']);',
    'const load = Reflect.apply.bind(Reflect, module.require, module, ['
      + JSON.stringify(integrationsPackage) + ']); load();',
    'Function.prototype.call.bind(Function.prototype.call)(module.require, module, '
      + JSON.stringify(integrationsPackage) + ');',
  ]) {
    assert.throws(
      () => assertSiblingAdapterIsolation(
        'mcp',
        source,
        resolve(MCP_WORKSPACE, 'src', 'mutant.cjs'),
      ),
      /adapter siblings/,
    );
  }
  assert.deepEqual(
    importSpecifiersFromSource(
      "Reflect.apply(Math.max, null, [1, 2]); Function.prototype.call.call(String.prototype.toUpperCase, 'x');",
      { sourceType: 'script' },
    ),
    [],
  );
});

test('[req:MOD-18] adapter isolation tracks higher-order receivers and Module loaders', () => {
  const integrationsPackage = resolve(INTEGRATIONS_WORKSPACE, 'package.json');
  const encodedTarget = JSON.stringify(integrationsPackage);
  for (const source of [
    `Reflect.apply(Function.prototype.call, module.require, [module, ${encodedTarget}]);`,
    `Reflect.apply(Function.prototype.apply, module.require, [module, [${encodedTarget}]]);`,
    'Function.prototype.call.call(Function.prototype.call, module.require, module, '
      + `${encodedTarget});`,
    'Function.prototype.call.apply(Function.prototype.call, '
      + `[module.require, module, ${encodedTarget}]);`,
    `require('node:module')._load(${encodedTarget});`,
    `const Loader = require('node:module'); Loader._load(${encodedTarget});`,
    `require('node:module').createRequire(__filename)(${encodedTarget});`,
    "const { createRequire } = require('node:module'); "
      + `createRequire(__filename)(${encodedTarget});`,
    `process.getBuiltinModule('node:module')._load(${encodedTarget});`,
  ]) {
    assert.throws(
      () => assertSiblingAdapterIsolation(
        'mcp',
        source,
        resolve(MCP_WORKSPACE, 'src', 'mutant.cjs'),
      ),
      /adapter siblings/,
    );
  }

  for (const source of [
    `import Module from 'node:module'; Module._load(${encodedTarget});`,
    "import { createRequire } from 'node:module'; "
      + `createRequire(import.meta.url)(${encodedTarget});`,
  ]) {
    assert.throws(
      () => assertSiblingAdapterIsolation(
        'mcp',
        source,
        resolve(MCP_WORKSPACE, 'src', 'mutant.mjs'),
      ),
      /adapter siblings/,
    );
  }
});

test('[req:MOD-18] adapter isolation fails closed on indirect Module acquisition', () => {
  const integrationsPackage = resolve(INTEGRATIONS_WORKSPACE, 'package.json');
  const encodedTarget = JSON.stringify(integrationsPackage);
  for (const source of [
    `Reflect.apply(require, null, ['node:module'])._load(${encodedTarget});`,
    'Function.prototype.call.call(require, null, '
      + `'node:module')._load(${encodedTarget});`,
    "Reflect.apply(process.getBuiltinModule, process, ['node:module'])"
      + `._load(${encodedTarget});`,
    `process.getBuiltinModule.call(process, 'node:module')._load(${encodedTarget});`,
    `process.getBuiltinModule('node:' + 'module')._load(${encodedTarget});`,
    "const name = 'node:module'; "
      + `process.getBuiltinModule(name)._load(${encodedTarget});`,
    "Reflect.apply(require('node:module').createRequire, null, [__filename])"
      + `(${encodedTarget});`,
  ]) {
    assert.throws(
      () => assertSiblingAdapterIsolation(
        'mcp',
        source,
        resolve(MCP_WORKSPACE, 'src', 'mutant.cjs'),
      ),
      /adapter siblings/,
    );
  }

  for (const source of [
    "const { createRequire } = await import('node:module'); "
      + `createRequire(import.meta.url)(${encodedTarget});`,
    `(await import('node:module')).default._load(${encodedTarget});`,
    "const Module = await import('node:module'); "
      + `Module.default._load(${encodedTarget});`,
    "import('node:module').then(({ createRequire }) => "
      + `createRequire(import.meta.url)(${encodedTarget}));`,
  ]) {
    assert.throws(
      () => assertSiblingAdapterIsolation(
        'mcp',
        source,
        resolve(MCP_WORKSPACE, 'src', 'mutant.mjs'),
      ),
      /adapter siblings/,
    );
  }

  assert.deepEqual(
    importSpecifiersFromSource("process.getBuiltinModule('node:path').join('a', 'b');", {
      sourceType: 'script',
    }),
    [],
  );
});

test('[req:MOD-18] adapter isolation recognizes file URLs with loader-trimmed ASCII whitespace', () => {
  const paddedFileUrl = ` \t${pathToFileURL(MCP_INDEX).href} `;
  assert.throws(
    () => assertSiblingAdapterIsolation('integrations', `import ${JSON.stringify(paddedFileUrl)};`),
    /adapter siblings/,
  );
});

test('[req:MOD-18] adapter isolation rejects hardlink aliases in both directions', () => {
  const hardlinkRoot = mkdtempSync(resolve(ROOT, '.wk-mcp-hardlink-'));
  try {
    const mcpHardlink = resolve(hardlinkRoot, 'mcp-config-hardlink.mjs');
    const integrationsHardlink = resolve(hardlinkRoot, 'integrations-package-hardlink.json');
    linkSync(MCP_CONFIG, mcpHardlink);
    linkSync(resolve(INTEGRATIONS_WORKSPACE, 'package.json'), integrationsHardlink);

    for (const [adapter, target] of [
      ['integrations', mcpHardlink],
      ['mcp', integrationsHardlink],
    ]) {
      assert.throws(
        () => assertSiblingAdapterIsolation(
          adapter,
          `import ${JSON.stringify(pathToFileURL(target).href)};`,
        ),
        /adapter siblings/,
      );
      assert.throws(
        () => assertSiblingAdapterIsolation(
          adapter,
          `require(${JSON.stringify(target)});`,
          resolve(adapter === 'mcp' ? MCP_WORKSPACE : INTEGRATIONS_WORKSPACE, 'src', 'mutant.cjs'),
        ),
        /adapter siblings/,
      );
    }
  } finally {
    rmSync(hardlinkRoot, { recursive: true, force: true });
  }
});

test('[req:MOD-17] [req:MOD-18] legacy MCP paths preserve identity and compose the canonical kernel', async () => {
  const taxonomySource = readFileSync(LEGACY_TAXONOMY, 'utf8');
  const initSource = readFileSync(LEGACY_INIT, 'utf8');
  assertLegacyMcpComposition(taxonomySource, initSource);

  const ownershipMutant = `
    function selectMcpServers() { return {}; }
    export const MCP_SERVER_KEY = 'mutant';
    export function mcpServerEntry() { return {}; }
    export function companionMcpPatch() { return selectMcpServers(); }
  `;
  assert.throws(
    () => assertLegacyMcpComposition(ownershipMutant, initSource),
    /legacy paths must not own/,
  );
  assert.throws(
    () => assertLegacyMcpComposition(
      taxonomySource,
      initSource.replace('return mergeMcpConfig(', 'const m = {}; m.mcpServers = {}; return mergeMcpConfig('),
    ),
    /legacy init must not own/,
  );
  assert.throws(
    () => assertLegacyMcpComposition(`
      function selectMcpServers() { return {}; }
      export function companionMcpPatch() { return selectMcpServers(); }
    `, initSource),
    /legacy paths must not own/,
  );
  assert.throws(
    () => assertLegacyMcpComposition(taxonomySource, `
      function mergeMcpConfig() { return {}; }
      export function mergeMcp() { return mergeMcpConfig(); }
    `),
    /legacy paths must not own/,
  );
  assert.throws(
    () => assertLegacyMcpComposition(`
      const { selectMcpServers } = { selectMcpServers() { return {}; } };
      export function companionMcpPatch() { return selectMcpServers(); }
    `, initSource),
    /legacy paths must not own/,
  );
  assert.throws(
    () => assertLegacyMcpComposition(taxonomySource, `
      const { mergeMcpConfig } = { mergeMcpConfig() { return {}; } };
      export function mergeMcp() { return mergeMcpConfig(); }
    `),
    /legacy paths must not own/,
  );

  const canonical = await import(pathToFileURL(MCP_INDEX).href);
  const legacy = await import(pathToFileURL(LEGACY_TAXONOMY).href);
  assert.strictEqual(legacy.MCP_SERVER_KEY, canonical.MCP_SERVER_KEY);
  assert.strictEqual(legacy.mcpServerEntry, canonical.mcpServerEntry);
});

test('[req:MOD-17] legacy composition rejects parameter ownership and noncanonical kernel imports', () => {
  const taxonomySource = readFileSync(LEGACY_TAXONOMY, 'utf8');
  const initSource = readFileSync(LEGACY_INIT, 'utf8');
  assert.throws(
    () => assertLegacyMcpComposition(`
      export function companionMcpPatch({ selectMcpServers = () => ({}) } = {}) {
        return selectMcpServers();
      }
    `, initSource),
    /legacy paths must not own/,
  );
  assert.throws(
    () => assertLegacyMcpComposition(taxonomySource, `
      export function mergeMcp(existing, mergeMcpConfig = () => ({})) {
        return mergeMcpConfig(existing);
      }
    `),
    /legacy paths must not own/,
  );
  assert.throws(
    () => assertLegacyMcpComposition(`
      import { selectMcpServers } from './rogue.mjs';
      export function companionMcpPatch() { return selectMcpServers(); }
    `, initSource),
    /canonical MCP kernel/,
  );
});

test('[req:MOD-17] legacy wrappers must return the canonical imported kernel call', () => {
  const taxonomySource = readFileSync(LEGACY_TAXONOMY, 'utf8');
  const initSource = readFileSync(LEGACY_INIT, 'utf8');
  assert.throws(
    () => assertLegacyMcpComposition(`
      import {
        MCP_SERVER_KEY,
        mcpServerEntry,
        selectMcpServers,
      } from ${JSON.stringify(CANONICAL_MCP_IMPORT)};
      import { selectMcpServers as rogueSelect } from './rogue.mjs';
      export { MCP_SERVER_KEY, mcpServerEntry };
      export function companionMcpPatch() {
        selectMcpServers([], []);
        return rogueSelect([], []);
      }
    `, initSource),
    /canonical MCP kernel|must return/,
  );
  assert.throws(
    () => assertLegacyMcpComposition(taxonomySource, `
      import { MCP_SERVER_KEY, mergeMcpConfig } from ${JSON.stringify(CANONICAL_MCP_IMPORT)};
      import { mergeMcpConfig as rogueMerge } from './rogue.mjs';
      export function mergeMcp(existing) {
        mergeMcpConfig(existing, {});
        return rogueMerge(existing, {});
      }
    `),
    /canonical MCP kernel|must return/,
  );
});

test('[req:MOD-17] legacy wrappers must own their exported binding without later reassignment', () => {
  const taxonomySource = readFileSync(LEGACY_TAXONOMY, 'utf8');
  const initSource = readFileSync(LEGACY_INIT, 'utf8');
  assert.throws(
    () => assertLegacyMcpComposition(`
      import {
        MCP_SERVER_KEY,
        mcpServerEntry,
        selectMcpServers,
      } from ${JSON.stringify(CANONICAL_MCP_IMPORT)};
      export { MCP_SERVER_KEY, mcpServerEntry };
      function companionMcpPatch() { return selectMcpServers([], []); }
      export { default as companionMcpPatch } from './rogue.mjs';
    `, initSource),
    /directly export|public binding/,
  );
  assert.throws(
    () => assertLegacyMcpComposition(taxonomySource, `
      import { MCP_SERVER_KEY, mergeMcpConfig } from ${JSON.stringify(CANONICAL_MCP_IMPORT)};
      function mergeMcp(existing) { return mergeMcpConfig(existing, {}); }
      export { default as mergeMcp } from './rogue.mjs';
    `),
    /directly export|public binding/,
  );
  assert.throws(
    () => assertLegacyMcpComposition(`
      import {
        MCP_SERVER_KEY,
        mcpServerEntry,
        selectMcpServers,
      } from ${JSON.stringify(CANONICAL_MCP_IMPORT)};
      export { MCP_SERVER_KEY, mcpServerEntry };
      export function companionMcpPatch() { return selectMcpServers([], []); }
      companionMcpPatch = () => ({});
    `, initSource),
    /public binding/,
  );
  assert.throws(
    () => assertLegacyMcpComposition(`
      import {
        MCP_SERVER_KEY,
        mcpServerEntry,
        selectMcpServers,
      } from ${JSON.stringify(CANONICAL_MCP_IMPORT)};
      export { MCP_SERVER_KEY, mcpServerEntry };
      export function companionMcpPatch() { return selectMcpServers([], []); }
      eval('companionMcpPatch = () => ({ rogue: true })');
    `, initSource),
    /public binding|dynamic evaluation/,
  );
  assert.throws(
    () => assertLegacyMcpComposition(taxonomySource, `
      import { MCP_SERVER_KEY, mergeMcpConfig } from ${JSON.stringify(CANONICAL_MCP_IMPORT)};
      export function mergeMcp(existing) { return mergeMcpConfig(existing, {}); }
      eval('mergeMcp = () => ({ rogue: true })');
    `),
    /public binding|dynamic evaluation/,
  );
});

test('[req:MOD-18] MCP kernel preserves the canonical transport and selects descriptors deterministically', async () => {
  const {
    mcpServerEntry,
    selectMcpServers,
  } = await import(pathToFileURL(MCP_INDEX).href);

  assert.deepEqual(mcpServerEntry('C:\\Vault'), {
    type: 'stdio',
    command: 'npx',
    args: ['--no-install', 'wendkeep', 'mcp', 'serve', '--vault', 'C:\\Vault'],
  });

  const first = { type: 'stdio', command: 'first', args: [] };
  const last = { type: 'stdio', command: 'last', args: ['--safe'] };
  assert.deepEqual(
    selectMcpServers([
      { id: 'ignored' },
      { id: 'first', key: 'shared', entry: first },
      { id: 'skipped', key: 'skip-me', entry: first },
      { id: 'last', key: 'shared', entry: last },
    ], ['skipped']),
    { shared: last },
  );
});

test('[req:MOD-18] MCP merge is immutable, idempotent, and preserves existing configuration', async () => {
  const {
    MCP_SERVER_KEY,
    mergeMcpConfig,
  } = await import(pathToFileURL(MCP_INDEX).href);

  const existing = {
    custom: { keep: true },
    mcpServers: {
      user: { type: 'stdio', command: 'user', args: [] },
      [MCP_SERVER_KEY]: { type: 'stdio', command: 'old', args: [] },
    },
  };
  const baseline = structuredClone(existing);
  const options = {
    vaultPath: 'C:\\Vault',
    servers: {
      companion: { type: 'stdio', command: 'companion', args: [] },
    },
  };
  const merged = mergeMcpConfig(existing, options);

  assert.deepEqual(existing, baseline, 'merge must not mutate consumer configuration');
  assert.deepEqual(merged.custom, { keep: true });
  assert.deepEqual(merged.mcpServers.user, baseline.mcpServers.user);
  assert.deepEqual(merged.mcpServers[MCP_SERVER_KEY], {
    type: 'stdio',
    command: 'npx',
    args: ['--no-install', 'wendkeep', 'mcp', 'serve', '--vault', 'C:\\Vault'],
  });
  assert.deepEqual(merged.mcpServers.companion, options.servers.companion);
  assert.deepEqual(mergeMcpConfig(merged, options), merged, 'merge must be idempotent');

  const withoutVault = mergeMcpConfig(existing, {
    ...options,
    withVault: false,
  });
  assert.deepEqual(
    withoutVault.mcpServers[MCP_SERVER_KEY],
    baseline.mcpServers[MCP_SERVER_KEY],
    'withVault false preserves a consumer entry instead of deleting it',
  );
});

test('[req:MOD-18] MCP merge preserves baseline precedence: existing, Vault, then companions', async () => {
  const canonical = await import(pathToFileURL(MCP_INDEX).href);
  assertMcpMergePrecedence(canonical.mergeMcpConfig, canonical);

  const existingWinsMutant = (existing, options) => {
    const merged = canonical.mergeMcpConfig(existing, options);
    return {
      ...merged,
      mcpServers: {
        ...merged.mcpServers,
        collision: existing.mcpServers.collision,
      },
    };
  };
  assert.throws(
    () => assertMcpMergePrecedence(existingWinsMutant, canonical),
    /companion descriptors must override existing servers/,
  );
});
