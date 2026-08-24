import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectArtifactAtCommit,
  evaluateReleaseProvenance,
  packIntegrityInIsolatedCopy,
  parsePackIntegrity,
  packageHasSelfDependency,
} from '../src/release-provenance.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function provenance(overrides = {}) {
  return {
    name: 'wendkeep',
    version: '0.72.1',
    headCommit: 'a'.repeat(40),
    tagCommit: 'a'.repeat(40),
    publishedIntegrity: 'sha512-published',
    localIntegrity: 'sha512-published',
    requirePublished: true,
    ...overrides,
  };
}

test('[req:REL-PROV-1] checkout de desenvolvimento não depende do próprio pacote publicado', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(packageHasSelfDependency(pkg), false);
  assert.equal(Object.hasOwn(lock.packages, 'node_modules/wendkeep'), false);
});
test('[req:REL-PROV-2] hooks versionados do próprio repositório executam o working tree', () => {
  for (const relative of ['.claude/settings.json', '.codex/hooks.json']) {
    const config = JSON.parse(readFileSync(join(ROOT, relative), 'utf8'));
    const commands = Object.values(config.hooks).flatMap((groups) => groups)
      .flatMap((group) => group.hooks || [])
      .filter((entry) => String(entry.command || '').includes('wendkeep'));
    assert.ok(commands.length > 0, `${relative} precisa conter hooks do WendKeep`);
    for (const entry of commands) {
      assert.match(entry.command, /^node \.\/bin\/wendkeep\.mjs hook [a-z-]+$/);
      assert.equal(entry.args, undefined);
      assert.doesNotMatch(entry.command, /node_modules|\bnpx\b/);
    }
  }
});

test('[req:REL-PROV-3] pacote consumidor usa npx sem instalação implícita', async () => {
  const { hookCommand, codexHookEntry } = await import('../packages/integrations/src/host-hooks.mjs');
  assert.equal(hookCommand('session-stop'), 'npx --no-install wendkeep hook session-stop');
  assert.equal(
    codexHookEntry({ name: 'session-stop', timeout: 60 }).command,
    'npx --no-install wendkeep hook session-stop',
  );
});

test('[req:REL-PROV-4] tag em outro commit bloqueia a mesma versão', () => {
  const result = evaluateReleaseProvenance(provenance({ tagCommit: 'b'.repeat(40) }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'tag_commit_mismatch');
});

test('[req:REL-PROV-5] tarball publicado divergente do SHA testado é rejeitado', () => {
  const result = evaluateReleaseProvenance(provenance({ localIntegrity: 'sha512-local' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'tarball_integrity_mismatch');
});

test('[req:REL-PROV-5] tag, commit e integridade iguais produzem receipt verificável', () => {
  assert.deepEqual(evaluateReleaseProvenance(provenance()), {
    ok: true,
    code: 'verified',
    name: 'wendkeep',
    version: '0.72.1',
    tag: 'v0.72.1',
    commit: 'a'.repeat(40),
    integrity: 'sha512-published',
  });
});

test('[req:REL-PROV-5] verificação pós-publicação falha se o registry ainda não comprova o pacote', () => {
  const result = evaluateReleaseProvenance(provenance({ publishedIntegrity: '' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'published_artifact_missing');
});

test('[req:REL-PROV-6] parser tolera logs de lifecycle antes do JSON do npm pack', () => {
  assert.equal(
    parsePackIntegrity('prepack log\n[{"integrity":"sha512-packed"}]\npostpack log'),
    'sha512-packed',
  );
});

test('[req:REL-PROV-6] integridade executa lifecycle scripts numa cópia e preserva a origem', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-provenance-lifecycle-'));
  try {
    writeFileSync(join(root, 'README.md'), 'working tree\n');
    writeFileSync(join(root, 'pack.mjs'), `
import { writeFileSync } from 'node:fs';
writeFileSync('README.md', process.argv[2] === 'pre' ? 'published artifact\\n' : 'working tree\\n');
`);
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'wk-provenance-fixture',
      version: '1.0.0',
      files: ['README.md'],
      scripts: { prepack: 'node pack.mjs pre', postpack: 'node pack.mjs post' },
    }, null, 2));
    writeFileSync(join(root, '.wendkeep.json'), '{"vault":".private-vault"}\n');
    mkdirSync(join(root, '.private-vault'));
    writeFileSync(join(root, '.private-vault', 'secret.txt'), 'must not be copied\n');

    const isolated = packIntegrityInIsolatedCopy(root, {
      execute(command, args, options) {
        assert.match(command, /^npm(?:\.cmd)?$/);
        assert.deepEqual(args, ['pack', '--dry-run', '--json']);
        assert.notEqual(options.cwd, root, 'empacotamento acontece na cópia');
        assert.equal(existsSync(join(options.cwd, '.private-vault')), false, 'vault vinculado não entra na cópia');
        const pkg = JSON.parse(readFileSync(join(options.cwd, 'package.json'), 'utf8'));
        assert.match(pkg.scripts.prepack, /pack\.mjs pre/);
        writeFileSync(join(options.cwd, 'README.md'), 'published artifact\n');
        return '[{"integrity":"sha512-lifecycle"}]';
      },
    });
    assert.equal(isolated, 'sha512-lifecycle');
    assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), 'working tree\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:PROV-6] wrapper público avalia a cadeia externa completa pelo gate compartilhado', () => {
  const commit = 'a'.repeat(40);
  const chain = {
    commit: { sha: commit },
    tag: { name: 'v1.2.3', commit },
    package: { name: 'fixture', version: '1.2.3', commit },
    artifact: { integrity: 'sha512-target', commit },
    npm: { name: 'fixture', version: '1.2.3', integrity: 'sha512-target', commit, repository: 'example/project' },
    ci: { conclusion: 'success', commit, repository: 'example/project' },
    release: {
      tag: 'v1.2.3', version: '1.2.3', commit, repository: 'example/project', status: 'published',
    },
  };
  const context = {
    target_commit: commit,
    package_name: 'fixture',
    package_version: '1.2.3',
    repository: 'example/project',
    tag: 'v1.2.3',
  };
  assert.equal(evaluateReleaseProvenance({ chain, context }).state, 'verified');
  assert.equal(
    evaluateReleaseProvenance({ chain }).state,
    'unproven',
    'a chain cannot derive its own trusted context',
  );
  assert.equal(evaluateReleaseProvenance({
    chain: { ...chain, ci: { ...chain.ci, commit: 'b'.repeat(40) } }, context,
  }).state, 'conflict');
});

test('[req:PROV-6] tarball é calculado de clone detached do target, não do checkout incidental', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-provenance-target-'));
  try {
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'release@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: root });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.2.3' }));
    execFileSync('git', ['add', 'package.json'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'target'], { cwd: root });
    const targetCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '9.9.9' }));
    execFileSync('git', ['add', 'package.json'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'incidental'], { cwd: root });

    const result = collectArtifactAtCommit({
      repoRoot: root,
      targetCommit,
      execute(command, args, options = {}) {
        if (/^npm(?:\.cmd)?$/.test(command)) {
          const pkg = JSON.parse(readFileSync(join(options.cwd, 'package.json'), 'utf8'));
          assert.equal(pkg.version, '1.2.3');
          return '[{"integrity":"sha512-target"}]';
        }
        return execFileSync(command, args, options);
      },
    });
    assert.deepEqual(result, {
      ok: true,
      state: 'verified',
      commit: targetCommit,
      integrity: 'sha512-target',
      reasonCodes: [],
    });
    assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '9.9.9');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
