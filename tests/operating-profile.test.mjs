import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ADAPTIVE_OPERATING_PROFILES,
  DEFAULT_OPERATING_PROFILE,
  OPERATING_PROFILES,
  OPERATING_PROFILE_POLICIES,
  createTaskOperatingProfileLease,
  evaluateTaskOperatingProfileLease,
  normalizeOperatingProfile,
  operatingProfilePolicy,
  resolveOperatingProfile,
  setOperatingProfile,
} from '../src/operating-profile.mjs';

test('[req:OP-11] seleção adaptativa aceita quatro rotas e nunca aceita OFF', () => {
  assert.deepEqual(ADAPTIVE_OPERATING_PROFILES, ['FLOW', 'GUIDE', 'GOVERN', 'ASSURE']);
  assert.equal(Object.isFrozen(ADAPTIVE_OPERATING_PROFILES), true);

  for (const profile of ADAPTIVE_OPERATING_PROFILES) {
    const lease = createTaskOperatingProfileLease({
      profile,
      reason: 'implementação classificada pelo harness',
      sessionId: 'session-1',
      turnId: 'turn-7',
      turnSequence: 7,
      leaseId: `lease-${profile.toLowerCase()}`,
      issuedAt: '2026-08-01T17:00:00.000Z',
    });
    assert.equal(lease.profile, profile);
    assert.equal(lease.state, 'active');
    assert.equal(lease.requested_by, 'llm-harness');
    assert.equal(lease.request_turn_id, 'turn-7');
    assert.equal(lease.request_turn_sequence, 7);
    assert.equal(lease.expires_on, 'request-stop');
  }

  for (const profile of ['OFF', 'AUTO', '', null]) {
    assert.throws(
      () => createTaskOperatingProfileLease({
        profile,
        reason: 'não deve persistir',
        sessionId: 'session-1',
        turnSequence: 7,
        leaseId: 'lease-rejected',
        issuedAt: '2026-08-01T17:00:00.000Z',
      }),
      (error) => error?.code === 'WENDKEEP_TASK_PROFILE_INVALID',
    );
  }
});

test('[req:OP-11] lease exige motivo auditável e identidade causal completa', () => {
  const base = {
    profile: 'FLOW', sessionId: 'session-1', turnId: 'turn-1', turnSequence: 1,
    leaseId: 'lease-1', issuedAt: '2026-08-01T17:00:00.000Z',
  };
  for (const reason of ['', '   ', 'x'.repeat(501)]) {
    assert.throws(
      () => createTaskOperatingProfileLease({ ...base, reason }),
      (error) => error?.code === 'WENDKEEP_TASK_PROFILE_REASON_INVALID',
    );
  }
  for (const invalid of [
    { ...base, reason: 'ok', sessionId: '' },
    { ...base, reason: 'ok', turnId: '' },
    { ...base, reason: 'ok', turnSequence: undefined },
    { ...base, reason: 'ok', turnSequence: -1 },
    { ...base, reason: 'ok', turnSequence: 0 },
    { ...base, reason: 'ok', leaseId: '' },
    { ...base, reason: 'ok', issuedAt: '' },
  ]) {
    assert.throws(
      () => createTaskOperatingProfileLease(invalid),
      (error) => error?.code === 'WENDKEEP_TASK_PROFILE_CONTEXT_INVALID',
    );
  }
});

test('[req:OP-12] avaliação causal distingue active, expired, consumed e invalid', () => {
  const lease = createTaskOperatingProfileLease({
    profile: 'GUIDE',
    reason: 'change compacta',
    sessionId: 'session-1',
    turnId: 'turn-3',
    turnSequence: 3,
    leaseId: 'lease-guide',
    issuedAt: '2026-08-01T17:00:00.000Z',
  });

  assert.equal(evaluateTaskOperatingProfileLease(lease, {
    sessionId: 'session-1', turnId: 'turn-3', turnSequence: 3,
  }).state, 'active');
  assert.equal(evaluateTaskOperatingProfileLease(lease, {
    sessionId: 'session-1', turnSequence: 3,
  }).state, 'invalid', 'sem o turnId atual não há identidade causal suficiente');
  assert.equal(evaluateTaskOperatingProfileLease(lease, {
    sessionId: 'session-1', turnId: 'turn-4', turnSequence: 4,
  }).state, 'expired');
  assert.equal(evaluateTaskOperatingProfileLease({
    ...lease, state: 'consumed', consumed_at: '2026-08-01T17:10:00.000Z',
  }, { sessionId: 'session-1', turnId: 'turn-3', turnSequence: 3 }).state, 'consumed');
  assert.equal(evaluateTaskOperatingProfileLease({ ...lease, profile: 'OFF' }, {
    sessionId: 'session-1', turnId: 'turn-3', turnSequence: 3,
  }).state, 'invalid');
  assert.equal(evaluateTaskOperatingProfileLease(null, {
    sessionId: 'session-1', turnId: 'turn-3', turnSequence: 3,
  }).state, 'absent');
});

test('[req:OP-12] lease é isolada por sessão e nunca expira por relógio', () => {
  const lease = createTaskOperatingProfileLease({
    profile: 'FLOW',
    reason: 'ajuste local ligado ao prompt',
    sessionId: 'session-origin',
    turnId: 'turn-1',
    turnSequence: 1,
    leaseId: 'lease-causal-only',
    issuedAt: '2000-01-01T00:00:00.000Z',
  });

  assert.deepEqual(
    Object.keys(lease).filter((key) => /expires|ttl|deadline/i.test(key)),
    ['expires_on'],
    'a lease só declara o evento causal de expiração, sem deadline/TTL',
  );
  assert.equal(evaluateTaskOperatingProfileLease(lease, {
    sessionId: 'session-origin',
    turnId: 'turn-1',
    turnSequence: 1,
    now: '2099-12-31T23:59:59.999Z',
  }).state, 'active', 'tempo de parede não expira uma solicitação ainda causalmente ativa');
  assert.equal(evaluateTaskOperatingProfileLease(lease, {
    sessionId: 'session-other',
    turnId: 'turn-1',
    turnSequence: 1,
  }).state, 'invalid', 'uma sessão diferente nunca herda a lease');
});

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
