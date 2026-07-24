// Gravação da nota de sessão: atômica e serializada.
//
// O hook `subagent-stop` dispara uma vez por subagent, então vários processos fazem
// read-modify-write na MESMA nota ao mesmo tempo. Com `writeFileSync` cru, um leitor pode
// pegar o arquivo já truncado por outro escritor; quem lê um topo sem `---` acabava
// prependando um frontmatter novo, empilhando blocos na nota (visto em produção: 4 blocos).
//
// `obsidian-common.mjs` já resolvia isso para o SESSION_REGISTRY.json; aqui o mesmo par
// (tmp + rename, lock por mkdir) fica disponível para a nota de sessão.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';

export const LOCK_BUSY = Symbol('wendkeep:lock-busy');

// ATENÇÃO: no Windows (Node 24), `rmSync(dir, { recursive: true, force: true })` é um NO-OP
// SILENCIOSO quando o caminho contém caractere não-ASCII — não remove e não lança. Medido:
// 20/20 falhas em `02-Sessões`, `ação`, `Mudanças`; 0/20 em caminho ASCII. Como TODA nota de
// sessão vive sob `02-Sessões/`, usar rmSync aqui deixaria o lock preso para sempre e o
// segundo escritor desistiria de gravar — perdendo turnos em silêncio.
// O lock é sempre um diretório vazio, então `rmdirSync` basta e funciona em qualquer caminho.
export function releaseLockDir(lock) {
  try {
    rmdirSync(lock);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    try { rmSync(lock, { recursive: true, force: true }); } catch { /* lock preso: melhor seguir */ }
  }
}

const FRONTMATTER = /^---\n[\s\S]*?\n---/;

export function hasSessionFrontmatter(content) {
  return typeof content === 'string' && FRONTMATTER.test(content);
}

export function writeFileAtomic(path, content, encoding = 'utf-8') {
  // rename é atômico no mesmo volume: ou o leitor vê o arquivo antigo inteiro, ou o novo.
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, encoding);
  renameSync(tmp, path);
}

function waitBriefly(ms) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

// Roda `fn` com o lock do arquivo tomado. Devolve LOCK_BUSY quando o lock não veio dentro
// do timeout — o chamador desiste da gravação em vez de gravar sem lock.
export function withPathLock(path, fn, { timeoutMs = 2000, staleMs = 10_000 } = {}) {
  const lock = `${path}.lock`;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        // Lock morto (processo caiu antes do finally) não pode travar a sessão inteira.
        if (Date.now() - statSync(lock).mtimeMs > staleMs) releaseLockDir(lock);
      } catch { /* outro processo pode ter liberado o lock no meio da checagem */ }
      // O deadline é checado SEMPRE, inclusive depois de tentar remover um lock morto:
      // `releaseLockDir` engole a falha, então um `continue` direto giraria para sempre.
      if (Date.now() >= deadline) return LOCK_BUSY;
      waitBriefly(10);
    }
  }

  try {
    return fn();
  } finally {
    releaseLockDir(lock);
  }
}

// Lock -> read -> mutator -> escrita atômica.
// O mutator devolve o conteúdo novo, ou `null` para abortar sem gravar (o caminho
// fail-closed de quem leu uma nota corrompida).
export function mutateSessionNote(path, mutator, options = {}) {
  if (!path || !existsSync(path)) return { written: false, reason: 'missing', content: null };

  const outcome = withPathLock(path, () => {
    const original = readFileSync(path, 'utf-8');
    const next = mutator(original);
    if (next === null || next === undefined) return { written: false, reason: 'aborted', content: original };
    if (next === original) return { written: false, reason: 'unchanged', content: original };
    writeFileAtomic(path, next);
    return { written: true, reason: 'ok', content: next };
  }, options);

  if (outcome === LOCK_BUSY) return { written: false, reason: 'busy', content: null };
  return outcome;
}
