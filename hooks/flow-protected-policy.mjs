// Canonical FLOW protection policy. Classification and ignored-file discovery are
// compiled from the same rules so a protected surface cannot silently disappear
// merely because Git excludes it from the ordinary worktree status.
import { pathAllowed } from './git-snapshot.mjs';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const NAME_TOKENS = [
  'api', 'apis', 'route', 'routes', 'endpoint', 'endpoints',
  'auth', 'authentication', 'authorization', 'authn', 'authz', 'oauth', 'oidc', 'sso',
  'security', 'permission', 'permissions', 'role', 'roles', 'rbac', 'abac', 'acl', 'rls',
  'access', 'policy', 'policies', 'secret', 'secrets', 'credential', 'credentials',
  'csrf', 'cors', 'webauthn', 'passkey', 'passkeys', 'login', 'logout', 'signin', 'signout',
  'signup', 'register', 'password', 'passwd', 'jwt', 'token', 'tokens', 'crypto', 'encryption',
  'decryption', 'keyring', 'keystore', 'release', 'publish', 'publishing', 'deploy', 'deployment',
];
const NAME_TOKEN_SET = new Set(NAME_TOKENS);
const NAME_DISCOVERY_STEMS = [
  'api', 'route', 'endpoint', 'auth', 'oidc', 'sso', 'security', 'permission', 'role',
  'rbac', 'abac', 'acl', 'rls', 'access', 'policy', 'secret', 'credential', 'csrf', 'cors',
  'webauthn', 'passkey', 'login', 'logout', 'sign', 'register', 'passw', 'jwt', 'token',
  'crypt', 'key', 'release', 'publish', 'deploy',
];

export const FLOW_PROTECTED_SCAN_POLICY = Object.freeze({
  schemaVersion: 1,
  maxDepth: 64,
  maxEntries: 100_000,
  excludedDirectoryNames: Object.freeze([
    '.git', '.worktrees', 'node_modules', '.pnpm-store', '.yarn', '.venv', 'venv',
    '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox',
  ]),
});

function nameTokens(path) {
  return String(path || '').replaceAll('\\', '/').split('/').flatMap((segment) => segment
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase()));
}

const discoverNames = (stems) => stems.flatMap((stem) => [`**/*${stem}*`, `**/*${stem}*/**`]);

function rule(id, test, discoverGlobs, exemplars, topologyRoots = []) {
  return Object.freeze({
    id,
    test,
    discoverGlobs: Object.freeze(discoverGlobs),
    exemplars: Object.freeze(exemplars),
    topologyRoots: Object.freeze(topologyRoots),
  });
}

