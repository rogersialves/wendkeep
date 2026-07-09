// 0.31.0 — enforcement do change lifecycle: quickGateState/sentinelas (change-core) e os hooks
// change-guard/change-context/change-warn/change-nag. Testes unit por import direto das funções
// puras + e2e por spawn do bin (stdin fake), padrão hook-runtime.test.mjs. Nada depende de rmSync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  quickGateState, changeCtxState, sentinelPath, readSentinel, writeSentinel, setActiveChange,
  staleSentinelNames, pruneChangeSentinels,
} from '../hooks/change-core.mjs';
import { guardDecision } from '../hooks/change-guard.mjs';
import { buildChangePing, looksLikeTask } from '../hooks/change-context.mjs';
import { warnDecision, isCodeFile } from '../hooks/change-warn.mjs';
import { nagDecision } from '../hooks/change-nag.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

function runHook(name, stdin, vault, extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, 'hook', name], {
    input: stdin, encoding: 'utf8',
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault, ...extraEnv },
  });
}

// Vault temp com uma change ativa `x` (tarefas parametrizáveis).
function vaultWithChange(tarefas = '- [ ] 1.1 faz a coisa [sensor:s]\n- [x] 1.2 feita\n') {
  const vault = mkdtempSync(join(tmpdir(), 'wk-chh-'));
  const dir = join(vault, '08-Mudanças', 'x');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'proposta.md'), '---\ntype: change\nstatus: active\nspecs: []\n---\n\n# x\n\n## Por quê\n\nreal\n\n## O que muda\n\nreal\n');
  writeFileSync(join(dir, 'design.md'), '# x — design\n\nreal\n');
  writeFileSync(join(dir, 'tarefas.md'), tarefas);
  setActiveChange(vault, 'x');
  return { vault, dir };
}

// --- quickGateState ----------------------------------------------------------

test('quickGateState: null sem change ativa', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-qgs0-'));
  try { assert.equal(quickGateState(vault), null); }
  finally { rmSync(vault, { recursive: true, force: true }); }
});

