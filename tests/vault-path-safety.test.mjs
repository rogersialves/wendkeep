import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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

// A suíte completa inicia vários processos Node em paralelo no Windows; esta espera mede
// somente o startup do probe, não o timeout do lock que o cenário está exercitando.
async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timeout aguardando processo de lock');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function runVaultLockRaceProbe(scenario, timeout = 5000) {
  const child = spawnSync(process.execPath, [
    join(process.cwd(), 'tests', 'fixtures', 'vault-lock-race-probe.mjs'),
    scenario,
  ], { cwd: process.cwd(), encoding: 'utf8', timeout });
  assert.equal(child.status, 0, child.stderr || child.stdout || child.error?.message);
  return JSON.parse(child.stdout);
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

test('[req:OP-7] desaparecimento transitório do lock público aguarda e repete a inspeção', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-vault-lock-transient-'));
  const target = join(vault, '.brain', 'runtime', 'session-state');
  const lock = `${target}.lock`;
  mkdirSync(lock, { recursive: true });
  const moduleUrl = pathToFileURL(join(
    process.cwd(), 'packages', 'vault', 'src', 'vault-path-safety.mjs',
  )).href;
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { resolve } from 'node:path';

    const lock = ${JSON.stringify(lock)};
    const originalRealpath = fs.realpathSync.native;
    const originalWait = Atomics.wait;
    let injected = 0;
    let waits = 0;

    fs.realpathSync.native = function transientRealpath(path, ...args) {
      if (resolve(path) === resolve(lock) && waits === 0) {
        injected += 1;
        const error = new Error('delete-pending transitório simulado');
        error.code = 'ENOENT';
        throw error;
      }
      return originalRealpath.call(this, path, ...args);
    };
    Atomics.wait = (...args) => {
      waits += 1;
      fs.rmSync(lock, { recursive: true, force: true });
      return 'timed-out';
    };
    syncBuiltinESMExports();

    try {
      const { withVaultPathLock } = await import(
        ${JSON.stringify(moduleUrl)} + '?transient-lock=' + Date.now()
      );
      const value = withVaultPathLock(
        ${JSON.stringify(vault)},
        ${JSON.stringify(target)},
        () => 'acquired',
        { timeoutMs: 250, staleMs: 50 },
      );
      process.stdout.write(JSON.stringify({ value, injected, waits }));
    } catch (error) {
      process.stderr.write(JSON.stringify({
        code: error?.code,
        cause: error?.cause?.code,
        message: error?.message,
        injected,
        waits,
      }));
      process.exitCode = 1;
    } finally {
      fs.realpathSync.native = originalRealpath;
      Atomics.wait = originalWait;
      syncBuiltinESMExports();
    }
  `;

  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 5000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.deepEqual(JSON.parse(child.stdout), {
      value: 'acquired', injected: 1, waits: 1,
    });
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OP-7] owner público repete ENOENT transitório mas falha EACCES sem retry', () => {
  assert.deepEqual(runVaultLockRaceProbe('owner-enoent'), {
    value: 'acquired',
    errorCode: null,
    entered: true,
    injected: 1,
    waits: 1,
    lockExists: false,
  });
  assert.deepEqual(runVaultLockRaceProbe('owner-eacces'), {
    value: null,
    errorCode: 'EACCES',
    entered: false,
    injected: 1,
    waits: 0,
    lockExists: true,
  });
});

test('[req:OP-7] retries de topologia compartilham orçamento global e terminam', () => {
  const result = runVaultLockRaceProbe('retry-budget', 2000);
  assert.deepEqual({
    injected: result.injected,
    waits: result.waits,
    errorCode: result.errorCode,
    causeCode: result.causeCode,
  }, {
    injected: 4,
    waits: 3,
    errorCode: 'VAULT_PATH_UNSAFE',
    causeCode: 'ENOENT',
  });
  assert.ok(result.elapsedMs < 500, `retry excedeu o limite: ${result.elapsedMs} ms`);
});

test('[req:OP-7] componente que não estabiliza falha fechado sem consumir o orçamento inteiro', () => {
  const result = runVaultLockRaceProbe('retry-persistent', 2000);
  // Contraponto do teste acima: lá o walk fresco estabiliza a cada rodada e o orçamento é gasto
  // até o fim; aqui ele nunca estabiliza, então a aquisição desiste na primeira reclassificação.
  assert.deepEqual({
    injected: result.injected,
    waits: result.waits,
    errorCode: result.errorCode,
    causeCode: result.causeCode,
  }, {
    injected: 2, waits: 1, errorCode: 'VAULT_PATH_UNSAFE', causeCode: 'ENOENT',
  });
  assert.ok(result.elapsedMs < 500, `retry excedeu o limite: ${result.elapsedMs} ms`);
});

test('[req:OP-7] release repete ENOENT transitório e não deixa lock público residual', () => {
  assert.deepEqual(runVaultLockRaceProbe('release-enoent'), {
    value: 'done', injected: 1, waits: 1, lockExists: false,
  });
});

test('[req:OP-7] liberação concorrente converge sob qualquer errno de plataforma, não só ENOENT', () => {
  // O Windows reporta a remoção concorrente do lock como UNKNOWN, EBADF ou EPERM; o Linux, como
  // ENOENT. Nenhum errno específico pode ser condição necessária para o retry.
  for (const scenario of ['acquire-errno-unknown', 'acquire-errno-ebadf', 'acquire-errno-eperm']) {
    const result = runVaultLockRaceProbe(scenario);
    assert.deepEqual({
      value: result.value,
      errorCode: result.errorCode,
      entered: result.entered,
      injected: result.injected,
      waits: result.waits,
    }, {
      value: 'acquired', errorCode: null, entered: true, injected: 1, waits: 1,
    }, `${scenario} não convergiu: ${result.errorCode} ${result.message}`);
  }
});

test('[req:OP-7] errno transitório não autoriza retry quando o walk fresco vê topologia hostil', (t) => {
  const result = runVaultLockRaceProbe('acquire-errno-hostile');
  if (!result.linkSupported) {
    t.skip('links indisponíveis neste filesystem');
    return;
  }
  // Mesmo errno, mesmo filtro estrutural e mesmo backoff do caso benigno acima — `waits: 1`
  // prova que chegou até a reclassificação. O que diverge é só o estado visto no walk fresco,
  // e a falha preserva o erro original em vez de trocar a superfície de erro do chamador.
  assert.deepEqual({
    value: result.value,
    errorCode: result.errorCode,
    entered: result.entered,
    waits: result.waits,
  }, {
    value: null, errorCode: 'VAULT_PATH_UNSAFE', entered: false, waits: 1,
  }, `topologia hostil não falhou fechado: ${result.message}`);
});

test('[req:OP-7] rename aceita colisão nativa, mas nunca converte EACCES em contenção', () => {
  const collision = runVaultLockRaceProbe('rename-collision');
  const collisionCodes = process.platform === 'win32'
    ? ['EEXIST', 'ENOTEMPTY', 'EPERM']
    : ['EEXIST', 'ENOTEMPTY'];
  assert.ok(
    collisionCodes.includes(collision.collisionCode),
    `colisão nativa inesperada: ${collision.collisionCode}`,
  );
  assert.deepEqual({ ...collision, collisionCode: undefined }, {
    value: 'acquired',
    errorCode: null,
    entered: true,
    injected: 1,
    waits: 1,
    collisionCode: undefined,
    lockExists: false,
    pending: [],
  });

  assert.deepEqual(runVaultLockRaceProbe('rename-eacces'), {
    value: null,
    errorCode: 'EACCES',
    entered: false,
    injected: 1,
    waits: 0,
    collisionCode: null,
    lockExists: true,
    pending: [],
  });

  for (const scenario of [
    'rename-eperm-bad-dest',
    'rename-eexist-bad-path',
    'rename-eexist-bad-syscall',
  ]) {
    const malformed = runVaultLockRaceProbe(scenario);
    assert.deepEqual({
      errorCode: malformed.errorCode,
      entered: malformed.entered,
      injected: malformed.injected,
      waits: malformed.waits,
      collisionCode: malformed.collisionCode,
      lockExists: malformed.lockExists,
      pending: malformed.pending,
    }, {
      errorCode: scenario.includes('eperm') ? 'EPERM' : 'EEXIST',
      entered: false,
      injected: 1,
      waits: 0,
      collisionCode: null,
      lockExists: true,
      pending: [],
    });
  }
});

test('[req:OP-7] falha pós-mkdir de pending permanece fail-closed e limpa o resíduo privado', () => {
  assert.deepEqual(runVaultLockRaceProbe('pending-post-mkdir'), {
    errorCode: 'VAULT_PATH_UNSAFE',
    causeCode: 'ENOENT',
    entered: false,
    injected: 1,
    waits: 0,
    pending: [],
  });
});

test('[req:OP-7] mkdir EEXIST nunca autoriza cleanup de pending preexistente', () => {
  assert.deepEqual(runVaultLockRaceProbe('pending-preexisting'), {
    errorCode: 'EEXIST',
    entered: false,
    injected: 1,
    waits: 0,
    pendingCount: 1,
    pendingSuffixValid: true,
    lockExists: false,
  });
});

test('[req:OP-7] lock publicado entre os dois preflights de rename converge como contenção', () => {
  const result = runVaultLockRaceProbe('rename-preflight');
  assert.deepEqual({
    busy: result.busy,
    errorCode: result.errorCode,
    entered: result.entered,
    injected: result.injected,
    renameCalls: result.renameCalls,
    lockExists: result.lockExists,
    pending: result.pending,
  }, {
    busy: true,
    errorCode: null,
    entered: false,
    injected: 1,
    renameCalls: 0,
    lockExists: true,
    pending: [],
  });
  assert.ok(result.lockChecksAfterPending >= 3);
});

test('[req:OP-7] orçamento de retry é compartilhado entre checkpoints públicos', () => {
  assert.deepEqual(runVaultLockRaceProbe('shared-retry-budget'), {
    publicInjected: 2,
    ownerInjected: 2,
    waits: 3,
    entered: false,
    errorCode: 'VAULT_PATH_UNSAFE',
    causeCode: 'ENOENT',
  });
});

test('[req:OP-7] backoff que cruza o deadline não executa outro checkpoint', () => {
  assert.deepEqual(runVaultLockRaceProbe('retry-deadline'), {
    busy: true,
    entered: false,
    publicRealpaths: 1,
    waits: 1,
  });
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

test('[req:OP-7] lock público dangling persistente falha fechado sem executar callback', (t) => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-vault-lock-dangling-'));
  const outside = mkdtempSync(join(tmpdir(), 'wk-vault-lock-dangling-outside-'));
  const target = join(vault, '.brain', 'runtime', 'session-state');
  const sentinel = join(outside, 'sentinel.txt');
  let entered = false;
  try {
    mkdirSync(join(vault, '.brain', 'runtime'), { recursive: true });
    writeFileSync(sentinel, 'preservado\n');
    try {
      symlinkSync(
        join(outside, 'ausente'),
        `${target}.lock`,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`links indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.throws(
      () => withVaultPathLock(vault, target, () => {
        entered = true;
        return 'não deve entrar';
      }),
      {
        code: 'VAULT_PATH_UNSAFE',
        message: /link simbólico|junction|reparse|dangling/i,
      },
    );
    assert.equal(entered, false);
    assert.equal(readFileSync(sentinel, 'utf8'), 'preservado\n');
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
