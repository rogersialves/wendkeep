import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parse } from 'acorn';
import {
  salvageTruncatedJson,
  parseHookInput,
  stringifyHookOutput,
  detectProvider,
  providerMeta,
  extractHookPrompt,
} from '../packages/integrations/src/hook-envelope.mjs';
import * as legacy from '../hooks/obsidian-common.mjs';

const LEGACY_URL = new URL('../hooks/obsidian-common.mjs', import.meta.url).href;

function memberPath(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type !== 'MemberExpression' || node.computed) return '';
  const owner = memberPath(node.object);
  const property = memberPath(node.property);
  return owner && property ? `${owner}.${property}` : '';
}

function callsFrom(fn) {
  const calls = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression') calls.push(memberPath(node.callee));
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(parse(`(${fn.toString()})`, { ecmaVersion: 'latest' }));
  return calls.sort();
}

for (const [label, raw, expected] of [
  ['objeto', ' {"session_id":"abc"} ', { session_id: 'abc' }],
  ['array', '[1,{"nested":true}]', [1, { nested: true }]],
  ['null', 'null', null],
  ['booleano', 'false', false],
  ['número', '0', 0],
  ['string', '"prompt"', 'prompt'],
]) {
  test(`[req:MOD-21] parseHookInput preserva JSON válido: ${label}`, () => {
    assert.deepEqual(parseHookInput(raw), expected);
  });
}

test('[req:MOD-21] parseHookInput preserva stdin vazio como objeto vazio', () => {
  assert.deepEqual(parseHookInput(' \r\n\t '), {});
});

test('[req:MOD-21] parseHookInput marca apenas o prefixo truncado recuperável', () => {
  const raw = '{"session_id":"abc","meta":{"nested":true},'
    + '"last_assistant_message":"cortou, ainda dentro da string';

  assert.deepEqual(salvageTruncatedJson(raw), {
    session_id: 'abc',
    meta: { nested: true },
  });
  assert.deepEqual(parseHookInput(raw), {
    session_id: 'abc',
    meta: { nested: true },
    _wkSalvaged: true,
  });
});

test('[req:MOD-21] parseHookInput relança o mesmo SyntaxError quando o JSON é irrecuperável', () => {
  const originalParse = JSON.parse;
  const sentinel = new SyntaxError('erro original do parser');
  JSON.parse = () => { throw sentinel; };
  try {
    assert.throws(() => parseHookInput('isso não é JSON'), (error) => error === sentinel);
  } finally {
    JSON.parse = originalParse;
  }
});

for (const [label, payload, expected] of [
  ['default', undefined, '{}'],
  ['objeto', { ok: true, nested: { n: 1 } }, '{"ok":true,"nested":{"n":1}}'],
  ['array', [1, 'x'], '[1,"x"]'],
  ['null', null, 'null'],
  ['booleano', false, 'false'],
  ['número', 0, '0'],
  ['string', 'x', '"x"'],
]) {
  test(`[req:MOD-21] stringifyHookOutput emite JSON exato sem newline: ${label}`, () => {
    const output = stringifyHookOutput(payload);
    assert.equal(output, expected);
    assert.equal(output.endsWith('\n'), false);
  });
}

for (const [label, environment] of [
  ['CLAUDECODE', { CLAUDECODE: '1' }],
  ['CLAUDE_CODE_SESSION_ID', { CLAUDE_CODE_SESSION_ID: 'session-1' }],
  ['CLAUDE_PROJECT_DIR', { CLAUDE_PROJECT_DIR: 'C:\\repo' }],
]) {
  test(`[req:MOD-21] detectProvider reconhece marcador Claude: ${label}`, () => {
    assert.equal(detectProvider(environment), 'claude');
  });
}

test('[req:MOD-21] detectProvider usa fallback Codex sem marcador Claude', () => {
  assert.equal(detectProvider({}), 'codex');
  assert.equal(detectProvider({ CLAUDECODE: '0', CLAUDE_CODE_SESSION_ID: '', CLAUDE_PROJECT_DIR: '' }), 'codex');
});

