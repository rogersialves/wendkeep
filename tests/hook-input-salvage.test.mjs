// The Codex Stop payload arrives truncated on Windows when the assistant message carries
// non-ASCII text (openai/codex#23784): the JSON string is cut and never closed. Everything
// wendkeep needs sits before that field, so the prefix must survive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { salvageTruncatedJson } from '../hooks/obsidian-common.mjs';

// Field order mirrors StopCommandInput in codex-rs — last_assistant_message is final.
const PREFIX = '{"session_id":"019f7764-7627-79a3-b609-65abaa36eedd","turn_id":"turn-abc",'
  + '"transcript_path":"C:\\\\Users\\\\x\\\\rollout.jsonl","cwd":"C:\\\\GitHub\\\\Vendiva",'
  + '"hook_event_name":"Stop","model":"gpt-5.6-sol","permission_mode":"default","stop_hook_active":false';

// --- CODEX-8 -----------------------------------------------------------------

test('salvageTruncatedJson: recupera os campos do prefixo quando a última string não fecha', () => {
  const raw = `${PREFIX},"last_assistant_message":"Analisei a configura}`;
  assert.throws(() => JSON.parse(raw), 'o payload precisa ser realmente inválido');

  const out = salvageTruncatedJson(raw);
  assert.equal(out.session_id, '019f7764-7627-79a3-b609-65abaa36eedd');
  assert.equal(out.turn_id, 'turn-abc');
  assert.equal(out.transcript_path, 'C:\\Users\\x\\rollout.jsonl');
  assert.equal(out.cwd, 'C:\\GitHub\\Vendiva');
  assert.equal(out.hook_event_name, 'Stop');
  assert.equal(out.stop_hook_active, false);
});

test('salvageTruncatedJson: descarta o campo truncado em vez de adivinhar o conteúdo', () => {
  const out = salvageTruncatedJson(`${PREFIX},"last_assistant_message":"Analisei a configura}`);
  assert.ok(!('last_assistant_message' in out), 'campo cortado não pode ser inventado pela metade');
});

test('salvageTruncatedJson: corte no meio de um caractere acentuado', () => {
  const out = salvageTruncatedJson(`${PREFIX},"last_assistant_message":"ConfiguraÃ}`);
  assert.equal(out.session_id, '019f7764-7627-79a3-b609-65abaa36eedd');
  assert.equal(out.transcript_path, 'C:\\Users\\x\\rollout.jsonl');
});

test('salvageTruncatedJson: vírgula dentro de string não conta como fronteira de campo', () => {
  // A gulosa: cortar na última vírgula literal cairia DENTRO do cwd e perderia campos.
  const raw = '{"session_id":"abc","cwd":"C:\\\\a, b, c","transcript_path":"/x.jsonl",'
    + '"last_assistant_message":"texto corta}';
  const out = salvageTruncatedJson(raw);
  assert.equal(out.cwd, 'C:\\a, b, c', 'vírgulas dentro da string preservadas');
  assert.equal(out.transcript_path, '/x.jsonl', 'campo depois da string com vírgula sobrevive');
});

test('salvageTruncatedJson: aspas escapadas não encerram a string', () => {
  const raw = '{"session_id":"abc","cwd":"diz \\"oi\\", certo","transcript_path":"/x.jsonl",'
    + '"last_assistant_message":"corta}';
  const out = salvageTruncatedJson(raw);
  assert.equal(out.cwd, 'diz "oi", certo');
  assert.equal(out.transcript_path, '/x.jsonl');
});

// Os casos abaixo põem o conteúdo difícil DENTRO do campo cortado, que é onde ele aparece no
// payload real do Codex. Sem isso, um `lastIndexOf(',')` ingênuo passaria em todos os testes
// acima — o conteúdo difícil vinha antes do corte, onde as duas estratégias concordam.

test('salvageTruncatedJson: vírgula DENTRO da mensagem truncada não é fronteira de campo', () => {
  const raw = `${PREFIX},"last_assistant_message":"Analisei, revisei e corrigi a configura`;
  const out = salvageTruncatedJson(raw);
  assert.ok(out, 'cortar na última vírgula literal cairia dentro da mensagem e perderia tudo');
  assert.equal(out.transcript_path, 'C:\\Users\\x\\rollout.jsonl');
  assert.equal(out.session_id, '019f7764-7627-79a3-b609-65abaa36eedd');
  assert.ok(!('last_assistant_message' in out));
});

