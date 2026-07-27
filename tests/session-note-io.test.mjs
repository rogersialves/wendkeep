import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync,
  symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hasSessionFrontmatter, LOCK_BUSY, LOCK_OWNER_FILE, mutateSessionNote, withPathLock, writeFileAtomic,
} from '../hooks/session-note-io.mjs';
import {
  closeSessionNoteFile, controlPath, mutateSessionRegistry, registryPath, upsertSessionRegistry,
} from '../hooks/obsidian-common.mjs';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'wk-note-io-'));
}

test('writeFileAtomic grava o conteúdo e não deixa temporário para trás', () => {
  const root = scratch();
  try {
    const path = join(root, 'nota.md');
    writeFileAtomic(path, '---\ntype: session\n---\n\n# x\n');
    assert.equal(readFileSync(path, 'utf-8'), '---\ntype: session\n---\n\n# x\n');
    assert.deepEqual(readdirSync(root), ['nota.md'], 'nenhum .tmp sobrevive ao rename');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mutateSessionNote grava a saída do mutator e libera o lock', () => {
  const root = scratch();
  try {
    const path = join(root, 'nota.md');
    writeFileSync(path, '---\ntype: session\n---\n\n# x\n');

    const outcome = mutateSessionNote(path, (content) => `${content}extra\n`);

    assert.equal(outcome.written, true);
    assert.equal(outcome.reason, 'ok');
    assert.match(readFileSync(path, 'utf-8'), /extra\n$/);
    assert.equal(existsSync(`${path}.lock`), false, 'lock liberado');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mutateSessionNote: mutator devolvendo null aborta sem tocar no arquivo', () => {
  const root = scratch();
  try {
    const path = join(root, 'nota.md');
    const original = '---\ntype: session\n---\n\n# x\n';
    writeFileSync(path, original);

    const outcome = mutateSessionNote(path, () => null);

    assert.equal(outcome.written, false);
    assert.equal(outcome.reason, 'aborted');
    assert.equal(readFileSync(path, 'utf-8'), original, 'arquivo byte-idêntico');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mutateSessionNote: conteúdo idêntico não reescreve o arquivo', () => {
  const root = scratch();
  try {
    const path = join(root, 'nota.md');
    writeFileSync(path, '---\ntype: session\n---\n\n# x\n');
    const before = statSync(path).mtimeMs;

    const outcome = mutateSessionNote(path, (content) => content);

    assert.equal(outcome.written, false);
    assert.equal(outcome.reason, 'unchanged');
    assert.equal(statSync(path).mtimeMs, before, 'mtime preservado — nenhuma escrita ocorreu');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mutateSessionNote: arquivo inexistente não é criado', () => {
  const root = scratch();
  try {
    const path = join(root, 'ausente.md');
    const outcome = mutateSessionNote(path, () => 'novo');
    assert.equal(outcome.written, false);
    assert.equal(outcome.reason, 'missing');
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mutateSessionNote: lock fresco de outro processo faz o escritor desistir', () => {
  const root = scratch();
  try {
    const path = join(root, 'nota.md');
    const original = '---\ntype: session\n---\n\n# x\n';
    writeFileSync(path, original);
    mkdirSync(`${path}.lock`);

    const outcome = mutateSessionNote(path, () => 'nunca deveria gravar', { timeoutMs: 40 });

    assert.equal(outcome.written, false);
    assert.equal(outcome.reason, 'busy');
    assert.equal(readFileSync(path, 'utf-8'), original, 'desiste em vez de gravar sem lock');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mutateSessionNote: lock morto (stale) é removido e a gravação prossegue', () => {
  const root = scratch();
  try {
    const path = join(root, 'nota.md');
    writeFileSync(path, '---\ntype: session\n---\n\n# x\n');
    const lock = `${path}.lock`;
    mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);

    const outcome = mutateSessionNote(path, (content) => `${content}retomado\n`, { timeoutMs: 40, staleMs: 1000 });

    assert.equal(outcome.written, true);
    assert.match(readFileSync(path, 'utf-8'), /retomado\n$/);
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('withPathLock não reap lock stale cujo PID proprietário continua vivo', () => {
  const root = scratch();
  try {
    const path = join(root, 'nota.md');
    writeFileSync(path, 'x');
    const lock = `${path}.lock`;
    mkdirSync(lock);
    writeFileSync(join(lock, LOCK_OWNER_FILE), `${JSON.stringify({
      v: 1, pid: process.pid, token: 'live-owner-token', created_at: '2000-01-01T00:00:00.000Z',
    })}\n`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(lock, LOCK_OWNER_FILE), old, old);
    utimesSync(lock, old, old);

    const result = withPathLock(path, () => 'não pode entrar', { timeoutMs: 40, staleMs: 1 });

    assert.equal(result, LOCK_BUSY);
    assert.equal(existsSync(lock), true);
    assert.equal(JSON.parse(readFileSync(join(lock, LOCK_OWNER_FILE), 'utf8')).token, 'live-owner-token');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('withPathLock recupera lock stale de PID morto', () => {
  const root = scratch();
  try {
    const path = join(root, 'nota.md');
    writeFileSync(path, 'x');
    const lock = `${path}.lock`;
    mkdirSync(lock);
    writeFileSync(join(lock, LOCK_OWNER_FILE), `${JSON.stringify({
      v: 1, pid: 2_147_483_647, token: 'dead-owner-token', created_at: '2000-01-01T00:00:00.000Z',
    })}\n`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(lock, LOCK_OWNER_FILE), old, old);
    utimesSync(lock, old, old);

    assert.equal(withPathLock(path, () => 'recovered', { timeoutMs: 100, staleMs: 1 }), 'recovered');
    assert.equal(existsSync(lock), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('withPathLock recupera metadata de owner parcial após crash de aquisição', () => {
  const root = scratch();
  try {
    const path = join(root, 'nota.md');
    writeFileSync(path, 'x');
    const lock = `${path}.lock`;
    mkdirSync(lock);
    writeFileSync(join(lock, LOCK_OWNER_FILE), '{"v":1,"pid":');
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(lock, LOCK_OWNER_FILE), old, old);
    utimesSync(lock, old, old);

    assert.equal(withPathLock(path, () => 'recovered-partial', { timeoutMs: 100, staleMs: 1 }), 'recovered-partial');
    assert.equal(existsSync(lock), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('withPathLock libera somente o diretório que ainda carrega seu token', () => {
  const root = scratch();
  try {
    const path = join(root, 'nota.md');
    writeFileSync(path, 'x');
    const lock = `${path}.lock`;
    const result = withPathLock(path, () => {
      rmSync(lock, { recursive: true, force: true });
      mkdirSync(lock);
      writeFileSync(join(lock, LOCK_OWNER_FILE), `${JSON.stringify({
        v: 1, pid: process.pid, token: 'replacement-owner-token', created_at: new Date().toISOString(),
      })}\n`);
      return 'owner-replaced';
    });

    assert.equal(result, 'owner-replaced');
    assert.equal(existsSync(lock), true, 'finally do dono antigo não remove o lock substituto');
    assert.equal(JSON.parse(readFileSync(join(lock, LOCK_OWNER_FILE), 'utf8')).token, 'replacement-owner-token');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mutateSessionRegistry respeita owner vivo e recupera owner morto sem perder CAS', async (t) => {
  await t.test('owner vivo bloqueia a mutação', () => {
    const vault = scratch();
    try {
      const path = registryPath(vault);
      mkdirSync(join(vault, '.brain'), { recursive: true });
      writeFileSync(path, '{"version":2,"sessions":{"one":{"value":1}}}\n');
      const before = readFileSync(path, 'utf8');
      const lock = `${path}.lock`;
      mkdirSync(lock);
      writeFileSync(join(lock, LOCK_OWNER_FILE), `${JSON.stringify({
        v: 1, pid: process.pid, token: 'registry-live-owner', created_at: '2000-01-01T00:00:00.000Z',
      })}\n`);
      const old = new Date(Date.now() - 60_000);
      utimesSync(join(lock, LOCK_OWNER_FILE), old, old);
      utimesSync(lock, old, old);

      assert.throws(() => mutateSessionRegistry(vault, (registry) => {
        registry.sessions.one.value = 2;
      }, { timeoutMs: 40 }), /SESSION_REGISTRY lock indisponível/i);
      assert.equal(readFileSync(path, 'utf8'), before);
      assert.equal(JSON.parse(readFileSync(join(lock, LOCK_OWNER_FILE), 'utf8')).token, 'registry-live-owner');
    } finally { rmSync(vault, { recursive: true, force: true }); }
  });

  await t.test('owner morto é recuperado e a mutação CAS persiste uma vez', () => {
    const vault = scratch();
    try {
      const path = registryPath(vault);
      mkdirSync(join(vault, '.brain'), { recursive: true });
      writeFileSync(path, '{"version":2,"sessions":{"one":{"value":1}}}\n');
      const lock = `${path}.lock`;
      mkdirSync(lock);
      writeFileSync(join(lock, LOCK_OWNER_FILE), `${JSON.stringify({
        v: 1, pid: 2_147_483_647, token: 'registry-dead-owner', created_at: '2000-01-01T00:00:00.000Z',
      })}\n`);
      const old = new Date(Date.now() - 60_000);
      utimesSync(join(lock, LOCK_OWNER_FILE), old, old);
      utimesSync(lock, old, old);

      const result = mutateSessionRegistry(vault, (registry) => {
        assert.equal(registry.sessions.one.value, 1);
        registry.sessions.one.value = 2;
        return 'mutated';
      }, { timeoutMs: 100 });
      assert.equal(result, 'mutated');
      assert.equal(JSON.parse(readFileSync(path, 'utf8')).sessions.one.value, 2);
      assert.equal(existsSync(lock), false);
    } finally { rmSync(vault, { recursive: true, force: true }); }
  });
});

test('[req:OP-7] locks de registry e nota rejeitam junction externa sem tocar no owner', async (t) => {
  for (const surface of ['registry', 'session-note']) {
    await t.test(surface, (subtest) => {
      const vault = scratch();
      const outside = scratch();
      try {
        const target = surface === 'registry'
          ? registryPath(vault)
          : join(vault, '02-Sessões', '2026', '07-JUL', 'DIA 26', 'session.md');
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, surface === 'registry'
          ? '{"version":2,"sessions":{}}\n'
          : '---\ntype: session\n---\n\n# sessão\n');
        const sentinel = join(outside, 'owner-sentinel.json');
        const original = '{"external":true}\n';
        writeFileSync(sentinel, original);
        try {
          symlinkSync(outside, `${target}.lock`, process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error) {
          if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
            subtest.skip(`links indisponíveis neste filesystem: ${error.code}`);
            return;
          }
          throw error;
        }

        if (surface === 'registry') {
          assert.throws(() => mutateSessionRegistry(vault, (registry) => {
            registry.sessions.unsafe = { status: 'active' };
          }), /link simbólico|junction|reparse|Vault/i);
        } else {
          assert.throws(() => mutateSessionNote(target, (content) => `${content}unsafe\n`, {
            vaultBase: vault,
          }), /link simbólico|junction|reparse|Vault/i);
        }
        assert.equal(readFileSync(sentinel, 'utf8'), original);
        assert.deepEqual(readdirSync(outside), ['owner-sentinel.json']);
      } finally {
        rmSync(vault, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });
  }
});

test('[req:OP-7] CURRENT_SESSION rejeita hardlink e junction sem alterar bytes externos', async (t) => {
  for (const topology of ['hardlink', 'junction']) {
    await t.test(topology, (subtest) => {
      const vault = scratch();
      const outside = scratch();
      try {
        mkdirSync(join(vault, '.brain'), { recursive: true });
        writeFileSync(registryPath(vault), '{"version":2,"sessions":{}}\n');
        const control = controlPath(vault);
        const sentinel = join(outside, 'CURRENT_SESSION.md');
        const original = 'status: external\n';
        writeFileSync(sentinel, original);
        try {
          if (topology === 'hardlink') linkSync(sentinel, control);
          else symlinkSync(outside, control, process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error) {
          if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
            subtest.skip(`${topology} indisponível neste filesystem: ${error.code}`);
            return;
          }
          throw error;
        }

        assert.throws(() => upsertSessionRegistry(vault, 'session-1', {
          status: 'active', session_file: '02-Sessões/session.md',
        }), /hardlink|nlink|link simbólico|junction|reparse|Vault/i);
        assert.equal(readFileSync(sentinel, 'utf8'), original);
        assert.deepEqual(readdirSync(outside), ['CURRENT_SESSION.md']);
      } finally {
        rmSync(vault, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });
  }
});

test('[req:OP-7] mutateSessionNote infere o Vault e rejeita junction mesmo sem opção explícita', (t) => {
  const vault = scratch();
  const outside = scratch();
  try {
    mkdirSync(join(vault, '.brain'));
    const month = join(vault, '02-Sessões', '2026', '07-JUL');
    mkdirSync(month, { recursive: true });
    const original = '---\ntype: session\n---\n\n# externa\n';
    writeFileSync(join(outside, 'session.md'), original);
    try {
      symlinkSync(outside, join(month, 'DIA 27'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`junction indisponível neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    assert.throws(() => mutateSessionNote(
      join(month, 'DIA 27', 'session.md'),
      (content) => `${content}não pode\n`,
    ), /link simbólico|junction|reparse|Vault/i);
    assert.equal(readFileSync(join(outside, 'session.md'), 'utf8'), original);
    assert.deepEqual(readdirSync(outside), ['session.md']);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] closeSessionNoteFile rejeita traversal e hardlink sem sobrescrever origem', async (t) => {
  for (const topology of ['traversal', 'hardlink']) {
    await t.test(topology, (subtest) => {
      const root = scratch();
      const vault = join(root, 'vault');
      const outside = join(root, 'outside');
      try {
        mkdirSync(join(vault, '.brain'), { recursive: true });
        mkdirSync(outside);
        const source = join(outside, 'session.md');
        const original = '---\nstatus: active\nended_at:\n---\n\nSessão ainda em andamento.\n';
        writeFileSync(source, original);
        let rel = '../outside/session.md';
        if (topology === 'hardlink') {
          const target = join(vault, '02-Sessões', 'session.md');
          mkdirSync(join(target, '..'), { recursive: true });
          try {
            linkSync(source, target);
          } catch (error) {
            if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
              subtest.skip(`hardlink indisponível neste filesystem: ${error.code}`);
              return;
            }
            throw error;
          }
          rel = '02-Sessões/session.md';
        }
        assert.throws(
          () => closeSessionNoteFile(vault, rel, '2026-07-27T12:00:00.000Z'),
          /escapa logicamente|hardlink|nlink|Vault/i,
        );
        assert.equal(readFileSync(source, 'utf8'), original);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

// Regressão: `rmSync(dir, {recursive:true, force:true})` é NO-OP SILENCIOSO no Windows para
// caminho não-ASCII. Toda nota de sessão vive sob `02-Sessões/`, então o lock ficava preso e
// o segundo escritor desistia — turnos perdidos em silêncio.
test('o lock é liberado em caminho acentuado (02-Sessões)', () => {
  const root = scratch();
  try {
    const dir = join(root, '02-Sessões', '2026', '07-JUL', 'DIA 23');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'nota.md');
    writeFileSync(path, '---\ntype: session\n---\n\n# x\n');

    for (let i = 1; i <= 3; i += 1) {
      const outcome = mutateSessionNote(path, (content) => `${content}linha ${i}\n`, { timeoutMs: 100 });
      assert.equal(outcome.reason, 'ok', `gravação ${i} não pode encontrar o lock preso`);
      assert.equal(existsSync(`${path}.lock`), false, `lock liberado após a gravação ${i}`);
    }
    assert.match(readFileSync(path, 'utf-8'), /linha 1\nlinha 2\nlinha 3\n$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('withPathLock devolve LOCK_BUSY dentro do timeout quando o lock não vem', () => {
  const root = scratch();
  try {
    const path = join(root, 'nota.md');
    writeFileSync(path, 'x');
    mkdirSync(`${path}.lock`);

    const started = Date.now();
    const result = withPathLock(path, () => 'nunca', { timeoutMs: 60 });

    assert.equal(result, LOCK_BUSY);
    assert.ok(Date.now() - started < 5000, 'desiste no deadline em vez de girar');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('withPathLock libera o lock mesmo quando fn lança', () => {
  const root = scratch();
  try {
    const path = join(root, 'nota.md');
    writeFileSync(path, 'x');
    assert.throws(() => withPathLock(path, () => { throw new Error('boom'); }), /boom/);
    assert.equal(existsSync(`${path}.lock`), false, 'finally solta o lock');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Guarda estrutural: um escritor novo que volte ao writeFileSync cru reabre o buraco.
test('todos os hooks que reescrevem a nota de sessão passam por mutateSessionNote', () => {
  const hooks = [
    'token-usage.mjs', 'subagent-usage.mjs', 'session-observability.mjs',
    'session-stop.mjs', 'session-ensure.mjs', 'decision-capture.mjs', 'task-log.mjs',
  ];
  for (const hook of hooks) {
    const src = readFileSync(new URL(`../hooks/${hook}`, import.meta.url), 'utf-8');
    assert.match(src, /mutateSessionNote\b/, `${hook} deve gravar a nota via mutateSessionNote`);
    assert.doesNotMatch(src, /writeFileSync\(\s*sessionPath/, `${hook} não pode gravar a nota com writeFileSync cru`);
  }
});

test('hasSessionFrontmatter distingue nota íntegra de conteúdo truncado', () => {
  assert.equal(hasSessionFrontmatter('---\ntype: session\n---\n\n# x\n'), true);
  assert.equal(hasSessionFrontmatter('type: session\n---\n\n# x\n'), false, 'topo truncado');
  assert.equal(hasSessionFrontmatter('---\ntype: session\n'), false, 'fechamento ausente');
  assert.equal(hasSessionFrontmatter(''), false);
  assert.equal(hasSessionFrontmatter(null), false);
});
