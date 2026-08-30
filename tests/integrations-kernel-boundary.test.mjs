import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'acorn';
import { importSpecifiersFromSource } from './helpers/import-specifiers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INTEGRATIONS = resolve(ROOT, 'packages', 'integrations');
const INTEGRATIONS_PACKAGE = resolve(INTEGRATIONS, 'package.json');
const CANONICAL_MODULES = [
  'src/host-hooks.mjs',
  'src/hook-envelope.mjs',
  'src/prompt-content.mjs',
  'src/transcript-usage.mjs',
  'src/transcripts.mjs',
  'src/session-identity.mjs',
  'src/index.mjs',
];
const OWNED_BINDINGS = new Map([
  ['src/host-hooks.mjs', [
    'SESSION_HOOKS', 'CHANGE_NUDGE_HOOKS', 'CHANGE_GATE_HOOKS',
    'CODEX_MATCHER_EVENTS', 'hookCommand', 'hookCommandLocal',
    'hookCommandLocalLegacy', 'codexHookSpecs', 'codexHookEntry',
  ]],
  ['src/hook-envelope.mjs', [
    'salvageTruncatedJson', 'parseHookInput', 'stringifyHookOutput',
    'detectProvider', 'providerMeta', 'extractHookPrompt',
  ]],
  ['src/prompt-content.mjs', ['isBootstrapPrompt', 'redactSecrets', 'sanitizeAssistantMessage']],
  ['src/transcript-usage.mjs', [
    'emptyTokenUsage', 'normalizeCodexUsage', 'normalizeClaudeUsage', 'addUsage',
  ]],
  ['src/transcripts.mjs', [
    'parseCodexTranscriptContent', 'parseClaudeTranscriptContent',
    'parseTranscriptContent', 'resolveTurnIdentity',
  ]],
  ['src/session-identity.mjs', [
    'inspectTranscriptIdentityContent', 'resolveSessionIdentitySnapshot',
    'transcriptsMatch',
  ]],
]);
const EFFECTFUL_BUILTINS = /^(?:node:)?(?:fs|fs\/promises|child_process|cluster|dgram|dns|http|https|net|readline|tls|worker_threads)$/;

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

function ast(source) {
  return parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
}

function staticMemberName(node) {
  if (node?.type !== 'MemberExpression') return null;
  if (!node.computed && node.property?.type === 'Identifier') return node.property.name;
  if (node.computed && node.property?.type === 'Literal') return node.property.value;
  return null;
}

function declarationNames(source) {
  const names = [];
  for (const statement of ast(source).body) {
    const node = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (node?.type === 'FunctionDeclaration' || node?.type === 'ClassDeclaration') {
      if (node.id?.name) names.push(node.id.name);
    } else if (node?.type === 'VariableDeclaration') {
      for (const declaration of node.declarations) {
        if (declaration.id?.type === 'Identifier') names.push(declaration.id.name);
      }
    }
  }
  return names;
}

function insideWorkspace(path) {
  const rel = relative(INTEGRATIONS, path);
  return rel === '' || (!rel.startsWith('..') && !resolve(rel).startsWith('..'));
}

function assertAllowedImports(source, absolute = resolve(INTEGRATIONS, 'src', 'mutant.mjs')) {
  const violations = importSpecifiersFromSource(source).filter((specifier) => {
    if (specifier.startsWith('<dynamic:')) return true;
    if (specifier.startsWith('.')) return !insideWorkspace(resolve(dirname(absolute), specifier));
    if (specifier === 'node:path' || specifier === 'path') return false;
    return true;
  });
  assert.deepEqual(violations, []);
}

function assertImportInertSource(source) {
  const tree = ast(source);
  const violations = [];
  walk(tree, (node) => {
    if (node.type === 'ImportDeclaration' && EFFECTFUL_BUILTINS.test(String(node.source?.value || ''))) {
      violations.push(String(node.source.value));
    }
    if (node.type === 'Identifier' && node.name === 'process') violations.push('process');
    if (node.type === 'MemberExpression'
      && node.object?.type === 'Identifier'
      && ['global', 'globalThis'].includes(node.object.name)
      && ['process', 'fetch', 'eval', 'Function'].includes(staticMemberName(node))) {
      violations.push(`${node.object.name}.${staticMemberName(node)}`);
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier'
      && ['eval', 'fetch', 'Function'].includes(node.callee.name)) violations.push(node.callee.name);
    if (node.type === 'NewExpression' && node.callee?.type === 'Identifier'
      && node.callee.name === 'Function') violations.push('Function');
  });
  assert.deepEqual(violations, []);
}

function assertSingleOwnership(sources) {
  const owners = new Map();
  for (const [file, source] of sources) {
    for (const name of declarationNames(source)) {
      if (!owners.has(name)) owners.set(name, []);
      owners.get(name).push(file);
    }
  }
  for (const [file, names] of OWNED_BINDINGS) {
    for (const name of names) assert.deepEqual(owners.get(name), [file], `${name} must have one canonical owner`);
  }
}

