// 0.31.0 — plan-capture (PostToolUse ExitPlanMode): a ponte determinística plan-mode → vault.
// Plano aprovado no plan mode do Claude Code vira change no vault (ou anexa à change ativa),
// sem depender de a LLM lembrar do processo. Rejeição = no-op.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { capturePlan, extractPlan, planSlug } from '../hooks/plan-capture.mjs';
import { activeChange, setActiveChange } from '../hooks/change-core.mjs';

const PLAN = `# Plano — auth com refresh token

## Contexto

O login expira cedo demais; precisamos de refresh token com rotação.

## Implementação

Detalhes da abordagem técnica aqui.

- [ ] criar tabela refresh_tokens
- [ ] endpoint /auth/refresh
- [x] spike de rotação validado
`;

test('extractPlan: tool_input.plan (legado), marcador Approved Plan, e rejeição', () => {
  assert.equal(extractPlan({ tool_input: { plan: PLAN }, tool_response: 'User has approved your plan.' }), PLAN);
  const resp = `User has approved your plan. You can now start coding.\n\n## Approved Plan (edited by user):\n${PLAN}`;
  assert.match(extractPlan({ tool_input: {}, tool_response: resp }), /refresh token com rotação/);
  // rejeição → null
  assert.equal(extractPlan({ tool_input: { plan: PLAN }, tool_response: "The user doesn't want to proceed with this tool use." }), null);
  // sem sinal de aprovação → null
  assert.equal(extractPlan({ tool_input: {}, tool_response: 'algo qualquer' }), null);
});

test('extractPlan: payload estruturado atual do PostToolUse ExitPlanMode', () => {
  const input = {
    tool_input: { plan: PLAN },
    tool_response: {
      plan: PLAN,
      filePath: 'C:/Users/test/.claude/plans/auth.md',
      isAgent: false,
      planWasEdited: true,
    },
  };
  assert.equal(extractPlan(input), PLAN);
});

test('planSlug: slug do H1 do plano', () => {
  assert.match(planSlug(PLAN), /^plano-auth-com-refresh-token|^auth-com-refresh-token/);
  assert.equal(planSlug('sem título nenhum aqui'), 'plano-aprovado');
});

test('capturePlan sem change ativa: auto-cria a change preenchida a partir do plano', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-pc1-'));
  try {
    const r = capturePlan(vault, { tool_input: { plan: PLAN }, tool_response: 'User has approved your plan.', session_id: 'p1' });
    assert.ok(r && r.created, 'change criada');
    assert.equal(activeChange(vault), r.slug, 'vira a change ativa');
    const dir = join(vault, '08-Mudanças', r.slug);
    const proposta = readFileSync(join(dir, 'proposta.md'), 'utf8');
    assert.match(proposta, /refresh token com rotação/, 'proposta preenchida do Contexto do plano');
    assert.doesNotMatch(proposta, /\(motivo da mudança\)/, 'sem placeholder');
    const design = readFileSync(join(dir, 'design.md'), 'utf8');
    assert.match(design, /abordagem técnica/, 'design do corpo do plano');
    const tarefas = readFileSync(join(dir, 'tarefas.md'), 'utf8');
    assert.match(tarefas, /- \[ \] 1\.1 criar tabela refresh_tokens/, 'checkboxes viram tarefas numeradas');
    assert.match(tarefas, /- \[x\] 1\.3 spike de rotação validado/, 'estado do checkbox preservado');
    assert.ok(existsSync(join(dir, 'plano-aprovado.md')), 'plano bruto preservado');
    const snapshots = readdirSync(join(dir, 'planos'));
    assert.equal(snapshots.length, 1, 'snapshot imutável criado');
    capturePlan(vault, { tool_input: { plan: PLAN }, tool_response: { plan: PLAN, filePath: 'x.md' } });
    assert.equal(readdirSync(join(dir, 'planos')).length, 1, 'mesmo plano deduplicado por hash');
    assert.match(r.context, /registrada no vault/, 'additionalContext confirma');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('capturePlan usa registry do transcript como source da change', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-pc-reg-'));
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    writeFileSync(join(vault, '.brain', 'SESSION_REGISTRY.json'), JSON.stringify({
      version: 1,
      sessions: {
        s1: {
          status: 'active',
          session_file: '02-Sessões/2026/07-JUL/DIA 09/sessao.md',
          transcript_path: 'C:/Users/test/.claude/projects/p/s1.jsonl',
          started_at: '2026-07-09T10:00:00',
        },
      },
    }));
    const r = capturePlan(vault, {
      transcript_path: 'c:\\users\\test\\.claude\\projects\\p\\s1.jsonl',
      tool_input: { plan: PLAN },
      tool_response: { plan: PLAN, filePath: 'x.md' },
    });
    const proposta = readFileSync(join(vault, '08-Mudanças', r.slug, 'proposta.md'), 'utf8');
    assert.match(proposta, /02-Sessões\/2026\/07-JUL\/DIA 09\/sessao/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('plan-capture entrypoint via stdin persiste e emite contexto', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-pc-e2e-'));
  try {
    const hook = join(process.cwd(), 'hooks', 'plan-capture.mjs');
    const input = JSON.stringify({
      tool_input: { plan: PLAN },
      tool_response: { plan: PLAN, filePath: 'C:/tmp/plan.md', planWasEdited: true, isAgent: false },
      obsidian_vault_path: vault,
    });
    const r = spawnSync(process.execPath, [hook], {
      input,
      encoding: 'utf8',
      env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
    });
    assert.equal(r.status, 0, r.stderr);
    const output = JSON.parse(r.stdout);
    assert.match(output.hookSpecificOutput?.additionalContext || '', /plan_captured/);
    assert.ok(existsSync(join(vault, '08-Mudanças')), `${r.stdout}\n${r.stderr}`);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('capturePlan sem checkboxes no plano: tarefas.md mantém o scaffold', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-pc2-'));
  try {
    const r = capturePlan(vault, { tool_input: { plan: '# Plano X\n\n## Contexto\n\nmotivo real\n\ncorpo' }, tool_response: 'User has approved your plan.' });
    const tarefas = readFileSync(join(vault, '08-Mudanças', r.slug, 'tarefas.md'), 'utf8');
    assert.match(tarefas, /- \[ \] 1\.1/, 'scaffold de tarefa presente');
    assert.match(r.context, /tarefas\.md/, 'context pede revisão das tarefas');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('capturePlan com change ativa: anexa plano-aprovado.md sem criar change nova', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-pc3-'));
  try {
    const dir = join(vault, '08-Mudanças', 'existente');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'proposta.md'), '---\ntype: change\nstatus: active\nspecs: []\n---\n\n# existente\n\nreal\n');
    setActiveChange(vault, 'existente');
    const r = capturePlan(vault, { tool_input: { plan: PLAN }, tool_response: 'User has approved your plan.' });
    assert.ok(r && !r.created, 'não cria change nova');
    assert.equal(r.slug, 'existente');
    assert.ok(existsSync(join(dir, 'plano-aprovado.md')));
    assert.equal(activeChange(vault), 'existente', 'ponteiro intocado');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('capturePlan: rejeição é no-op total', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-pc4-'));
  try {
    const r = capturePlan(vault, { tool_input: { plan: PLAN }, tool_response: "The user doesn't want to proceed with this tool use." });
    assert.equal(r, null);
    assert.ok(!existsSync(join(vault, '08-Mudanças')), 'nada criado');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
