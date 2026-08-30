import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCommitInput,
  prepareCommitMessage,
  renderCommitMessage,
  validateCommitMessage,
} from '../packages/commit/src/index.mjs';

function validInput(overrides = {}) {
  return {
    schema_version: 1,
    subject: {
      type: 'feat',
      scope: 'commit',
      summary: 'adiciona política universal de commits',
    },
    capability: 'Commit universal baseado em evidências verificadas.',
    authority: { kind: 'adr', adr: 'ADR-1234', ref: 'docs/ADR-1234.md', issue: '#123' },
    staged_diff: {
      sha256: 'a'.repeat(64),
      files: ['tests/commit-message.test.mjs', 'packages/commit/src/index.mjs'],
    },
    evidence: [
      { kind: 'adr', ref: 'docs/ADR-1234.md', status: 'verified' },
      { kind: 'task', ref: 'plans/tasks.md', status: 'verified' },
    ],
    tasks: ['1.2 Implementar render determinístico', '1.1 Normalizar entrada tipada'],
    tests: ['node --test tests/commit-message.test.mjs'],
    limits: ['Sem publicação ou push automático.'],
    identity: {
      agent: 'Codex',
    },
    ...overrides,
  };
}

test('[req:COMMIT-1] normalização canônica torna a mensagem independente da ordem de entrada', () => {
  const one = validInput();
  const two = validInput({
    staged_diff: {
      sha256: 'a'.repeat(64),
      files: [...one.staged_diff.files].reverse(),
    },
    evidence: [...one.evidence].reverse(),
    tasks: [...one.tasks].reverse(),
  });

  assert.deepEqual(normalizeCommitInput(one, { resolved: true }), normalizeCommitInput(two, { resolved: true }));
  assert.equal(renderCommitMessage(one), renderCommitMessage(two));
  assert.equal(
    renderCommitMessage(validInput({ identity: { agent: 'Codex' } })),
    renderCommitMessage(validInput({ identity: { agent: 'Claude Code' } })),
    'a identidade do harness não muda prova nem mensagem quando não há coautoria factual',
  );
});