function assertCheckCoversIntegrations(root) {
  for (const path of CANONICAL_MODULES) {
    assert.ok(
      root.scripts?.check?.includes(`node --check packages/integrations/${path}`),
      `root check omits packages/integrations/${path}`,
    );
  }
}

test('[req:MOD-20] Integrations workspace declares and owns its private host kernel', () => {
  const workspace = json(INTEGRATIONS_PACKAGE);
  const root = json(resolve(ROOT, 'package.json'));

  assert.equal(workspace.private, true);
  assert.equal(workspace.exports, './src/index.mjs');
  for (const path of CANONICAL_MODULES) {
    assert.ok(existsSync(resolve(INTEGRATIONS, path)), `missing Integrations module: ${path}`);
  }
  assertCheckCoversIntegrations(root);
  assert.equal(Object.hasOwn(root.exports || {}, './integrations'), false, 'wendkeep/integrations must remain absent');
  assert.equal(Object.hasOwn(root.exports || {}, './*'), false, 'root wildcard would expose private workspaces');
  const publicPackageTargets = new Set([
    './packages/commit/src/index.mjs',
    './packages/harness/src/index.mjs',
    './packages/vault/src/index.mjs',
  ]);
  assert.equal(
    Object.entries(root.exports || {}).some(([key, target]) => (
      key.startsWith('./packages')
      || (String(target).startsWith('./packages') && !publicPackageTargets.has(target))
    )),
    false,
    'private workspace paths must not be exported',
  );
});

test('[req:MOD-20] Integrations kernel is import-inert and adapter-independent', () => {
  const sources = CANONICAL_MODULES.map((path) => {
    const absolute = resolve(INTEGRATIONS, path);
    assert.ok(existsSync(absolute), `missing Integrations module: ${path}`);
    const source = readFileSync(absolute, 'utf8');
    assertAllowedImports(source, absolute);
    assertImportInertSource(source);
    return [path, source];
  });
  assertSingleOwnership(sources);

  const imported = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `await import(${JSON.stringify(pathToFileURL(resolve(INTEGRATIONS, 'src/index.mjs')).href)})`,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'poisoned' },
  });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  assert.equal(imported.stderr, '');
});

test('[req:MOD-20] legacy paths no longer own pure Integrations rules', () => {
  const legacy = new Map([
    ['src/taxonomy.mjs', [
      'SESSION_HOOKS', 'CHANGE_NUDGE_HOOKS', 'CHANGE_GATE_HOOKS',
      'CODEX_MATCHER_EVENTS', 'hookCommand', 'hookCommandLocal',
      'hookCommandLocalLegacy', 'codexHookSpecs', 'codexHookEntry',
    ]],
    ['hooks/obsidian-common.mjs', [
      'salvageTruncatedJson', 'extractHookPrompt', 'isBootstrapPrompt',
      'redactSecrets', 'transcriptsMatch',
    ]],
    ['hooks/token-usage.mjs', [
      'emptyTokenUsage', 'normalizeCodexUsage', 'normalizeClaudeUsage', 'addUsage',
    ]],
  ]);
  for (const [path, forbidden] of legacy) {
    const source = readFileSync(resolve(ROOT, path), 'utf8');
    const declarations = new Set(declarationNames(source));
    for (const name of forbidden) assert.equal(declarations.has(name), false, `${path} still owns ${name}`);
    assert.match(source, /packages\/integrations\/src\//, `${path} must consume the canonical kernel`);
  }
});

test('[req:MOD-20] [req:MOD-21] boundary gates reject cross-adapter and side-effect mutants', () => {
  assert.throws(() => assertAllowedImports("import '../../mcp/src/index.mjs';"));
  assert.throws(() => assertAllowedImports("import '../../../hooks/session-stop.mjs';"));
  assert.throws(() => assertAllowedImports("const req = globalThis['require']; req('../../vault/src/index.mjs');"));
  assert.throws(() => assertImportInertSource("import { readFileSync } from 'node:fs'; export const x = readFileSync(0);"));
  assert.throws(() => assertImportInertSource("export function x() { process.stdout.write('x'); }"));
  assert.throws(() => assertImportInertSource("export function x() { globalThis['process']['stdout'].write('x'); }"));
  assert.throws(() => assertImportInertSource("export function x() { global['process'].env.SECRET; }"));
  assert.throws(() => assertImportInertSource("export const x = Function('return process')();"));

  const root = json(resolve(ROOT, 'package.json'));
  const missingCheck = structuredClone(root);
  missingCheck.scripts.check = missingCheck.scripts.check.replace(
    'node --check packages/integrations/src/transcripts.mjs && ',
    '',
  );
  assert.throws(() => assertCheckCoversIntegrations(missingCheck), /transcripts\.mjs/);

  const valid = new Map([...OWNED_BINDINGS].map(([file, names]) => [
    file,
    names.map((name) => `export const ${name} = 1;`).join('\n'),
  ]));
  assert.doesNotThrow(() => assertSingleOwnership(valid));
  valid.set('src/rogue.mjs', 'export const detectProvider = 1;');
  assert.throws(() => assertSingleOwnership(valid));
});
