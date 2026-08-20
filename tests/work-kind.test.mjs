import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyWorkRequest, createWorkRoute, normalizeWorkKind,
} from '../src/work-kind.mjs';

test('work kinds são independentes do perfil e do impacto de contrato', () => {
  assert.deepEqual(createWorkRoute({
    workKind: 'delivery',
    profile: 'ASSURE',
    contractImpact: 'none',
    operationRisk: ['git:merge', 'git:push', 'publish', 'publish'],
    sourceChange: 'observer-sql-authority',
    sourceCommit: 'abc123',
  }), {
    work_kind: 'delivery',
    profile: 'ASSURE',
    contract_impact: 'none',
    operation_risk: ['git:merge', 'git:push', 'publish'],
    source_change: 'observer-sql-authority',
    source_commit: 'abc123',
  });
  assert.throws(
    () => createWorkRoute({ workKind: 'delivery', contractImpact: 'public' }),
    (error) => error.code === 'WENDKEEP_DELIVERY_CONTRACT_IMPACT',
  );
  assert.equal(normalizeWorkKind('Recovery'), 'recovery');
});

test('matriz mínima separa inspection, delivery, recovery e implementation', () => {
  const cases = new Map([
    ['Faça merge e publique no npm', 'delivery'],
    ['Crie a tag da versão já validada', 'delivery'],
    ['Acompanhe o Actions', 'inspection'],
    ['Corrija o workflow de release', 'implementation'],
    ['O publish falhou por token expirado', 'recovery'],
    ['O package.json está errado', 'implementation'],
  ]);
  for (const [prompt, expected] of cases) assert.equal(classifyWorkRequest(prompt), expected, prompt);
});
