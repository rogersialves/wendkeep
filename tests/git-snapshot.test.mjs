import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureGitSnapshot,
  diffGitSnapshots,
  assertAllowedPathTopology,
  normalizeAllowedPaths,
  pathAllowed,
  runGitDiffCheck,
} from '../hooks/git-snapshot.mjs';
import * as gitSnapshotModule from '../hooks/git-snapshot.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

function repoFixture() {
  const root = mkdtempSync(join(tmpdir(), 'wk-flow-git-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'flow@example.invalid');
  git(root, 'config', 'user.name', 'FLOW Test');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'kept.txt'), 'base\n');
  writeFileSync(join(root, 'src', 'dirty.txt'), 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  return root;
}

test('[req:OP-6] snapshot Git não atribui sujeira preexistente inalterada ao FLOW', () => {
  const root = repoFixture();
  try {
    writeFileSync(join(root, 'src', 'dirty.txt'), 'dirty before FLOW\n');
    const before = captureGitSnapshot(root);
    const unchanged = captureGitSnapshot(root);
    assert.deepEqual(diffGitSnapshots(before, unchanged).changedPaths, []);

    writeFileSync(join(root, 'src', 'dirty.txt'), 'changed during FLOW\n');
    writeFileSync(join(root, 'src', 'new file.txt'), 'new\n');
    const after = captureGitSnapshot(root);
    assert.deepEqual(diffGitSnapshots(before, after).changedPaths, [
      'src/dirty.txt',
      'src/new file.txt',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:OP-6] snapshot detecta mudança de HEAD mesmo com worktree final limpo', () => {
  const root = repoFixture();
  try {
    const before = captureGitSnapshot(root);
    writeFileSync(join(root, 'src', 'kept.txt'), 'committed during FLOW\n');
    git(root, 'add', 'src/kept.txt');
    git(root, 'commit', '-qm', 'during flow');
    const after = captureGitSnapshot(root);
    assert.equal(diffGitSnapshots(before, after).headChanged, true);
    assert.equal(diffGitSnapshots(before, { ...after, root: join(root, 'other-repo') }).rootChanged, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:OP-7] fingerprint detecta troca de commit em submodule já dirty', () => {
  const root = repoFixture();
  const source = mkdtempSync(join(tmpdir(), 'wk-flow-submodule-source-'));
  try {
    git(source, 'init', '-q');
    git(source, 'config', 'user.email', 'flow@example.invalid');
    git(source, 'config', 'user.name', 'FLOW Test');
    writeFileSync(join(source, 'lib.txt'), 'A\n');
    git(source, 'add', '.');
    git(source, 'commit', '-qm', 'A');

    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'deps/lib');
    git(root, 'commit', '-qam', 'add submodule');
    const submodule = join(root, 'deps', 'lib');
    git(submodule, 'config', 'user.email', 'flow@example.invalid');
    git(submodule, 'config', 'user.name', 'FLOW Test');
    writeFileSync(join(submodule, 'lib.txt'), 'B\n');
    git(submodule, 'add', '.');
    git(submodule, 'commit', '-qm', 'B');
    writeFileSync(join(submodule, 'lib.txt'), 'B dirty\n');
    const before = captureGitSnapshot(root);

    git(submodule, 'add', '.');
    git(submodule, 'commit', '-qm', 'C');
    writeFileSync(join(submodule, 'lib.txt'), 'C dirty\n');
    const after = captureGitSnapshot(root);

    assert.deepEqual(diffGitSnapshots(before, after).changedPaths, ['deps/lib', 'deps/lib/lib.txt']);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

test('[req:OP-7] snapshot vigia metadata de todo gitlink mesmo quando o submodule está limpo', (t) => {
  const root = repoFixture();
  const source = mkdtempSync(join(tmpdir(), 'wk-flow-submodule-source-'));
  try {
    git(source, 'init', '-q');
    git(source, 'config', 'user.email', 'flow@example.invalid');
    git(source, 'config', 'user.name', 'FLOW Test');
    writeFileSync(join(source, 'lib.txt'), 'A\n');
    git(source, 'add', '.');
    git(source, 'commit', '-qm', 'A');
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'plugins/ext');
    git(root, 'commit', '-qam', 'add clean submodule');

    const before = captureGitSnapshot(root);
    assert.deepEqual(before.dirty_paths, []);
    git(join(root, 'plugins', 'ext'), 'config', 'flow.adversarial', 'true');
    const after = captureGitSnapshot(root);
    const drift = diffGitSnapshots(before, after);

    assert.equal(drift.metadataChanged, true);
    assert.deepEqual(drift.changedPaths, ['plugins/ext']);

    const marker = join(root, 'plugins', 'ext', '.git');
    rmSync(marker, { recursive: true, force: true });
    try {
      symlinkSync(
        join(root, 'missing-gitdir'),
        marker,
        process.platform === 'win32' ? 'junction' : 'file',
      );
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.diagnostic(`dangling .git link indisponível: ${error.code}`);
        return;
      }
      throw error;
    }
    const unsafe = captureGitSnapshot(root);
    assert.ok(unsafe.unsafe_worktree_paths.includes('plugins/ext/.git'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

test('[req:OP-6] allowlist é relativa ao projeto e rejeita escape/absoluto', () => {
  const root = repoFixture();
  try {
    const project = join(root, 'packages', 'app');
    mkdirSync(join(project, 'src'), { recursive: true });
    assert.deepEqual(normalizeAllowedPaths(project, root, ['src/a.js', 'README.md']), [
      'packages/app/README.md',
      'packages/app/src/a.js',
    ]);
    assert.throws(() => normalizeAllowedPaths(project, root, ['../outside.js']), /fora do projeto/i);
    assert.throws(() => normalizeAllowedPaths(project, root, [root]), /relativo/i);
    assert.equal(pathAllowed('packages/app/src/a.js', ['packages/app/src/a.js']), true);
    assert.equal(pathAllowed('packages/app/src/b.js', ['packages/app/src/a.js']), false);
    assert.equal(pathAllowed('PACKAGES/App/SRC/a.js', ['packages/app/src/**']), process.platform === 'win32');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:OP-7] allowlist rejeita metadados Git na raiz e em projetos aninhados', () => {
  const root = repoFixture();
  try {
    const nested = join(root, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    assert.throws(() => normalizeAllowedPaths(root, root, ['.git/config']), /\.git|metadados Git/i);
    assert.throws(() => normalizeAllowedPaths(root, root, ['.git/hooks/**']), /\.git|metadados Git/i);
    assert.throws(() => normalizeAllowedPaths(nested, root, ['.git/config']), /\.git|metadados Git/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:OP-7] snapshot detecta config Git invisível ao status do worktree', () => {
  const root = repoFixture();
  try {
    const before = captureGitSnapshot(root);
    git(root, 'config', 'flow.adversarial', 'true');
    const after = captureGitSnapshot(root);
    const delta = diffGitSnapshots(before, after);
    assert.deepEqual(delta.changedPaths, []);
    assert.equal(delta.metadataChanged, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:OP-7] snapshot detecta assume-unchanged e skip-worktree que ocultam paths', () => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const root = repoFixture();
    try {
      const before = captureGitSnapshot(root);
      git(root, 'update-index', flag, 'src/kept.txt');
      const after = captureGitSnapshot(root);
      assert.equal(diffGitSnapshots(before, after).metadataChanged, true, flag);
      assert.deepEqual(after.hidden_index_paths, ['src/kept.txt'], flag);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('[req:OP-7] snapshot inclui config efetiva proveniente de include externo', () => {
  const root = repoFixture();
  const external = mkdtempSync(join(tmpdir(), 'wk-flow-git-include-'));
  try {
    const included = join(external, 'included.conf');
    writeFileSync(included, '[flow]\n\tmode = before\n');
    git(root, 'config', '--add', 'include.path', included);
    const before = captureGitSnapshot(root);
    writeFileSync(included, '[flow]\n\tmode = after\n');
    const after = captureGitSnapshot(root);
    assert.equal(diffGitSnapshots(before, after).metadataChanged, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test('[req:OP-7] snapshot marca hooksPath por link ou excludes por hardlink como metadata insegura', (t) => {
  const root = repoFixture();
  const external = mkdtempSync(join(tmpdir(), 'wk-flow-git-alias-'));
  try {
    mkdirSync(join(external, 'hooks'), { recursive: true });
    writeFileSync(join(external, 'hooks', 'pre-commit'), 'echo external\n');
    try {
      symlinkSync(join(external, 'hooks'), join(root, '.hooks-link'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`links indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }
    const excludes = join(external, 'exclude');
    writeFileSync(excludes, '*.secret\n');
    linkSync(excludes, join(root, '.exclude-hardlink'));
    git(root, 'config', 'core.hooksPath', '.hooks-link');
    git(root, 'config', 'core.excludesFile', '.exclude-hardlink');

    const snapshot = captureGitSnapshot(root);
    assert.match(snapshot.unsafe_git_metadata_paths.join('\n'), /hooks|configured-excludes/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test('[req:OP-7] allowlist rejeita link simbólico ou junction que escapa da raiz física', () => {
  const root = repoFixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-outside-'));
  try {
    symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(
      () => assertAllowedPathTopology(root, ['linked/**']),
      /link simbólico|reparse|raiz física/i,
    );
    assert.doesNotThrow(() => assertAllowedPathTopology(root, ['src/**', 'future/file.txt']));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] topologia rejeita descendente redirecionado mesmo antes de ele aparecer no diff', (t) => {
  const root = repoFixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-outside-'));
  try {
    try {
      symlinkSync(outside, join(root, 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`links indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.throws(
      () => assertAllowedPathTopology(root, ['src/**']),
      /link simbólico|reparse|raiz física/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] topologia rejeita arquivo alterado com hardlink externo', (t) => {
  const root = repoFixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-outside-'));
  const outsideFile = join(outside, 'shared.txt');
  try {
    writeFileSync(outsideFile, 'shared\n');
    try {
      linkSync(outsideFile, join(root, 'src', 'shared.txt'));
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
        t.skip(`hardlinks indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.throws(
      () => assertAllowedPathTopology(root, ['src/**'], ['src/shared.txt']),
      /hardlink/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] scan físico protegido é determinístico, limitado e nunca segue alias externo', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wk-flow-physical-scan-'));
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-physical-outside-'));
  try {
    assert.equal(typeof gitSnapshotModule.capturePhysicalTreeSnapshot, 'function');
    mkdirSync(join(root, 'src'), { recursive: true });
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(join(outside, `external-${String(index).padStart(2, '0')}.txt`), 'outside\n');
    }
    try {
      symlinkSync(outside, join(root, 'src', 'auth'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`links indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    const options = {
      isProtectedPath: (path) => path === 'src/auth' || path.startsWith('src/auth/'),
      maxDepth: 8,
      maxEntries: 4,
    };
    const first = gitSnapshotModule.capturePhysicalTreeSnapshot(root, options);
    const second = gitSnapshotModule.capturePhysicalTreeSnapshot(root, options);

    assert.deepEqual(second, first);
    assert.match(first.unsafe_paths.join('\n'), /src\/auth.*link simbólico|src\/auth.*reparse/i);
    assert.deepEqual(Object.keys(first.fingerprints), ['src/auth']);
    assert.ok(first.entries_scanned <= 2, 'conteúdo do alias externo não deve ser percorrido');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] scan físico protegido falha fechado nos caps de profundidade e entradas', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-flow-physical-caps-'));
  try {
    mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true });
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(join(root, `entry-${index}.txt`), 'x\n');
    }
    const scan = gitSnapshotModule.capturePhysicalTreeSnapshot;
    assert.equal(typeof scan, 'function');
    assert.throws(
      () => scan(root, { isProtectedPath: () => false, maxDepth: 1, maxEntries: 100 }),
      (error) => error?.code === 'FLOW_PHYSICAL_SCAN_LIMIT' && /profundidade|depth/i.test(error.message),
    );
    assert.throws(
      () => scan(root, { isProtectedPath: () => false, maxDepth: 20, maxEntries: 2 }),
      (error) => error?.code === 'FLOW_PHYSICAL_SCAN_LIMIT' && /entradas|entries/i.test(error.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:OP-7] scan físico exclui Vault, Git e caches locais antes de consumir o cap', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-flow-physical-excludes-'));
  try {
    for (const base of ['.git', '.vault', 'node_modules']) {
      const dir = join(root, base, 'auth');
      mkdirSync(dir, { recursive: true });
      for (let index = 0; index < 10; index += 1) writeFileSync(join(dir, `${index}.txt`), 'ignored\n');
    }
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'app.mjs'), 'export {};\n');

    const snapshot = gitSnapshotModule.capturePhysicalTreeSnapshot(root, {
      isProtectedPath: (path) => /(^|\/)auth(?:\/|$)/.test(path),
      excludedDirectoryNames: ['.git', 'node_modules'],
      excludedPaths: ['.vault'],
      maxDepth: 8,
      maxEntries: 4,
    });
    assert.deepEqual(snapshot.unsafe_paths, []);
    assert.deepEqual(snapshot.fingerprints, {});
    assert.equal(snapshot.entries_scanned, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:OP-7] scan físico rejeita hardlink em descendente de diretório protegido', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wk-flow-physical-hardlink-'));
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-physical-hardlink-outside-'));
  try {
    const external = join(outside, 'shared.bin');
    writeFileSync(external, 'shared\n');
    mkdirSync(join(root, 'src', 'auth'), { recursive: true });
    try {
      linkSync(external, join(root, 'src', 'auth', 'session.bin'));
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
        t.skip(`hardlinks indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    const snapshot = gitSnapshotModule.capturePhysicalTreeSnapshot(root, {
      isProtectedPath: (path) => path === 'src/auth',
      maxDepth: 8,
      maxEntries: 20,
    });
    assert.deepEqual(Object.keys(snapshot.fingerprints), ['src/auth', 'src/auth/session.bin']);
    assert.match(snapshot.unsafe_paths.join('\n'), /src\/auth\/session\.bin.*hardlink/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] git diff check reprova whitespace inválido', () => {
  const root = repoFixture();
  try {
    writeFileSync(join(root, 'src', 'kept.txt'), 'trailing   \n');
    const result = runGitDiffCheck(root);
    assert.equal(result.ok, false);
    assert.match(result.output, /whitespace/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:OP-7] git diff check também cobre arquivo novo ainda não rastreado', () => {
  const root = repoFixture();
  try {
    writeFileSync(join(root, 'src', 'new.txt'), 'trailing   \n');
    const result = runGitDiffCheck(root, { paths: ['src/new.txt'] });
    assert.equal(result.ok, false);
    assert.match(result.output, /whitespace/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