export const FLOW_PROTECTED_RULES = Object.freeze([
  rule('automation', (path) => /(^|\/)\.github(?:\/|$)/i.test(path)
    || /(^|\/)\.(?:circleci|buildkite|teamcity)(?:\/|$)/i.test(path)
    || /(^|\/)(?:\.gitlab-ci\.ya?ml|\.travis\.ya?ml|appveyor\.ya?ml|cloudbuild\.ya?ml|buildspec\.ya?ml|azure-pipelines\.ya?ml|bitrise\.ya?ml|jenkinsfile|dockerfile(?:\.[^/]+)?|(?:docker-)?compose\.ya?ml)$/i.test(path), [
    '**/.github*', '**/.github*/**', '**/.circleci*', '**/.circleci*/**',
    '**/.buildkite*', '**/.buildkite*/**', '**/.teamcity*', '**/.teamcity*/**', '**/*ci.y*ml',
    '**/*build*', '**/*pipeline*', '**/Jenkinsfile', '**/Dockerfile*', '**/*compose*.y*ml',
  ], ['.github/workflows/ci.yml', 'packages/app/buildspec.yaml'], [
    '.github', '.circleci', '.buildkite', '.teamcity',
  ]),

  rule('contracts-and-migrations', (path) => /(^|\/)migrations?(?:\/|\.|$)/i.test(path)
    || /(^|\/)(?:db\/migrate|alembic\/versions|flyway\/sql)(?:\/|$)/i.test(path)
    || /(^|\/)(?:schema|schemas|openapi|api-contracts?)(?:\/|\.|$)/i.test(path)
    || /(^|\/)[^/]+\.(?:proto|graphql|gql)$/i.test(path)
    || /(^|\/)(?:prisma|drizzle)(?:\/|$)/i.test(path), [
    ...discoverNames(['migrat', 'schema', 'openapi', 'api-contract', 'prisma', 'drizzle', 'alembic', 'flyway']),
    '**/*.proto', '**/*.graphql', '**/*.gql',
  ], ['db/migrate/001.sql', 'schema.sql', 'contracts/service.proto'], [
    'migration', 'migrations', 'db/migrate', 'alembic/versions', 'flyway/sql',
    'schema', 'schemas', 'openapi', 'api-contract', 'api-contracts', 'prisma', 'drizzle',
  ]),

  rule('dependencies', (path) => /(^|\/)(?:deps?|dependencies|vendor)(?:\/|$)/i.test(path)
    || /(^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|\.yarnrc(?:\.[^/]+)?|\.npmrc|\.pypirc|bun\.lockb?|deno\.jsonc?|deno\.lock|pyproject\.toml|poetry\.lock|uv\.lock|requirements(?:-[^/]+)?\.txt|cargo\.toml|cargo\.lock|go\.mod|go\.sum|composer\.json|composer\.lock|gemfile|gemfile\.lock|pom\.xml|build\.gradle(?:\.kts)?)$/i.test(path), [
    '**/dep*', '**/dep*/**', '**/vendor*', '**/vendor*/**', '**/package*', '**/pnpm*', '**/yarn*', '**/.npmrc',
    '**/.yarnrc*', '**/.pypirc', '**/*lock*', '**/deno*', '**/pyproject.toml', '**/poetry*',
    '**/requirements*', '**/Cargo*', '**/go.*', '**/composer*', '**/Gemfile*', '**/pom.xml',
    '**/build.gradle*',
  ], ['package.json', 'packages/app/pnpm-lock.yaml', 'vendor/library.js'], [
    'dep', 'deps', 'dependencies', 'vendor',
  ]),

  rule('release', (path) => /(^|\/)(?:scripts?\/release(?:\.[^/]+)?|\.changeset(?:\/|$)|changesets?(?:\/|$))/i.test(path)
    || /(^|\/)(?:changelog|release-notes)(?:\.[^/]+)?$/i.test(path)
    || /(^|\/)(?:\.releaserc(?:\.[^/]+)?|release-please-config\.json)$/i.test(path), [
    '**/*release*', '**/*release*/**', '**/.changeset*', '**/.changeset*/**',
    '**/changesets*', '**/changesets*/**', '**/CHANGELOG*', '**/.releaserc*',
  ], ['CHANGELOG.md', '.changeset/release.md'], ['.changeset', 'changesets']),

  rule('governance', (path) => /(^|\/)(?:07-specs|08-mudan[cç]as|08-changes)(?:\/|$)/i.test(path)
    || /(^|\/)(?:agents|claude)\.md$/i.test(path), [
    '**/07-Specs*', '**/07-Specs*/**', '**/08-Mudanças*', '**/08-Mudanças*/**',
    '**/08-Changes*', '**/08-Changes*/**', '**/AGENTS.md', '**/CLAUDE.md',
  ], ['AGENTS.md', '07-Specs/api.md'], ['07-Specs', '08-Mudanças', '08-Changes']),

  rule('git-worktree-metadata', (path) => /(^|\/)(?:\.gitignore|\.gitmodules|\.gitattributes)$/i.test(path), [
    '**/.gitignore', '**/.gitmodules', '**/.gitattributes',
  ], ['.gitmodules', 'packages/app/.gitignore']),

  rule('wendkeep-control-plane', (path) => /(^|\/)\.mcp\.json$/i.test(path)
    || /(^|\/)\.(?:claude|codex)(?:\/|$)/i.test(path)
    || /(^|\/)\.agent\/hooks(?:\/|$)/i.test(path)
    || /(^|\/)\.agents\/skills(?:\/|$)/i.test(path)
    || /(^|\/)(?:wendkeep\.sensors\.json|\.wendkeep\.json)$/i.test(path)
    || /(^|\/)\.(?:agents|claude)\/skills\/wk-[^/]+(?:\/|$)/i.test(path)
    || /(^|\/)hooks(?:\/|$)/i.test(path)
    || /(^|\/)src\/(?:flow|change|verify|sensors|operating-profile|profile|project-vault|memory|init|sync|sync-defs|skills-seed|spec|validate-memory|validate-core)\.mjs$/i.test(path)
    || /(^|\/)bin\/wendkeep\.mjs$/i.test(path), [
    '**/.mcp.json', '**/.claude*', '**/.claude*/**', '**/.codex*', '**/.codex*/**',
    '**/.agent*', '**/.agent*/**', '**/.agents*', '**/.agents*/**',
    '**/.wendkeep.json', '**/wendkeep.sensors.json', '**/hooks/*', '**/src/*', '**/bin/*',
  ], ['.wendkeep.json', 'hooks/flow-core.mjs', '.codex/hooks.json', 'src/memory.mjs'], [
    '.claude', '.codex', '.agent/hooks', '.agents/skills', 'hooks',
  ]),

  rule('environment', (path) => /(^|\/)\.env(?:\.[^/]+)?$/i.test(path), [
    '**/.env', '**/.env.*',
  ], ['.env.production']),

  rule('semantic-security-and-api-names', (path) => nameTokens(path)
    .some((token) => NAME_TOKEN_SET.has(token)), discoverNames(NAME_DISCOVERY_STEMS),
  ['src/csrf.ts', 'src/passkeyService.ts', 'src/authn/policy.ts', 'src/APIClient.ts']),
]);

