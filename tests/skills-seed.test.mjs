import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WK_SKILLS, seedWkSkills, wkSkills } from '../src/skills-seed.mjs';

test('WK_SKILLS: the process skills, each valid SKILL.md with matching name', () => {
  const names = WK_SKILLS.map((s) => s.name);
  for (const n of ['wk-workflow', 'wk-tdd', 'wk-debugging', 'wk-brainstorming', 'wk-planning', 'wk-verify', 'wk-commit']) {
    assert.ok(names.includes(n), `has ${n}`);
  }
  for (const s of WK_SKILLS) {
    assert.match(s.body, new RegExp(`name:\\s*${s.name}\\b`), `${s.name} frontmatter name`);
    assert.match(s.body, /description:/, `${s.name} has description`);
    assert.ok(s.body.length > 200, `${s.name} body non-trivial`);
  }
});

test('[req:COMMIT-18] wk-commit ensina prova rederivada, coautoria omitida e hooks opt-in', () => {
  for (const locale of ['pt-BR', 'en']) {
    const skill = wkSkills(locale).find((item) => item.name === 'wk-commit');
    assert.ok(skill, `${locale}: wk-commit exists`);
    assert.match(skill.body, /wendkeep commit context/);
    assert.match(skill.body, /rederiv|re-deriv/i);
    assert.match(skill.body, /Co-Authored-By/);
    assert.match(skill.body, /omit|omiti/i);
    assert.match(skill.body, /Vault/);
    assert.match(skill.body, /--git-commit-hooks/);
  }
});

test('wk-verify present; wk-tdd/brainstorming carry TLC discipline; workflow cites verify --deep', () => {
  const by = Object.fromEntries(WK_SKILLS.map((s) => [s.name, s.body]));
  assert.ok(by['wk-verify'], 'wk-verify existe');
  assert.match(by['wk-verify'], /autor.*verificador|read-only|verdict/i);
  assert.match(by['wk-tdd'], /spec|adequa|raso|litmus/i);
  assert.match(by['wk-brainstorming'], /out-of-scope|assumption|closure|ambigu/i);
  assert.match(by['wk-workflow'], /verify --deep/);
});

test('[req:OP-4] [req:OP-5] wk-workflow routes by profile without a universal change mandate', () => {
  const cases = [
    {
      locale: 'pt-BR',
      keepCore: /Keep Core.*sempre ativo/i,
      governDefault: /GOVERN.*padr[aã]o|padr[aã]o.*GOVERN/i,
      nativeHarness: /harness nativo da LLM/i,
      oldUniversalGate: /Toda tarefa n[aã]o-trivial passa pelo loop/i,
      profileAware: /perfil efetivo/i,
    },
    {
      locale: 'en',
      keepCore: /Keep Core.*always active/i,
      governDefault: /GOVERN.*default|default.*GOVERN/i,
      nativeHarness: /native LLM harness|LLM's native harness/i,
      oldUniversalGate: /Every non-trivial task goes through the loop/i,
      profileAware: /effective profile/i,
    },
  ];

  for (const expected of cases) {
    const workflow = wkSkills(expected.locale).find((s) => s.name === 'wk-workflow');
    assert.ok(workflow, `${expected.locale}: workflow seed exists`);
    assert.match(workflow.body, expected.keepCore, `${expected.locale}: Keep Core remains active`);
    assert.match(workflow.body, expected.governDefault, `${expected.locale}: GOVERN is the default`);
    assert.match(workflow.body, expected.nativeHarness, `${expected.locale}: OFF delegates governance`);
    assert.match(workflow.body, expected.profileAware, `${expected.locale}: gate resolves the effective profile`);
    for (const profile of ['OFF', 'FLOW', 'GUIDE', 'GOVERN', 'ASSURE']) {
      assert.match(workflow.body, new RegExp(`\\b${profile}\\b`), `${expected.locale}: ${profile} route`);
    }
    assert.doesNotMatch(workflow.body, expected.oldUniversalGate,
      `${expected.locale}: no contradictory universal GOVERN mandate`);
    const description = (workflow.body.match(/^description:\s*(.+)$/m) || [])[1] || '';
    assert.match(description, expected.profileAware, `${expected.locale}: activation description is profile-aware`);
  }
});

