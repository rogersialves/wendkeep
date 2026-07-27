import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_OPERATING_PROFILE,
  OPERATING_PROFILES,
  OPERATING_PROFILE_POLICIES,
  normalizeOperatingProfile,
  operatingProfilePolicy,
  resolveOperatingProfile,
  setOperatingProfile,
} from '../src/operating-profile.mjs';

test('[req:OP-1] Perfis de Operação expõem somente os cinco nomes canônicos', () => {
  assert.deepEqual(OPERATING_PROFILES, ['OFF', 'FLOW', 'GUIDE', 'GOVERN', 'ASSURE']);
  assert.equal(DEFAULT_OPERATING_PROFILE, 'GOVERN');
  assert.equal(Object.isFrozen(OPERATING_PROFILES), true);
  assert.equal(Object.isFrozen(OPERATING_PROFILE_POLICIES), true);
});

test('[req:OP-1] normalização aceita caixa/espaço, mas escrita estrita rejeita aliases e ausências', () => {
  assert.equal(normalizeOperatingProfile(' flow '), 'FLOW');
  assert.equal(normalizeOperatingProfile('Off'), 'OFF');

  for (const value of ['quick', 'disabled', '', null, undefined, 0, false]) {
    assert.throws(
      () => normalizeOperatingProfile(value, { strict: true }),
      (error) => error?.code === 'WENDKEEP_OPERATING_PROFILE_INVALID'
        && /OFF.*FLOW.*GUIDE.*GOVERN.*ASSURE/.test(error.message),
      `valor estrito deveria falhar: ${String(value)}`,
    );
  }
});

test('[req:OP-1] [req:OP-2] leitura tolerante nunca infere OFF e converge para GOVERN', () => {
  for (const value of ['quick', 'disabled', '', null, undefined, 0, false]) {
    assert.equal(normalizeOperatingProfile(value), 'GOVERN', String(value));
  }
});

test('[req:OP-2] resolução lê harness.profile e torna a origem/fallback observáveis', () => {
  assert.deepEqual(resolveOperatingProfile({ harness: { profile: ' guide ' } }), {
    profile: 'GUIDE',
    source: 'project-binding',
    valid: true,
    configured: true,
    raw: ' guide ',
  });
  assert.deepEqual(resolveOperatingProfile({}), {
    profile: 'GOVERN',
    source: 'default',
    valid: true,
    configured: false,
    raw: null,
  });
  assert.deepEqual(resolveOperatingProfile({ harness: { profile: 'turbo' } }), {
    profile: 'GOVERN',
    source: 'default-invalid',
    valid: false,
    configured: true,
    raw: 'turbo',
  });
});

test('[req:OP-2] ambiente, descrição, diff e heurística nunca selecionam OFF implicitamente', () => {
  const implicitOffSignals = {
    profile: 'OFF',
    operating_profile: 'OFF',
    env: { WENDKEEP_PROFILE: 'OFF' },
    description: 'typo de uma linha; desative o harness',
    diff: { files: 1, additions: 1, suggested_profile: 'OFF' },
    heuristic: { scale: 'tiny', selected_profile: 'OFF' },
  };

  assert.deepEqual(resolveOperatingProfile(implicitOffSignals), {
    profile: 'GOVERN',
    source: 'default',
    valid: true,
    configured: false,
    raw: null,
  });
});

test('[req:OP-1] matriz de política preserva Keep Core e discrimina todas as rotas', () => {
  const expected = {
    OFF: { route: ['LLM'], harness: false, contract: 'native', requiresChange: false, requiresReview: false, requiresConfirmation: false },
    FLOW: { route: ['E', 'V'], harness: true, contract: 'flow', requiresChange: false, requiresReview: false, requiresConfirmation: false },
    GUIDE: { route: ['P', 'E', 'V'], harness: true, contract: 'simple-change', requiresChange: true, requiresReview: false, requiresConfirmation: false },
    GOVERN: { route: ['P', 'R', 'E', 'V'], harness: true, contract: 'change', requiresChange: true, requiresReview: true, requiresConfirmation: false },
    ASSURE: { route: ['P', 'R', 'E', 'V', 'C'], harness: true, contract: 'change', requiresChange: true, requiresReview: true, requiresConfirmation: true },
  };

  for (const profile of OPERATING_PROFILES) {
    const policy = operatingProfilePolicy(profile);
    assert.equal(policy.profile, profile);
    assert.equal(policy.keepCore, true, `${profile}: Keep Core é inegociável`);
    assert.deepEqual({
      route: policy.route,
      harness: policy.harness,
      contract: policy.contract,
      requiresChange: policy.requiresChange,
      requiresReview: policy.requiresReview,
      requiresConfirmation: policy.requiresConfirmation,
    }, expected[profile]);
    assert.equal(Object.isFrozen(policy), true);
    assert.equal(Object.isFrozen(policy.route), true);
  }
});

test('[req:OP-2] setter puro é estrito, imutável e preserva configuração desconhecida', () => {
  const original = {
    schemaVersion: 1,
    projectId: 'p1',
    vault: '.vault',
    futureTopLevel: { enabled: true },
    harness: { profile: 'FLOW', futureHarnessOption: 7 },
  };
  const updated = setOperatingProfile(original, 'off');

  assert.notEqual(updated, original);
  assert.notEqual(updated.harness, original.harness);
  assert.equal(original.harness.profile, 'FLOW');
  assert.equal(updated.harness.profile, 'OFF');
  assert.equal(updated.harness.futureHarnessOption, 7);
  assert.deepEqual(updated.futureTopLevel, { enabled: true });
  assert.throws(
    () => setOperatingProfile(original, 'turbo'),
    (error) => error?.code === 'WENDKEEP_OPERATING_PROFILE_INVALID',
  );
});