test('quickGateState: slug, openTasks, placeholders, redCritical, evidenceStale', () => {
  const { vault, dir } = vaultWithChange();
  try {
    let g = quickGateState(vault);
    assert.equal(g.slug, 'x');
    assert.equal(g.openTasks, 1);
    assert.equal(g.placeholders, 0);
    assert.equal(g.redCritical, false);
    assert.equal(g.evidenceStale, false);

    // evidência crítica vermelha
    writeFileSync(join(dir, 'evidencia.json'), JSON.stringify([{ id: 's', status: 'red', severity: 'critical' }]));
    assert.equal(quickGateState(vault).redCritical, true, 'critical red bloqueia');
    // warning vermelho NÃO conta
    writeFileSync(join(dir, 'evidencia.json'), JSON.stringify([{ id: 's', status: 'red', severity: 'warning' }]));
    assert.equal(quickGateState(vault).redCritical, false, 'warning red não conta');
    // evidência corrompida → fail-open
    writeFileSync(join(dir, 'evidencia.json'), 'não-é-json');
    assert.equal(quickGateState(vault).redCritical, false, 'JSON inválido = fail-open');
    // hash de evidência divergente → stale
    writeFileSync(join(dir, '.evidence-hash'), 'hash-antigo');
    assert.equal(quickGateState(vault).evidenceStale, true);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('quickGateState: placeholders do scaffold contam', () => {
  const { vault, dir } = vaultWithChange();
  try {
    writeFileSync(join(dir, 'design.md'), '# x — design\n\n## Abordagem\n\n(abordagem técnica)\n');
    assert.equal(quickGateState(vault).placeholders, 1);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

// --- sentinelas + changeCtxState ---------------------------------------------

test('sentinelPath sanitiza session_id; write/read roundtrip; read vazio sem arquivo', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-sent-'));
  try {
    const p = sentinelPath(vault, 'ctx', 'a/b:c*d');
    assert.match(p, /\.change-ctx-a_b_c_d$/, 'chars perigosos viram _');
    assert.equal(readSentinel(vault, 'ctx', 'a/b:c*d'), '', 'sem arquivo = vazio');
    writeSentinel(vault, 'ctx', 'a/b:c*d', 'h123');
    assert.equal(readSentinel(vault, 'ctx', 'a/b:c*d'), 'h123');
    assert.ok(existsSync(p), 'arquivo criado no path sanitizado');
    // sid vazio não explode
    writeSentinel(vault, 'nag', '', '1');
    assert.equal(readSentinel(vault, 'nag', ''), '1');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('staleSentinelNames: só prefixos .change-*, só >7 dias; pruneChangeSentinels não lança', () => {
  const now = Date.now();
  const d8 = now - 8 * 86400000;
  const d1 = now - 1 * 86400000;
  const stale = staleSentinelNames([
    { name: '.change-ctx-a', mtimeMs: d8 },
    { name: '.change-nag-b', mtimeMs: d1 },
    { name: '.change-gate-c', mtimeMs: d8 },
    { name: 'CORE.md', mtimeMs: now - 30 * 86400000 },
    { name: '.change-warn-d', mtimeMs: d8 },
  ], now);
  assert.deepEqual(stale.sort(), ['.change-ctx-a', '.change-gate-c', '.change-warn-d']);
  // wrapper fail-quiet: .brain ausente → [] sem lançar (sem assert de deleção — sandbox)
  const vault = mkdtempSync(join(tmpdir(), 'wk-gc-'));
  try { assert.deepEqual(pruneChangeSentinels(vault), []); }
  finally { rmSync(vault, { recursive: true, force: true }); }
});

test('changeCtxState: null sem change; hash muda quando tarefas mudam; até 5 tarefas abertas', () => {
  const empty = mkdtempSync(join(tmpdir(), 'wk-ctx0-'));
  try { assert.equal(changeCtxState(empty), null); }
  finally { rmSync(empty, { recursive: true, force: true }); }

  const { vault, dir } = vaultWithChange('- [ ] 1.1 a\n- [ ] 1.2 b\n- [ ] 1.3 c\n- [ ] 1.4 d\n- [ ] 1.5 e\n- [ ] 1.6 f\n');
  try {
    const st = changeCtxState(vault);
    assert.equal(st.slug, 'x');
    assert.equal(st.openTasks.length, 5, 'cap em 5');
    const h1 = st.hash;
    writeFileSync(join(dir, 'tarefas.md'), '- [x] 1.1 a\n- [ ] 1.2 b\n');
    const st2 = changeCtxState(vault);
    assert.notEqual(st2.hash, h1, 'hash muda com tarefas.md');
    assert.equal(st2.openTasks.length, 1);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

// --- change-guard (PreToolUse Bash) -------------------------------------------

test('guardDecision R1: deny em archive --force; escape só via env do processo', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-gd1-'));
  try {
    for (const cmd of [
      'wendkeep change archive x --force',
      'wk change archive --force',
      'npx wendkeep change archive x --force',
      'WENDKEEP_ALLOW_FORCE=1 wendkeep change archive --force', // env inline no TEXTO não libera
    ]) {
      const d = guardDecision(cmd, { vaultBase: vault, env: {} });
      assert.equal(d?.permissionDecision, 'deny', cmd);
      assert.match(d.permissionDecisionReason, /abandon|status/, 'reason aponta a saída legítima');
    }
    // escape legítimo: env do PROCESSO
    assert.equal(guardDecision('wendkeep change archive x --force', { vaultBase: vault, env: { WENDKEEP_ALLOW_FORCE: '1' } }), null);
    // sem --force: livre
    assert.equal(guardDecision('wendkeep change archive x', { vaultBase: vault, env: {} }), null);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('guardDecision R2: ask em git commit com change ativa + redCritical ou --no-verify', () => {
  const { vault, dir } = vaultWithChange();
  try {
    // gate verde: commit livre
    assert.equal(guardDecision('git commit -m "x"', { vaultBase: vault, env: {} }), null);
    // --no-verify com change ativa → ask (mesmo verde)
    const nv = guardDecision('git add . && git commit --no-verify -m x', { vaultBase: vault, env: {} });
    assert.equal(nv?.permissionDecision, 'ask');
    assert.match(nv.permissionDecisionReason, /no-verify/);
    // sensor crítico vermelho → ask
    writeFileSync(join(dir, 'evidencia.json'), JSON.stringify([{ id: 's', status: 'red', severity: 'critical' }]));
    const red = guardDecision('git commit -m "y"', { vaultBase: vault, env: {} });
    assert.equal(red?.permissionDecision, 'ask');
    assert.match(red.permissionDecisionReason, /vermelho|verify/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('guardDecision: sem change ativa commit é livre; fast-path não toca o fs', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-gd3-'));
  try {
    assert.equal(guardDecision('git commit -m "z"', { vaultBase: vault, env: {} }), null, 'sem change = livre');
  } finally { rmSync(vault, { recursive: true, force: true }); }
  // fast-path: vault INEXISTENTE não importa para comando comum (nenhum I/O)
  assert.equal(guardDecision('npm test', { vaultBase: 'Z:/nao/existe', env: {} }), null);
  assert.equal(guardDecision('echo oi', { vaultBase: 'Z:/nao/existe', env: {} }), null);
  assert.equal(guardDecision('', { vaultBase: 'Z:/nao/existe', env: {} }), null);
});

test('change-guard e2e: deny JSON no stdout, exit 0; input malformado fail-open', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-gd4-'));
  try {
    const r = runHook('change-guard', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'wendkeep change archive x --force' } }), vault);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    // allow: sem output relevante
    const ok = runHook('change-guard', JSON.stringify({ tool_input: { command: 'npm test' } }), vault);
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout.trim() === '' || ok.stdout.trim() === '{}', true, 'allow = silêncio');
    // malformado
    const bad = runHook('change-guard', 'não-é-json', vault);
    assert.equal(bad.status, 0, 'fail-open');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

// --- change-context (UserPromptSubmit) ----------------------------------------

test('buildChangePing: pinga 1x, silencia com mesmo hash, re-pinga quando tarefas mudam', () => {
  const { vault, dir } = vaultWithChange();
  try {
    const p1 = buildChangePing(vault, 's1', '');
    assert.match(p1.context, /<active_change_ping>/);
    assert.match(p1.context, /Mudança ativa: x/);
    assert.match(p1.context, /1\.1 faz a coisa/);
    assert.match(p1.context, /wendkeep change done/);
    assert.equal(buildChangePing(vault, 's1', ''), null, 'mesmo estado = silêncio');
    writeFileSync(join(dir, 'tarefas.md'), '- [x] 1.1 faz a coisa\n- [ ] 1.3 nova\n');
    const p2 = buildChangePing(vault, 's1', '');
    assert.match(p2.context, /1\.3 nova/, 'estado mudou = re-ping');
    // outra sessão pinga independente
    assert.match(buildChangePing(vault, 's2', '').context, /<active_change_ping>/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('looksLikeTask + wk_skill_gate: sem change, prompt-tarefa ganha gate 1x/sessão', () => {
  assert.equal(looksLikeTask('implementa o login com refresh token'), true);
  assert.equal(looksLikeTask('corrige o bug do parser de datas'), true);
  assert.equal(looksLikeTask('add retry to the fetch client'), true);
  assert.equal(looksLikeTask('ok'), false);
  assert.equal(looksLikeTask('qual o status?'), false);
  const vault = mkdtempSync(join(tmpdir(), 'wk-cc2-'));
  try {
    const g1 = buildChangePing(vault, 's1', 'implementa o login com refresh token');
    assert.match(g1.context, /<wk_skill_gate>/);
    assert.match(g1.context, /wk-workflow/);
    assert.equal(buildChangePing(vault, 's1', 'refatora o módulo de billing'), null, '1x por sessão');
    assert.equal(buildChangePing(vault, 's1', 'oi'), null, 'não-tarefa nunca ganha gate');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('change-context e2e: additionalContext no 1º prompt, {} no 2º', () => {
  const { vault } = vaultWithChange();
  try {
    const r1 = runHook('change-context', JSON.stringify({ session_id: 'e1', prompt: 'oi' }), vault);
    assert.equal(r1.status, 0);
    assert.match(JSON.parse(r1.stdout).hookSpecificOutput.additionalContext, /active_change_ping/);
    const r2 = runHook('change-context', JSON.stringify({ session_id: 'e1', prompt: 'oi' }), vault);
    assert.equal(JSON.parse(r2.stdout).hookSpecificOutput?.additionalContext ?? '', '', '2º prompt silencioso');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

// --- change-warn (PostToolUse Edit|Write) --------------------------------------

test('isCodeFile: extensões de código, case-insensitive, win32', () => {
  assert.equal(isCodeFile('src/a.ts'), true);
  assert.equal(isCodeFile('C:\\p\\x.PRISMA'), true);
  assert.equal(isCodeFile('a/b.md'), false);
  assert.equal(isCodeFile('settings.json'), false);
  assert.equal(isCodeFile(''), false);
});

test('warnDecision: avisa 1x sem change; ignora vault/.claude/.brain e não-código', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-cw-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-cwp-'));
  try {
    const w1 = warnDecision('src/a.ts', { vaultBase: vault, cwd: proj, sessionId: 's1' });
    assert.match(w1, /change_warn/);
    assert.match(w1, /wendkeep change new/);
    assert.equal(warnDecision('src/b.ts', { vaultBase: vault, cwd: proj, sessionId: 's1' }), null, '1x por sessão');
    assert.match(warnDecision('src/c.ts', { vaultBase: vault, cwd: proj, sessionId: 's2' }), /change_warn/, 'sessão nova avisa de novo');
    // dentro do vault → nunca
    assert.equal(warnDecision(join(vault, 'nota.sql'), { vaultBase: vault, cwd: proj, sessionId: 's3' }), null);
    // .claude/.brain → nunca
    assert.equal(warnDecision(join(proj, '.claude', 'x.mjs'), { vaultBase: vault, cwd: proj, sessionId: 's4' }), null);
    assert.equal(warnDecision(join(proj, '.brain', 'y.mjs'), { vaultBase: vault, cwd: proj, sessionId: 's5' }), null);
    // não-código → nunca
    assert.equal(warnDecision('README.md', { vaultBase: vault, cwd: proj, sessionId: 's6' }), null);
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('warnDecision: com change ativa nunca avisa', () => {
  const { vault } = vaultWithChange();
  const proj = mkdtempSync(join(tmpdir(), 'wk-cwp2-'));
  try {
    assert.equal(warnDecision('src/a.ts', { vaultBase: vault, cwd: proj, sessionId: 's1' }), null);
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

// --- change-nag (Stop) ----------------------------------------------------------

test('nagDecision: block 1x com tarefas abertas; anti-loop absoluto; silêncio sem pendência', () => {
  const { vault, dir } = vaultWithChange();
  try {
    // anti-loop PRIMEIRO — mesmo com change pendente
    assert.equal(nagDecision({ stop_hook_active: true, session_id: 'n1' }, vault), null);
    const d = nagDecision({ session_id: 'n1' }, vault);
    assert.equal(d.decision, 'block');
    assert.match(d.reason, /1 tarefa\(s\) aberta/);
    assert.match(d.reason, /wendkeep change done/);
    assert.match(d.reason, /informe a pendência ao usuário/, 'saída honesta obrigatória');
    assert.equal(nagDecision({ session_id: 'n1' }, vault), null, '1x por sessão');
    // sem tarefas abertas → silêncio (sessão nova)
    writeFileSync(join(dir, 'tarefas.md'), '- [x] 1.1 tudo feito\n');
    assert.equal(nagDecision({ session_id: 'n2' }, vault), null);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('change-nag e2e: block JSON top-level; sem change → {}', () => {
  const { vault } = vaultWithChange();
  try {
    const r = runHook('change-nag', JSON.stringify({ session_id: 'ne1' }), vault);
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
  } finally { rmSync(vault, { recursive: true, force: true }); }
  const empty = mkdtempSync(join(tmpdir(), 'wk-nag0-'));
  try {
    const r0 = runHook('change-nag', JSON.stringify({ session_id: 'ne2' }), empty);
    assert.equal(JSON.parse(r0.stdout).decision ?? '', '', 'sem change = sem block');
  } finally { rmSync(empty, { recursive: true, force: true }); }
});