test('[req:COMMIT-2] mensagem contém somente prova resolvida e referência causal', () => {
  const message = renderCommitMessage(validInput());

  assert.match(message, /^feat\(commit\): adiciona política universal de commits \(ADR-1234\)$/m);
  assert.match(message, /^Capability:\n- Commit universal baseado em evidências verificadas\.$/m);
  assert.match(message, /^Evidence:\n- \[verified\] adr: docs\/ADR-1234\.md\n- \[verified\] task: plans\/tasks\.md$/m);
  assert.match(message, /^Tasks:\n- 1\.1 Normalizar entrada tipada\n- 1\.2 Implementar render determinístico$/m);
  assert.match(message, /^Tests:\n- node --test tests\/commit-message\.test\.mjs$/m);
  assert.match(message, /^Scope:\n- packages\/commit\/src\/index\.mjs\n- tests\/commit-message\.test\.mjs\n- staged-diff-sha256: a{64}$/m);
  assert.match(message, /^Limits:\n- Sem publicação ou push automático\.$/m);
  assert.match(message, /^WendKeep-Commit: v1$/m);
  assert.match(message, /^Remote-Proof-Scope: git,authority,tasks,spec,sensors$/m);
  assert.match(message, /^Local-Causal-Proof: unpublished$/m);
  assert.match(message, /^ADR: ADR-1234$/m);
  assert.match(message, /^Refs: #123$/m);
  assert.doesNotMatch(message, /^Co-Authored-By:/m);
  assert.equal(validateCommitMessage(message).ok, true);
});

test('[req:COMMIT-3] policy rejeita prova não verificável, coautoria presumida e conteúdo privado', () => {
  const mutations = [
    validInput({ evidence: [{ kind: 'receipt', ref: 'receipt.json', status: 'reported' }] }),
    validInput({ identity: { agent: 'Codex', co_authors: [{ name: 'Claude', email: 'noreply@example.invalid', factual: false }] } }),
    validInput({ staged_diff: { sha256: 'b'.repeat(64), files: ['.WendKeep-vault/.brain/SESSION_REGISTRY.json'] } }),
    validInput({ evidence: [{ kind: 'task', ref: 'token=ghp_12345678901234567890', status: 'fresh' }] }),
    validInput({ tasks: ['arquivo em C:\\Users\\Roger\\segredo.txt'] }),
    validInput({ tasks: ['CPF 123.456.789-09'] }),
    validInput({ tasks: ['contato pessoa@example.com'] }),
    validInput({ tasks: ['telefone (11) 99876-5432'] }),
  ];

  for (const mutated of mutations) {
    assert.throws(() => normalizeCommitInput(mutated, { resolved: true }), { name: 'CommitPolicyError' });
  }
  assert.throws(
    () => normalizeCommitInput(validInput({ vault_dump: 'conteúdo livre não tipado' })),
    /unsupported field/i,
  );
});

test('[req:COMMIT-4] validator rejeita mensagem governada incompleta e segredo mesmo com trailer', () => {
  const valid = renderCommitMessage(validInput());
  const missingEvidence = valid.replace(/Evidence:\n(?:- .*\n)+\n/, '');
  const fakeSecret = valid.replace('Sem publicação ou push automático.', 'Authorization: Bearer abcdefghijklmnop');
  const reported = valid.replace('[verified]', '[reported]');
  const localOverclaim = valid.replace('[verified] task:', '[fresh] verdict:');

  const incomplete = validateCommitMessage(missingEvidence);
  assert.equal(incomplete.ok, false);
  assert.ok(incomplete.errors.some((error) => /Evidence/.test(error)));

  const secret = validateCommitMessage(fakeSecret);
  assert.equal(secret.ok, false);
  assert.ok(secret.errors.some((error) => /secret|segredo/i.test(error)));

  const unproven = validateCommitMessage(reported);
  assert.equal(unproven.ok, false);
  assert.ok(unproven.errors.some((error) => /fresh|verified/i.test(error)));
  assert.equal(validateCommitMessage(localOverclaim).ok, false);
});

test('[req:COMMIT-5] schema recusa versões desconhecidas e assunto fora de Conventional Commits', () => {
  assert.throws(() => normalizeCommitInput(validInput({ schema_version: 2 }), { resolved: true }), /schema_version/i);
  assert.throws(() => normalizeCommitInput(validInput({ subject: { type: 'feature', summary: 'x' } }), { resolved: true }), /subject\.type/i);
});

test('[req:COMMIT-19] prepare é idempotente e preserva fontes amend, merge e squash', () => {
  const generated = renderCommitMessage(validInput());
  assert.equal(prepareCommitMessage(generated, validInput()), generated);
  for (const source of ['commit', 'merge', 'squash']) {
    const existing = `${source}: mensagem existente\n`;
    assert.equal(prepareCommitMessage(existing, validInput(), { source }), existing);
  }
});

test('[req:COMMIT-22] autoridade nativa exige issue, design versionado e ausência causal explícita', () => {
  const input = validInput();
  input.authority = {
    kind: 'native',
    issue: '#40',
    design: 'docs/superpowers/specs/2026-08-29-wendkeep-control-plane-finalization-design.md',
  };
  const message = renderCommitMessage(input);
  assert.match(message, /^feat\(commit\): adiciona política universal de commits \(#40\)$/m);
  assert.match(message, /^Authority: native-no-causal-change$/m);
  assert.match(message, /^Issue: #40$/m);
  assert.match(message, /^Design: docs\/superpowers\/specs\/2026-08-29-wendkeep-control-plane-finalization-design\.md$/m);
  assert.equal(validateCommitMessage(message).ok, true);

  for (const authority of [
    { ...input.authority, causal_change: false },
    { ...input.authority, adr_available: false },
    { ...input.authority, issue: 'texto livre' },
    { ...input.authority, design: 'qualquer-nota.md' },
    { ...input.authority, design: 'docs/superpowers/specs/../../../README.md' },
  ]) {
    assert.throws(() => normalizeCommitInput({ ...input, authority }, { resolved: true }), { name: 'CommitPolicyError' });
  }
});

test('[req:COMMIT-33] feat breaking e trailers causais duplicados falham fechados', () => {
  const valid = renderCommitMessage(validInput());
  const breaking = valid.replace(/^feat\(commit\):/, 'feat(commit)!:');
  assert.equal(validateCommitMessage(breaking).governed, true);
  assert.equal(validateCommitMessage(breaking).ok, false);
  for (const duplicate of [
    `${valid}ADR: ADR-1234\n`,
    valid.replace('Refs: #123', 'Refs: #123\nRefs: #456'),
    valid.replace('- [verified] task: plans/tasks.md', '- [verified] task: plans/tasks.md\n- [verified] task: plans/tasks.md'),
    valid.replace('Remote-Proof-Scope:', 'Remote-Proof-Scope: git,authority,tasks,spec,sensors\nRemote-Proof-Scope:'),
    valid.replace('Local-Causal-Proof:', 'Local-Causal-Proof: unpublished\nLocal-Causal-Proof:'),
  ]) assert.equal(validateCommitMessage(duplicate).ok, false);
  assert.equal(validateCommitMessage(`${valid}Co-Authored-By: Pessoa <pessoa@example.com>\n`).ok, false);

  const nativeInput = validInput();
  nativeInput.authority = {
    kind: 'native', issue: '#40', design: 'docs/superpowers/specs/2026-08-29-wendkeep-control-plane-finalization-design.md',
  };
  const native = renderCommitMessage(nativeInput);
  for (const duplicate of [
    native.replace('Issue: #40', 'Issue: #40\nIssue: #41'),
    native.replace(/^Design: (.+)$/m, 'Design: $1\nDesign: plans/outro.md'),
    native.replace('Authority: native-no-causal-change', 'Authority: native-no-causal-change\nAuthority: native-no-causal-change'),
  ]) assert.equal(validateCommitMessage(duplicate).ok, false);
});

test('[req:COMMIT-39] privacidade também vale para commits objetivamente triviais', () => {
  for (const message of [
    'docs: contate pessoa@example.com',
    'test: cobre CPF 123.456.789-00',
    'chore: consulte C:\\segredo\\vault',
  ]) assert.equal(validateCommitMessage(message).ok, false);
});

test('[req:COMMIT-41] draft do caller não aceita claims textuais de tasks ou tests', () => {
  const input = validInput();
  input.evidence = input.evidence.map(({ kind, ref }) => ({ kind, ref }));
  assert.throws(() => normalizeCommitInput(input), /unsupported field.*tasks|unsupported field.*tests/i);
  const withoutTasks = { ...input };
  delete withoutTasks.tasks;
  delete withoutTasks.tests;
  assert.doesNotThrow(() => normalizeCommitInput(withoutTasks));
});