test('[req:MOD-21] providerMeta preserva os metadados Claude e o fallback Codex', () => {
  assert.deepEqual(providerMeta('claude'), {
    id: 'claude', label: 'Claude Code', tag: 'claude', source: 'claude-hook',
  });
  const codex = { id: 'codex', label: 'Codex', tag: 'codex', source: 'codex-hook' };
  assert.deepEqual(providerMeta('codex'), codex);
  assert.deepEqual(providerMeta(), codex);
  assert.deepEqual(providerMeta('unknown-provider'), codex);
});

for (const [alias, value] of [
  ['prompt', 'prompt direto'],
  ['user_prompt', 'snake case'],
  ['userPrompt', 'camel case'],
  ['message', 'mensagem'],
  ['input', 'entrada'],
]) {
  test(`[req:MOD-21] extractHookPrompt normaliza alias ${alias}`, () => {
    assert.equal(extractHookPrompt({ [alias]: `  ${value}  ` }), value);
  });
}

test('[req:MOD-21] extractHookPrompt respeita precedência e agrega mensagens textuais', () => {
  assert.equal(extractHookPrompt({ prompt: ' primeiro ', user_prompt: 'segundo' }), 'primeiro');
  assert.equal(extractHookPrompt({
    prompt: '   ',
    messages: [
      { content: ' um ' },
      { text: 'dois' },
      { content: { type: 'text', text: 'ignorado' } },
      null,
    ],
  }), 'um \ndois');
  assert.equal(extractHookPrompt({}), '');
});

test('[req:MOD-20] obsidian-common reexporta os helpers puros por identidade', () => {
  assert.strictEqual(legacy.salvageTruncatedJson, salvageTruncatedJson);
  assert.strictEqual(legacy.extractHookPrompt, extractHookPrompt);
});

test('[req:MOD-21] reexport puro continua disponível aos consumidores internos legados', () => {
  assert.equal(legacy.sessionSummaryFromInput({ prompt: '  duas palavras  ' }), 'Duas palavras');
});

test('[req:MOD-20] wrappers legados compõem somente I/O/ambiente com o kernel canônico', () => {
  assert.deepEqual(callsFrom(legacy.readHookInput), ['parseHookInput', 'readFileSync']);
  assert.deepEqual(callsFrom(legacy.writeHookOutput), ['process.stdout.write', 'stringifyHookOutput']);
  assert.deepEqual(callsFrom(legacy.detectProvider), ['detectProviderFromEnvironment']);
  assert.deepEqual(callsFrom(legacy.providerMeta), ['detectProvider', 'providerMetaFromProvider']);
});

test('[req:MOD-21] wrappers legados detectam provider no process.env a cada chamada', () => {
  for (const marker of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PROJECT_DIR']) {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.CLAUDE_PROJECT_DIR;
    const code = `import{detectProvider,providerMeta}from${JSON.stringify(LEGACY_URL)};`
      + `const marker=${JSON.stringify(marker)};const value=marker==='CLAUDECODE'?'1':'present';`
      + 'const states=[];const capture=()=>states.push({provider:detectProvider(),meta:providerMeta()});'
      + 'capture();process.env[marker]=value;capture();delete process.env[marker];capture();'
      + 'process.stdout.write(JSON.stringify(states))';
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8', env,
    });
    assert.equal(result.status, 0, result.stderr);
    const codex = {
      provider: 'codex',
      meta: { id: 'codex', label: 'Codex', tag: 'codex', source: 'codex-hook' },
    };
    const claude = {
      provider: 'claude',
      meta: { id: 'claude', label: 'Claude Code', tag: 'claude', source: 'claude-hook' },
    };
    assert.deepEqual(JSON.parse(result.stdout), [codex, claude, codex]);
  }
});

test('[req:MOD-21] writeHookOutput legado escreve somente o JSON canônico', () => {
  const code = `import{writeHookOutput}from${JSON.stringify(LEGACY_URL)};`
    + 'writeHookOutput({ok:true,nested:[1,"x"]})';
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '{"ok":true,"nested":[1,"x"]}');
  assert.equal(result.stderr, '');
});