test('[req:OP-13] wk-workflow ensina seleção adaptativa temporária sem permitir OFF', () => {
  for (const locale of ['pt-BR', 'en']) {
    const body = wkSkills(locale).find((skill) => skill.name === 'wk-workflow').body;
    assert.match(body, /wendkeep profile route <FLOW\|GUIDE\|GOVERN\|ASSURE>/);
    assert.match(body, /--session <id>.*--reason/s);
    assert.match(body, /tempor|request|solicita/i);
    assert.match(body, /OFF[\s\S]{0,180}(?:nunca|never|human|humana)/i);
    assert.match(body, /FLOW[\s\S]{0,240}(?:local|revers)/i);
    assert.match(body, /GUIDE[\s\S]{0,240}(?:compact|compacta)/i);
    assert.match(body, /GOVERN[\s\S]{0,240}(?:dúvida|uncertain|risk|risco)/i);
    assert.match(body, /ASSURE[\s\S]{0,240}(?:confirm|handoff)/i);
  }
});

// REQ-4 — o template do workflow documenta o formato de heading de requisito e
// o suporte a múltiplos [req:] por tarefa (pt e en).
test('wk-workflow teaches the requirement heading format and multi-[req:] support', () => {
  const wf = WK_SKILLS.find((s) => s.name === 'wk-workflow').body;
  assert.match(wf, /### Requisito: <ID> — <nome>/, 'pt: formato de heading com ID');
  assert.match(wf, /### Requisito: <ID>/, 'pt: forma com ID puro');
  assert.match(wf, /vários\s+.?\[req:|múltiplos\s+.?\[req:/i, 'pt: múltiplos [req:] por tarefa');
  assert.match(wf, /API-AUTH-2/, 'pt: exemplo multi-segmento');
});

test('wk-workflow EN variant teaches the same requirement-id contract', () => {
  const en = wkSkills('en').find((s) => s.name === 'wk-workflow');
  assert.ok(en, 'en seed exists');
  assert.match(en.body, /### Requirement: <ID> — <name>/, 'en: heading format');
  assert.match(en.body, /several\s+.?\[req:|multiple\s+.?\[req:/i, 'en: multiple [req:] per task');
});

// DRV-6 — convenção de notas derivadas: sem DIA, numeradas, criadas via `wendkeep note new`
test('derived-note convention: VAULT_COMPLEMENT_RULES and seeds teach note new + no-DIA', async () => {
  const { VAULT_COMPLEMENT_RULES } = await import('../hooks/obsidian-common.mjs');
  const rules = VAULT_COMPLEMENT_RULES.join('\n');
  assert.match(rules, /wendkeep note new/, 'regras injetadas citam o comando');
  assert.match(rules, /BUG-|APR-/, 'regras citam a numeração');
  assert.match(rules, /DIA/, 'regras proíbem a subpasta DIA explicitamente');

  // Asserts SEPARADOS por seed/idioma — concatenar mascararia um seed sem a convenção.
  const en = wkSkills('en');
  const wfPt = WK_SKILLS.find((s) => s.name === 'wk-workflow').body;
  const wfEn = en.find((s) => s.name === 'wk-workflow').body;
  const dbgPt = WK_SKILLS.find((s) => s.name === 'wk-debugging').body;
  const dbgEn = en.find((s) => s.name === 'wk-debugging').body;
  for (const [label, body] of [['wf pt', wfPt], ['wf en', wfEn], ['dbg pt', dbgPt], ['dbg en', dbgEn]]) {
    assert.match(body, /wendkeep note new/, `${label} ensina note new`);
    assert.match(body, /BUG-NNNN|BUG-\d{4}/, `${label} cita BUG-NNNN`);
    assert.match(body, /DIA/, `${label} menciona a regra sem-DIA`);
  }
});

test('wk-workflow references the wendkeep loop commands', () => {
  const wf = WK_SKILLS.find((s) => s.name === 'wk-workflow').body;
  assert.match(wf, /wendkeep change new/);
  assert.match(wf, /wendkeep verify/);
  assert.match(wf, /\[sensor:/);
  assert.match(wf, /spec_impact/);
  assert.match(wf, /CURRENT_CHANGE/);
  assert.match(wf, /várias changes|Multiple changes/i);
  assert.doesNotMatch(wf, /Uma mudança ativa por vez|One active change at a time/);
  assert.match(wf, /specs\/<capability>\/spec\.md|specs\/<capability>/);
});

test('skills carry bundled templates that their SKILL.md references', () => {
  const by = Object.fromEntries(WK_SKILLS.map((s) => [s.name, s]));
  // wk-verify bundles the reviewer prompt + verdict template, and points at both.
  const vfiles = (by['wk-verify'].files || []).map((f) => f.name).sort();
  assert.deepEqual(vfiles, ['spec-reviewer-prompt.md', 'verdict-template.json']);
  assert.match(by['wk-verify'].body, /spec-reviewer-prompt\.md/);
  assert.match(by['wk-verify'].body, /verdict-template\.json/);
  // planning + brainstorming each bundle their template and point at it.
  assert.deepEqual((by['wk-planning'].files || []).map((f) => f.name), ['plan-template.md']);
  assert.match(by['wk-planning'].body, /plan-template\.md/);
  assert.match(by['wk-planning'].body, /spec_impact/);
  assert.deepEqual((by['wk-brainstorming'].files || []).map((f) => f.name), ['design-template.md']);
  assert.match(by['wk-brainstorming'].body, /design-template\.md/);
  // the verdict template is valid JSON with the gate-relevant fields.
  const verdict = JSON.parse((by['wk-verify'].files.find((f) => f.name === 'verdict-template.json')).content);
  for (const k of ['slug', 'ok', 'coverage', 'tasksHash', 'effectiveSpecHash', 'evidenceEnvelopeId', 'evidenceBinding']) {
    assert.ok(k in verdict, `verdict has ${k}`);
  }
});

test('[req:COMMIT-25] wk-commit preserva ADR causal e limita fallback nativo a issue + design', () => {
  for (const localeId of ['pt-BR', 'en']) {
    const body = wkSkills(localeId).find((skill) => skill.name === 'wk-commit').body;
    assert.match(body, /authority\.kind.*adr/i);
    assert.match(body, /authority\.kind.*native/i);
    assert.match(body, /observed profile[\s\S]*OFF|perfil observado[\s\S]*OFF/i);
    assert.match(body, /context|contexto/i);
    assert.match(body, /docs\/superpowers\/specs|plans\//);
  }
});

test('seedWkSkills: writes each SKILL.md + bundled templates, non-destructive', () => {
  const brain = mkdtempSync(join(tmpdir(), 'wk-skills-'));
  try {
    const created = seedWkSkills(brain);
    // 6 SKILL.md + 4 template files (verify:2, planning:1, brainstorming:1).
    assert.equal(created.length, WK_SKILLS.length + 4);
    assert.ok(existsSync(join(brain, 'skills', 'wk-workflow', 'SKILL.md')));
    assert.ok(existsSync(join(brain, 'skills', 'wk-verify', 'spec-reviewer-prompt.md')));
    assert.ok(existsSync(join(brain, 'skills', 'wk-verify', 'verdict-template.json')));
    assert.ok(existsSync(join(brain, 'skills', 'wk-planning', 'plan-template.md')));
    assert.ok(existsSync(join(brain, 'skills', 'wk-brainstorming', 'design-template.md')));

    const before = readFileSync(join(brain, 'skills', 'wk-verify', 'spec-reviewer-prompt.md'), 'utf8');
    assert.equal(seedWkSkills(brain).length, 0); // non-destructive
    assert.equal(readFileSync(join(brain, 'skills', 'wk-verify', 'spec-reviewer-prompt.md'), 'utf8'), before);
  } finally { rmSync(brain, { recursive: true, force: true }); }
});

// --- 0.31.0: ativação da skill (paridade Superpowers) --------------------------

test('wk-workflow: description com gatilhos concretos + "antes de editar"; HARD-GATE no corpo (pt+en)', () => {
  for (const localeId of ['pt-BR', 'en']) {
    const wf = wkSkills(localeId).find((s) => s.name === 'wk-workflow');
    assert.match(wf.body, /<HARD-GATE>/, `${localeId}: HARD-GATE presente`);
    const desc = (wf.body.match(/^description:\s*(.+)$/m) || [])[1];
    assert.match(desc, /implement/i, `${localeId}: gatilho implementar`);
    assert.match(desc, /refator|refactor/i, `${localeId}: gatilho refatorar`);
    assert.match(desc, /ANTES de editar|BEFORE editing/i, `${localeId}: imperativo pré-edição`);
  }
});

test('seedWkSkills refresh: sobrescreve SKILL.md existente (re-seed de vault antigo)', () => {
  const brain = mkdtempSync(join(tmpdir(), 'wk-reseed-'));
  try {
    seedWkSkills(brain);
    const f = join(brain, 'skills', 'wk-workflow', 'SKILL.md');
    // simula a skill de uma versão antiga (conteúdo divergente)
    writeFileSync(f, '---\nname: wk-workflow\ndescription: velha\n---\ncorpo velho\n', 'utf8');
    assert.equal(seedWkSkills(brain).length, 0, 'sem refresh não sobrescreve');
    const n = seedWkSkills(brain, 'pt-BR', { refresh: true });
    assert.ok(n.length > 0, 'refresh reescreve');
    assert.match(readFileSync(f, 'utf8'), /<HARD-GATE>/, 'conteúdo novo no lugar');
  } finally { rmSync(brain, { recursive: true, force: true }); }
});