function asIgnoredPathspec(glob) {
  const value = String(glob || '').trim();
  if (!value) return '';
  if (value.startsWith(':(glob,icase)')) return value;
  if (value.startsWith(':(glob)')) return value.replace(':(glob)', ':(glob,icase)');
  return `:(glob,icase)${value}`;
}

export function isProtectedFlowPath(path, protectedRoots = []) {
  const normalized = String(path || '').replaceAll('\\', '/');
  return FLOW_PROTECTED_RULES.some((entry) => entry.test(normalized))
    || pathAllowed(normalized, protectedRoots);
}

export function flowProtectedIgnoredPathspecs(protectedRoots = []) {
  const customGlobs = (protectedRoots || []).flatMap((root) => {
    const normalized = String(root || '').replaceAll('\\', '/');
    const leaf = normalized.replace(/\/\*\*$/, '');
    return leaf && leaf !== normalized ? [leaf, normalized] : [normalized];
  });
  return [...new Set([
    ...FLOW_PROTECTED_RULES.flatMap((entry) => entry.discoverGlobs),
    ...customGlobs,
  ].map(asIgnoredPathspec).filter(Boolean))].sort();
}

export function flowProtectedPolicyExamples() {
  return FLOW_PROTECTED_RULES.flatMap((entry) => entry.exemplars.map((path) => ({ rule: entry.id, path })));
}

export function flowProtectedTopologyRoots(projectRoot, gitRoot) {
  const physicalProject = realpathSync.native(resolve(projectRoot));
  const physicalGitRoot = realpathSync.native(resolve(gitRoot));
  const rel = relative(physicalGitRoot, physicalProject);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TypeError('projectRoot fora da raiz Git ao compilar topologia protegida');
  }
  const prefix = rel ? rel.replaceAll('\\', '/') : '';
  const anchors = FLOW_PROTECTED_RULES.flatMap((entry) => entry.topologyRoots);
  return [...new Set(anchors.flatMap((anchor) => [
    anchor,
    prefix ? `${prefix}/${anchor}` : anchor,
  ]))].sort();
}

function pathInside(root, candidate) {
  const rel = relative(root, candidate);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return '';
  return rel.replaceAll('\\', '/');
}

export function flowProtectedPhysicalScanOptions(projectRoot, gitRoot, {
  protectedRoots = [],
  vaultBase = '',
} = {}) {
  const physicalProject = realpathSync.native(resolve(projectRoot));
  const physicalGitRoot = realpathSync.native(resolve(gitRoot));
  const fromGit = relative(physicalGitRoot, physicalProject);
  if (fromGit === '..' || fromGit.startsWith(`..${sep}`) || isAbsolute(fromGit)) {
    throw new TypeError('projectRoot fora da raiz Git ao compilar scan físico protegido');
  }
  const pathPrefix = fromGit ? fromGit.replaceAll('\\', '/') : '';
  const physicalVault = vaultBase ? realpathSync.native(resolve(vaultBase)) : '';
  const vaultRel = physicalVault ? pathInside(physicalProject, physicalVault) : '';
  const excludedPaths = vaultRel ? [vaultRel] : [];
  const excludedGitRoots = excludedPaths.map((path) => pathPrefix ? `${pathPrefix}/${path}` : path);
  const excludedNames = new Set(FLOW_PROTECTED_SCAN_POLICY.excludedDirectoryNames
    .map((name) => process.platform === 'win32' ? name.toLowerCase() : name));
  const normalizeCase = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  const isExcludedPath = (path) => {
    const normalized = normalizeCase(String(path || '').replaceAll('\\', '/'));
    if (normalized.split('/').some((segment) => excludedNames.has(segment))) return true;
    return excludedGitRoots.some((root) => {
      const candidate = normalizeCase(root);
      return normalized === candidate || normalized.startsWith(`${candidate}/`);
    });
  };
  return {
    pathPrefix,
    protectedRoots: [...protectedRoots],
    excludedDirectoryNames: [...FLOW_PROTECTED_SCAN_POLICY.excludedDirectoryNames],
    excludedPaths,
    maxDepth: FLOW_PROTECTED_SCAN_POLICY.maxDepth,
    maxEntries: FLOW_PROTECTED_SCAN_POLICY.maxEntries,
    isProtectedPath: (path) => isProtectedFlowPath(path, protectedRoots),
    isExcludedPath,
  };
}