test('salvageTruncatedJson: aspas escapadas dentro da mensagem truncada', () => {
  const raw = `${PREFIX},"last_assistant_message":"Rodei \\"npm test\\", passou, mas o build`;
  const out = salvageTruncatedJson(raw);
  assert.ok(out);
  assert.equal(out.transcript_path, 'C:\\Users\\x\\rollout.jsonl');
});

test('salvageTruncatedJson: aspa escapada ímpar SEGUIDA de vírgula', () => {
  // Só a aspa ímpar não basta: sem rastrear o escape ela "fecha" a string cedo, mas se não
  // vier vírgula depois os dois caminhos coincidem. Com a vírgula, a versão sem escape a lê
  // como fronteira de campo, corta dentro da mensagem e devolve null. É o caso que separa.
  const raw = `${PREFIX},"last_assistant_message":"Rodei \\"npm test, passou, mas o build`;
  const out = salvageTruncatedJson(raw);
  assert.ok(out, 'sem rastrear o escape, a vírgula de dentro vira fronteira e o prefixo se perde');
  assert.equal(out.transcript_path, 'C:\\Users\\x\\rollout.jsonl');
  assert.equal(out.session_id, '019f7764-7627-79a3-b609-65abaa36eedd');
  assert.ok(!('last_assistant_message' in out));
});

test('salvageTruncatedJson: chave iniciada mas sem valor ainda', () => {
  const out = salvageTruncatedJson(`${PREFIX},"last_assistant_`);
  assert.ok(out);
  assert.equal(out.turn_id, 'turn-abc');
});

test('salvageTruncatedJson: devolve null quando nem o prefixo é aproveitável', () => {
  assert.equal(salvageTruncatedJson('{"session_id":"abc'), null, 'só um campo, ele mesmo cortado');
  assert.equal(salvageTruncatedJson('não é json'), null);
  assert.equal(salvageTruncatedJson(''), null);
});

test('salvageTruncatedJson: objeto aninhado não fecha a fronteira cedo demais', () => {
  const raw = '{"session_id":"abc","meta":{"a":1,"b":2},"transcript_path":"/x.jsonl",'
    + '"last_assistant_message":"corta}';
  const out = salvageTruncatedJson(raw);
  assert.deepEqual(out.meta, { a: 1, b: 2 });
  assert.equal(out.transcript_path, '/x.jsonl');
});

// readHookInput reads fd 0, so exercise it through a child process. The module URL is derived
// from this test file so the spawn works on Windows and on the Linux CI matrix alike.
const COMMON_URL = new URL('../hooks/obsidian-common.mjs', import.meta.url).href;
const runReadHookInput = (stdin) => {
  const code = `import{readHookInput}from${JSON.stringify(COMMON_URL)};`
    + 'try{process.stdout.write(JSON.stringify({ok:true,value:readHookInput()}))}'
    + 'catch(e){process.stdout.write(JSON.stringify({ok:false,message:String(e.message)}))}';
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { input: stdin, encoding: 'utf8' });
  return JSON.parse(r.stdout);
};

test('readHookInput: payload íntegro não é marcado como salvo', () => {
  const out = runReadHookInput('{"session_id":"abc","transcript_path":"/x.jsonl"}');
  assert.equal(out.ok, true);
  assert.equal(out.value.session_id, 'abc');
  assert.ok(!('_wkSalvaged' in out.value), 'parse normal não marca salvamento');
});

test('readHookInput: payload truncado é salvo e marcado', () => {
  const out = runReadHookInput(`${PREFIX},"last_assistant_message":"corta}`);
  assert.equal(out.ok, true, 'não pode mais lançar');
  assert.equal(out.value._wkSalvaged, true);
  assert.equal(out.value.transcript_path, 'C:\\Users\\x\\rollout.jsonl');
});

test('readHookInput: stdin vazio continua devolvendo objeto vazio', () => {
  assert.deepEqual(runReadHookInput('').value, {});
});

test('readHookInput: lixo irrecuperável ainda lança — salvamento não vira silêncio novo', () => {
  const out = runReadHookInput('isso não é json de jeito nenhum');
  assert.equal(out.ok, false);
  assert.match(out.message, /JSON/i);
});
