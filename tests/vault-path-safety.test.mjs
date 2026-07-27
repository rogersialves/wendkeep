import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertVaultPathSafe, mkdirVaultPath, VAULT_LOCK_BUSY, withVaultPathLock,
  writeVaultFileAtomic,
} from '../hooks/vault-path-safety.mjs';

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timeout aguardando processo de lock');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('[req:OP-7] boundary aceita sufixo ausente contido e cria/escreve somente dentro do Vault', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-vault-path-safe-'));
  try {
    const dir = join(vault, '.brain', 'runtime', 'flows');
    const target = join(dir, 'state.json');
    assert.equal(assertVaultPathSafe(vault, target, { expectedType: 'file' }).exists, false);
    mkdirVaultPath(vault, dir);
    writeVaultFileAtomic(vault, target, '{"ok":true}\n');
    assert.equal(readFileSync(target, 'utf8'), '{"ok":true}\n');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OP-7] boundary rejeita escape lógico e ancestral que não é diretório', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-vault-path-logical-'));
  const outside = mkdtempSync(join(tmpdir(), 'wk-vault-path-logical-outside-'));
  try {
    writeFileSync(join(vault, 'arquivo'), 'preservado\n');
    assert.throws(
      () => assertVaultPathSafe(vault, join(outside, 'escape.json')),
      /escapa logicamente|Vault/i,
    );
    assert.throws(
      () => assertVaultPathSafe(vault, join(vault, 'arquivo', 'filho.json')),
      /ancestral.*não é diretório/i,
    );
    assert.deepEqual(readdirSync(outside), []);
    assert.equal(readFileSync(join(vault, 'arquivo'), 'utf8'), 'preservado\n');
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] boundary usa lstat e rejeita link dangling mesmo quando existsSync seria falso', (t) => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-vault-path-dangling-'));
  const outside = mkdtempSync(join(tmpdir(), 'wk-vault-path-dangling-outside-'));
  try {
    const dangling = join(vault, 'dangling');
    try {
      symlinkSync(join(outside, 'ausente'), dangling, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`links indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.throws(
      () => mkdirVaultPath(vault, join(dangling, 'filho')),
      /link simbólico|junction|reparse|dangling/i,
    );
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] escrita atômica rejeita target por hardlink e preserva os bytes externos', (t) => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-vault-path-hardlink-'));
  const outside = mkdtempSync(join(tmpdir(), 'wk-vault-path-hardlink-outside-'));
  try {
    const source = join(outside, 'source.json');
    const target = join(vault, 'target.json');
    writeFileSync(source, '{"outside":true}\n');
    try {
      linkSync(source, target);
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
        t.skip(`hardlinks indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.throws(
      () => writeVaultFileAtomic(vault, target, '{"outside":false}\n'),
      /hardlink|nlink/i,
    );
    assert.equal(readFileSync(source, 'utf8'), '{"outside":true}\n');
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] retry de lock transitório nunca aceita junction ou reparse no lock', (t) => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-vault-lock-reparse-'));
  const outside = mkdtempSync(join(tmpdir(), 'wk-vault-lock-reparse-outside-'));
  const target = join(vault, '.brain', 'runtime', 'session-state');
  try {
    mkdirSync(join(vault, '.brain', 'runtime'), { recursive: true });
    try {
      symlinkSync(outside, `${target}.lock`, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`links indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.throws(
      () => withVaultPathLock(vault, target, () => 'não deve entrar'),
      /link simbólico|junction|reparse/i,
    );
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] lock físico nunca reap owner vivo depois de staleMs e libera para o sucessor', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-vault-lock-owner-'));
  const target = join(vault, '.brain', 'runtime', 'session-state');
  const ready = join(vault, 'owner-ready');
  mkdirSync(join(vault, '.brain', 'runtime'), { recursive: true });
  const moduleUrl = pathToFileURL(join(process.cwd(), 'hooks', 'vault-path-safety.mjs')).href;
  const script = `
    import { writeFileSync } from 'node:fs';
    import { withVaultPathLock, VAULT_LOCK_BUSY } from ${JSON.stringify(moduleUrl)};
    const result = withVaultPathLock(${JSON.stringify(vault)}, ${JSON.stringify(target)}, () => {
      writeFileSync(${JSON.stringify(ready)}, 'ready');
      const signal = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(signal, 0, 0, 600);
      return 'owner-done';
    }, { timeoutMs: 1000, staleMs: 50 });
    process.exit(result === VAULT_LOCK_BUSY ? 2 : 0);
  `;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitFor(() => existsSync(ready));
    let entered = false;
    const contender = withVaultPathLock(vault, target, () => {
      entered = true;
      return 'contender-entered';
    }, { timeoutMs: 180, staleMs: 50 });
    assert.equal(contender, VAULT_LOCK_BUSY);
    assert.equal(entered, false, 'owner vivo mantém exclusão mesmo muito além de staleMs');
    const [exitCode] = await once(owner, 'exit');
    assert.equal(exitCode, 0);
    assert.equal(withVaultPathLock(vault, target, () => 'successor', {
      timeoutMs: 500, staleMs: 50,
    }), 'successor');
  } finally {
    if (owner.exitCode === null) owner.kill();
    rmSync(vault, { recursive: true, force: true });
  }
});
