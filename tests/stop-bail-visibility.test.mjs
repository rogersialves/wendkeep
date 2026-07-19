// The Stop hook used to bail by writing to stderr and exiting 0. Codex discards stderr, so a
// whole session of lost turns produced zero user-visible signal — that is why BUG-0003
// survived unnoticed. `systemMessage` is the channel the Codex UI actually surfaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'session-stop.mjs');

function runStop(buildPayload, { vault } = {}) {
  const proj = mkdtempSync(join(tmpdir(), 'wk-bail-proj-'));
  const payload = typeof buildPayload === 'function' ? buildPayload(proj) : buildPayload;
  const vaultBase = vault || join(proj, '.v');
  mkdirSync(join(vaultBase, '.brain'), { recursive: true });
  // A real binding on both ends: without PROJECT.json the hook bails on vault resolution
  // instead of on identity, and the test would prove the wrong path.
  writeFileSync(join(proj, '.wendkeep.json'), JSON.stringify({ schemaVersion: 1, projectId: 'p1', vault: '.v' }), 'utf-8');
  writeFileSync(join(vaultBase, '.brain', 'PROJECT.json'), JSON.stringify({ schemaVersion: 1, projectId: 'p1' }), 'utf-8');
  const r = spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: 'utf8',
    cwd: proj,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vaultBase, CLAUDECODE: '', CLAUDE_CODE_SESSION_ID: '' },
  });
  let out = {};
  try { out = JSON.parse(r.stdout || '{}'); } catch { /* keep {} */ }
  return { ...r, out };
}

// `cwd` MUST point at the fixture project: session-stop resolves the vault from the payload's
// cwd, not from the process cwd. Pointing it elsewhere kills the run at vault resolution and
// exercises only the top-level catch — which is how the identity-bail branch went untested.
const unresolvable = (proj) => JSON.stringify({
  session_id: 'nao-registrada-em-lugar-nenhum',
  turn_id: 'turn-1',
  hook_event_name: 'Stop',
  cwd: proj,
});

// --- CODEX-9 -----------------------------------------------------------------

test('session-stop: bail por identidade não resolvida avisa via systemMessage', () => {
  const { out, stderr } = runStop(unresolvable);
  // Prova que chegamos no bail de IDENTIDADE, e não no catch de topo por vault não resolvido.
  assert.match(stderr, /Stop sem identidade segura/, `caminho errado exercitado: ${stderr}`);
  assert.equal(typeof out.systemMessage, 'string', 'o usuário precisa ver alguma coisa');
  assert.match(out.systemMessage, /wendkeep/i);
  // O motivo é metade da cláusula: uma mensagem que só diz "não registrado, rode o import"
  // manda o usuário pro comando sem dizer o que aconteceu. Ancorar no diagnóstico que o
  // próprio hook reportou, em vez de numa string fixa, prova que o motivo é PROPAGADO —
  // remover `${why}` de bailMessage quebra aqui.
  const why = (stderr.match(/Stop sem identidade segura: (.+)/) || [])[1]?.trim();
  assert.ok(why, 'o stderr precisa trazer o diagnóstico');
  assert.ok(out.systemMessage.includes(why), `systemMessage não repassa o motivo "${why}": ${out.systemMessage}`);
  assert.match(out.systemMessage, /import --source codex/, 'precisa dizer como recuperar');
});

test('session-stop: falha dura também avisa, não só o bail de identidade', () => {
  // Vault inexistente: cai no catch de topo, que também escrevia {} e sumia com o erro.
  const { out } = runStop(unresolvable, { vault: join(tmpdir(), 'wk-vault-que-nao-existe-xyz') });
  assert.equal(typeof out.systemMessage, 'string', 'catch de topo não pode voltar a ser mudo');
  assert.match(out.systemMessage, /import --source codex/);
});

test('session-stop: payload truncado nomeia a issue upstream, não deixa parecer defeito nosso', () => {
  // Prefixo bem-formado + string cortada: o salvamento recupera os campos e o hook chega no
  // bail de identidade já sabendo que o payload veio truncado.
  const truncated = (proj) => `{"session_id":"nao-registrada","turn_id":"t1","hook_event_name":"Stop",`
    + `"cwd":${JSON.stringify(proj)},"last_assistant_message":"Analisei a configura}`;
  const { out, stderr } = runStop(truncated);
  assert.match(stderr, /Stop sem identidade segura/, 'precisa alcançar o bail de identidade');
  assert.match(out.systemMessage, /openai\/codex#23784/, 'sem a issue, o usuário culpa o wendkeep');
});

test('session-stop: bail comum NÃO cita a issue upstream — o aviso tem que ser honesto', () => {
  // A guarda contra citar #23784 em toda falha: só o payload truncado justifica a menção.
  const { out } = runStop(unresolvable);
  assert.ok(!/23784/.test(out.systemMessage), `citou a issue sem payload truncado: ${out.systemMessage}`);
});

test('session-stop: sai com código 0 mesmo falhando — exit != 0 trava o turno no Codex', () => {
  assert.equal(runStop(unresolvable).status, 0);
  assert.equal(runStop('lixo que não parseia').status, 0);
});

test('session-stop: stdout continua sendo JSON válido em todo caminho de bail', () => {
  for (const payload of [unresolvable, '', 'lixo que não parseia']) {
    const r = runStop(payload);
    assert.ok(r.stdout.trim(), 'stdout vazio esconderia o bail — precisa ter JSON');
    assert.doesNotThrow(() => JSON.parse(r.stdout));
  }
});
