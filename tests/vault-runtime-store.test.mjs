import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendFlowAttempt,
  createFlowContract,
  findActiveFlow,
  findFlow,
  flowDir,
  listFlows,
  readFlow,
  reserveFlowPromotion,
  writeFlowPromotion,
  writeFlowReceipt,
  withFlowPromotionLock,
} from '../hooks/vault-runtime-store.mjs';

const contract = (flowId, sessionId = 'session-1') => ({
  schema_version: 1,
  flow_id: flowId,
  session_id: sessionId,
  session_file: '02-Sessões/2026/07-JUL/DIA 26/flow.md',
  slug: `slug-${flowId}`,
  profile: 'FLOW',
  started_at: '2026-07-26T12:00:00.000Z',
  reason: 'ajuste localizado',
  spec_impact: 'none',
  project_rel: '.',
  protected_roots: [],
  allowed_paths: ['src/a.mjs'],
  sensor_ids: ['tests'],
  sensor_definition_hash: 'definition-hash',
  baseline: {
    schema_version: 1,
    root: 'C:/repo',
    head: 'abc',
    fingerprints: {},
    git_metadata_fingerprint: 'a'.repeat(64),
    hidden_index_paths: [],
    unsafe_git_metadata_paths: [],
    unsafe_worktree_paths: [],
  },
});

const promotionReservation = (flowContract) => ({
  schema_version: 1,
  flow_id: flowContract.flow_id,
  status: 'promoting',
  reserved_at: '2026-07-26T12:02:00.000Z',
  change_slug: 'normal-change',
  change_rel: '08-Mudanças/normal-change',
  origin: {
    schema_version: 1,
    flow_id: flowContract.flow_id,
    promoted_at: '2026-07-26T12:02:00.000Z',
    contract: flowContract,
    attempts: [],
    observed_git: {
      baseline_head: 'abc',
      current_head: 'abc',
      head_changed: false,
      changed_paths: ['src/a.mjs'],
    },
  },
});

const terminalPromotion = (flowId = 'flow-1') => ({
  schema_version: 1,
  flow_id: flowId,
  status: 'promoted',
  promoted_at: '2026-07-26T12:02:00.000Z',
  change_slug: 'normal-change',
  change_rel: '08-Mudanças/normal-change',
  origin_file: '08-Mudanças/normal-change/flow-origin.json',
  changed_paths: ['src/a.mjs'],
  baseline_head: 'abc',
  current_head: 'abc',
});

const finishedReceipt = (flowId = 'flow-1') => ({
  schema_version: 1,
  flow_id: flowId,
  status: 'finished',
  finished_at: '2026-07-26T12:02:00.000Z',
  reason: 'ajuste localizado',
  allowed_paths: ['src/a.mjs'],
  sensor_ids: ['tests'],
  changed_paths: ['src/a.mjs'],
  evidence: [{
    id: 'tests', status: 'green', ts: '2026-07-26T12:02:00.000Z', severity: 'critical',
  }],
  baseline_head: 'abc',
  final_head: 'abc',
});

test('[req:OP-6] store admite um FLOW ativo por sessão e mantém sessões independentes', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-'));
  try {
    const first = createFlowContract(vault, contract('flow-1'));
    assert.equal(first.created, true);
    assert.equal(findActiveFlow(vault, 'session-1').contract.flow_id, 'flow-1');
    assert.throws(() => createFlowContract(vault, contract('flow-2')), /FLOW ativo.*session-1/i);

    createFlowContract(vault, contract('flow-2', 'session-2'));
    assert.deepEqual(listFlows(vault).map((item) => item.contract.flow_id).sort(), ['flow-1', 'flow-2']);
    assert.equal(findFlow(vault, 'flow-2').contract.session_id, 'session-2');
    assert.equal(existsSync(join(vault, '.brain', 'MEMORY_EVENTS.jsonl')), false);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OP-6] tentativas são duráveis e recibo terminal é idempotente e imutável', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-'));
  try {
    createFlowContract(vault, contract('flow-1'));
    appendFlowAttempt(vault, 'session-1', 'flow-1', {
      schema_version: 1,
      attempt_id: 'attempt-1',
      status: 'red',
      recorded_at: '2026-07-26T12:01:00.000Z',
      failures: ['sensor vermelho'],
      changed_paths: ['src/a.mjs'],
      evidence: [{ id: 'tests', status: 'red', ts: '2026-07-26T12:01:00.000Z', severity: 'critical' }],
    });
    const receipt = {
      schema_version: 1, flow_id: 'flow-1', status: 'finished', finished_at: '2026-07-26T12:02:00.000Z',
      reason: 'ajuste localizado',
      allowed_paths: ['src/a.mjs'],
      sensor_ids: ['tests'],
      changed_paths: ['src/a.mjs'],
      evidence: [{ id: 'tests', status: 'green', ts: '2026-07-26T12:02:00.000Z', severity: 'critical' }],
      baseline_head: 'abc',
      final_head: 'abc',
    };
    assert.equal(writeFlowReceipt(vault, 'session-1', 'flow-1', receipt).created, true);
    assert.equal(writeFlowReceipt(vault, 'session-1', 'flow-1', receipt).created, false);

    const state = readFlow(vault, { sessionId: 'session-1', flowId: 'flow-1' });
    assert.equal(state.state, 'finished');
    assert.equal(state.attempts.length, 1);
    assert.equal(findActiveFlow(vault, 'session-1'), null);
    assert.throws(() => writeFlowReceipt(vault, 'session-1', 'flow-1', { ...receipt, status: 'other' }), /inválido|imutável/i);
    assert.throws(() => writeFlowPromotion(vault, 'session-1', 'flow-1', { flow_id: 'flow-1' }), /já finalizado/i);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OP-7] promoção é terminal alternativo e preserva seu payload', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-'));
  try {
    const flowContract = contract('flow-1');
    createFlowContract(vault, flowContract);
    reserveFlowPromotion(vault, 'session-1', 'flow-1', {
      schema_version: 1,
      flow_id: 'flow-1',
      status: 'promoting',
      reserved_at: '2026-07-26T12:02:00.000Z',
      change_slug: 'normal-change',
      change_rel: '08-Mudanças/normal-change',
      origin: {
        schema_version: 1,
        flow_id: 'flow-1',
        promoted_at: '2026-07-26T12:02:00.000Z',
        contract: flowContract,
        attempts: [],
        observed_git: {
          baseline_head: 'abc',
          current_head: 'abc',
          head_changed: false,
          changed_paths: ['src/a.mjs'],
        },
      },
    });
    const promotion = {
      schema_version: 1,
      flow_id: 'flow-1',
      status: 'promoted',
      promoted_at: '2026-07-26T12:02:00.000Z',
      change_slug: 'normal-change',
      change_rel: '08-Mudanças/normal-change',
      origin_file: '08-Mudanças/normal-change/flow-origin.json',
      changed_paths: ['src/a.mjs'],
      baseline_head: 'abc',
      current_head: 'abc',
    };
    writeFlowPromotion(vault, 'session-1', 'flow-1', promotion);
    const state = readFlow(vault, { sessionId: 'session-1', flowId: 'flow-1' });
    assert.equal(state.state, 'promoted');
    assert.deepEqual(state.promotion.changed_paths, ['src/a.mjs']);
    assert.throws(() => writeFlowReceipt(vault, 'session-1', 'flow-1', { flow_id: 'flow-1' }), /já promovido/i);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OP-7] promoção aceita crescimento canônico fora da allowlist sem enfraquecer o contrato', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-scope-growth-'));
  try {
    const flowContract = contract('flow-1');
    createFlowContract(vault, flowContract);
    const base = promotionReservation(flowContract);
    const reservation = {
      ...base,
      origin: {
        ...base.origin,
        observed_git: {
          ...base.origin.observed_git,
          changed_paths: ['outside.mjs', 'src/a.mjs'],
        },
      },
    };

    assert.equal(
      reserveFlowPromotion(vault, 'session-1', 'flow-1', reservation).created,
      true,
    );
    assert.deepEqual(
      readFlow(vault, { sessionId: 'session-1', flowId: 'flow-1' }).reservation.origin.observed_git.changed_paths,
      ['outside.mjs', 'src/a.mjs'],
    );

    writeFlowPromotion(vault, 'session-1', 'flow-1', {
      ...terminalPromotion(),
      changed_paths: ['outside.mjs', 'src/a.mjs'],
    });
    const promoted = readFlow(vault, { sessionId: 'session-1', flowId: 'flow-1' });
    assert.equal(promoted.state, 'promoted');
    assert.deepEqual(promoted.promotion.changed_paths, ['outside.mjs', 'src/a.mjs']);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OP-6] store falha fechado quando contrato persistido está corrompido', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-'));
  try {
    const dir = flowDir(vault, 'session-1', 'flow-1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'contract.json'), '{broken');
    assert.throws(() => readFlow(vault, { sessionId: 'session-1', flowId: 'flow-1' }), /corrompido/i);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OP-7] store falha fechado para artefato terminal semanticamente inconsistente', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-'));
  try {
    createFlowContract(vault, contract('flow-1'));
    const dir = flowDir(vault, 'session-1', 'flow-1');
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify({
      schema_version: 1,
      flow_id: 'outro-flow',
      status: 'finished',
      finished_at: '2026-07-26T12:02:00.000Z',
    }));
    assert.throws(() => readFlow(vault, { sessionId: 'session-1', flowId: 'flow-1' }), /recibo FLOW inválido/i);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OP-7] JSON null nunca reabre nem permite sobrescrever um FLOW terminal', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-'));
  try {
    createFlowContract(vault, contract('flow-1'));
    const receipt = {
      schema_version: 1,
      flow_id: 'flow-1',
      status: 'finished',
      finished_at: '2026-07-26T12:02:00.000Z',
      reason: 'ajuste localizado',
      allowed_paths: ['src/a.mjs'],
      sensor_ids: ['tests'],
      changed_paths: ['src/a.mjs'],
      evidence: [{ id: 'tests', status: 'green', ts: '2026-07-26T12:02:00.000Z', severity: 'critical' }],
      baseline_head: 'abc',
      final_head: 'abc',
    };
    writeFlowReceipt(vault, 'session-1', 'flow-1', receipt);
    writeFileSync(join(flowDir(vault, 'session-1', 'flow-1'), 'receipt.json'), 'null\n');

    assert.throws(
      () => readFlow(vault, { sessionId: 'session-1', flowId: 'flow-1' }),
      /recibo FLOW inválido|corrompido/i,
    );
    assert.throws(
      () => writeFlowReceipt(vault, 'session-1', 'flow-1', receipt),
      /recibo FLOW inválido|corrompido|imutável/i,
    );
    assert.equal(readFileSync(join(flowDir(vault, 'session-1', 'flow-1'), 'receipt.json'), 'utf8'), 'null\n');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OP-7] store rejeita recibo e promoção truthy porém incompletos com FLOW_STORE_CORRUPT', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-'));
  try {
    createFlowContract(vault, contract('flow-1'));
    const dir = flowDir(vault, 'session-1', 'flow-1');
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify({
      schema_version: 1, flow_id: 'flow-1', status: 'finished', finished_at: '2026-07-26T12:02:00.000Z',
    }));
    assert.throws(
      () => readFlow(vault, { sessionId: 'session-1', flowId: 'flow-1' }),
      (error) => error?.code === 'FLOW_STORE_CORRUPT' && /recibo/i.test(error.message),
    );

    rmSync(join(dir, 'receipt.json'));
    writeFileSync(join(dir, 'promotion.json'), JSON.stringify({
      schema_version: 1, flow_id: 'flow-1', status: 'promoted', change_slug: 'normal-change',
    }));
    assert.throws(
      () => readFlow(vault, { sessionId: 'session-1', flowId: 'flow-1' }),
      (error) => error?.code === 'FLOW_STORE_CORRUPT' && /promoção/i.test(error.message),
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OP-6] store rejeita tentativas malformadas em vez de expô-las aos consumidores', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-'));
  try {
    createFlowContract(vault, contract('flow-1'));
    const attempts = join(flowDir(vault, 'session-1', 'flow-1'), 'attempts');
    mkdirSync(attempts, { recursive: true });
    writeFileSync(join(attempts, 'attempt-1.json'), JSON.stringify({
      schema_version: 1,
      attempt_id: 'attempt-1',
      status: 'red',
      recorded_at: '2026-07-26T12:01:00.000Z',
      failures: 'não é array',
      changed_paths: ['src/a.mjs'],
      evidence: [],
    }));
    assert.throws(
      () => readFlow(vault, { sessionId: 'session-1', flowId: 'flow-1' }),
      (error) => error?.code === 'FLOW_STORE_CORRUPT' && /tentativa/i.test(error.message),
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OP-6] ids nunca aceitam traversal, dot-segments ou nomes reservados do Windows', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-'));
  const outside = join(vault, 'escape-sentinel.txt');
  try {
    writeFileSync(outside, 'preservado');
    for (const id of ['.', '..', 'CON', 'nul.txt', 'COM1', 'lpt9.log']) {
      assert.throws(() => flowDir(vault, id, 'flow-1'), /inválido/i, `session_id ${id}`);
      assert.throws(() => flowDir(vault, 'session-1', id), /inválido/i, `flow_id ${id}`);
    }
    createFlowContract(vault, contract('flow-1'));
    assert.throws(
      () => appendFlowAttempt(vault, 'session-1', 'flow-1', { attempt_id: '..' }),
      /inválido/i,
    );
    assert.equal(readFileSync(outside, 'utf8'), 'preservado');
    assert.equal(existsSync(join(vault, 'contract.json')), false);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OP-7] store rejeita runtime redirecionado sem escrever bytes externos', (t) => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-safe-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-store-safe-outside-'));
  try {
    mkdirSync(join(vault, '.brain'));
    writeFileSync(join(outside, 'sentinel.txt'), 'preservado\n');
    try {
      symlinkSync(outside, join(vault, '.brain', 'runtime'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`links indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    assert.throws(
      () => createFlowContract(vault, contract('flow-unsafe-runtime')),
      /Vault|link simbólico|junction|reparse|redirecion/i,
    );
    assert.deepEqual(readdirSync(outside), ['sentinel.txt']);
    assert.equal(readFileSync(join(outside, 'sentinel.txt'), 'utf8'), 'preservado\n');
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] store rejeita attempts redirecionado sem persistir tentativa externa', (t) => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-safe-attempts-'));
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-attempts-outside-'));
  try {
    createFlowContract(vault, contract('flow-1'));
    const attempts = join(flowDir(vault, 'session-1', 'flow-1'), 'attempts');
    writeFileSync(join(outside, 'sentinel.txt'), 'preservado\n');
    try {
      symlinkSync(outside, attempts, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`links indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    assert.throws(() => appendFlowAttempt(vault, 'session-1', 'flow-1', {
      schema_version: 1,
      attempt_id: 'attempt-unsafe',
      status: 'red',
      recorded_at: '2026-07-26T12:01:00.000Z',
      failures: ['sensor vermelho'],
      changed_paths: ['src/a.mjs'],
      evidence: [{ id: 'tests', status: 'red', severity: 'critical' }],
    }), /Vault|link simbólico|junction|reparse|redirecion/i);
    assert.deepEqual(readdirSync(outside), ['sentinel.txt']);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] lock de promoção rejeita raiz redirecionada antes de executar callback', (t) => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-safe-lock-'));
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-lock-outside-'));
  let called = false;
  try {
    mkdirSync(join(vault, '.brain', 'runtime'), { recursive: true });
    writeFileSync(join(outside, 'sentinel.txt'), 'preservado\n');
    try {
      symlinkSync(outside, join(vault, '.brain', 'runtime', 'flow-promotion-locks'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`links indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    assert.throws(
      () => withFlowPromotionLock(vault, 'safe-slug', () => { called = true; }),
      {
        // Falha de fronteira no lock de promoção reporta o código do domínio, nunca o default
        // físico: sem a propagação de `code`, isto seria VAULT_PATH_UNSAFE.
        code: 'FLOW_VAULT_BOUNDARY',
        message: /Vault|link simbólico|junction|reparse|redirecion/i,
      },
    );
    assert.equal(called, false);
    assert.deepEqual(readdirSync(outside), ['sentinel.txt']);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] store rejeita contract.json preexistente por hardlink', (t) => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-safe-hardlink-'));
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-contract-outside-'));
  try {
    const dir = flowDir(vault, 'session-1', 'flow-1');
    mkdirSync(dir, { recursive: true });
    const source = join(outside, 'contract.json');
    const original = `${JSON.stringify(contract('flow-1'), null, 2)}\n`;
    writeFileSync(source, original);
    try {
      linkSync(source, join(dir, 'contract.json'));
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
        t.skip(`hardlinks indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    assert.throws(
      () => createFlowContract(vault, contract('flow-1')),
      /hardlink|nlink|Vault/i,
    );
    assert.equal(readFileSync(source, 'utf8'), original);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] store valida fisicamente as raízes de sessão, FLOW e lock de estado', async (t) => {
  // O código esperado separa as duas fronteiras: validação de raiz compartilhada reporta o
  // default físico, enquanto a falha do lock do store de sessão reporta o código do domínio.
  const cases = [
    ['session-root', (vault) => join(vault, '.brain', 'runtime', 'flows', 'session-1'), 'VAULT_PATH_UNSAFE'],
    ['flow-root', (vault) => join(vault, '.brain', 'runtime', 'flows', 'session-1', 'flow-1'), 'VAULT_PATH_UNSAFE'],
    ['state-lock', (vault) => join(vault, '.brain', 'runtime', 'flows', 'session-1', '.state.lock'), 'FLOW_VAULT_BOUNDARY'],
  ];
  for (const [label, targetOf, expectedCode] of cases) {
    await t.test(label, (subtest) => {
      const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-safe-layer-'));
      const outside = mkdtempSync(join(tmpdir(), 'wk-flow-store-layer-outside-'));
      try {
        const target = targetOf(vault);
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(join(outside, 'sentinel.txt'), 'preservado\n');
        try {
          symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error) {
          if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
            subtest.skip(`links indisponíveis neste filesystem: ${error.code}`);
            return;
          }
          throw error;
        }
        assert.throws(
          () => createFlowContract(vault, contract('flow-1')),
          {
            code: expectedCode,
            message: /Vault|link simbólico|junction|reparse|redirecion/i,
          },
        );
        assert.deepEqual(readdirSync(outside), ['sentinel.txt']);
        assert.equal(readFileSync(join(outside, 'sentinel.txt'), 'utf8'), 'preservado\n');
      } finally {
        rmSync(vault, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });
  }
});

test('[req:OP-7] lock de promoção rejeita owner preexistente por hardlink', (t) => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-owner-hardlink-'));
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-owner-outside-'));
  let called = false;
  try {
    const root = join(vault, '.brain', 'runtime', 'flow-promotion-locks');
    mkdirSync(root, { recursive: true });
    const lock = join(root, 'safe-slug.lock');
    mkdirSync(lock);
    const source = join(outside, 'owner.json');
    const original = '{"external":true}\n';
    writeFileSync(source, original);
    try {
      linkSync(source, join(lock, '.owner.json'));
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
        t.skip(`hardlinks indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.throws(
      () => withFlowPromotionLock(vault, 'safe-slug', () => { called = true; }, {
        timeoutMs: 50, ownerGraceMs: 0,
      }),
      {
        // Esta falha nasce dentro de withVaultPathLock, na inspeção do owner — o caminho que
        // aceitava o código de fronteira física default antes da propagação de `code`.
        code: 'FLOW_VAULT_BOUNDARY',
        message: /hardlink|nlink|Vault/i,
      },
    );
    assert.equal(called, false);
    assert.equal(readFileSync(source, 'utf8'), original);
    assert.equal(existsSync(lock), true, 'boundary inseguro permanece fail-closed');
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] release do lock de promoção não remove owner substituto (ABA)', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-promotion-aba-'));
  try {
    const lock = join(vault, '.brain', 'runtime', 'flow-promotion-locks', 'aba-slug.lock');
    const result = withFlowPromotionLock(vault, 'aba-slug', () => {
      rmSync(lock, { recursive: true, force: true });
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, '.owner.json'), `${JSON.stringify({
        v: 1,
        pid: process.pid,
        token: 'replacement-token',
        created_at: new Date().toISOString(),
      })}\n`);
      writeFileSync(join(lock, '.lease-replacement-token'), 'replacement-token\n');
      return 'owner-replaced';
    });
    assert.equal(result, 'owner-replaced');
    assert.equal(existsSync(lock), true);
    assert.equal(
      JSON.parse(readFileSync(join(lock, '.owner.json'), 'utf8')).token,
      'replacement-token',
    );
    assert.equal(existsSync(join(lock, '.lease-replacement-token')), true);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OP-7] leituras rejeitam hardlink em receipt, reservation, promotion e attempt', async (t) => {
  const cases = ['receipt', 'reservation', 'promotion', 'attempt'];
  for (const artifact of cases) {
    await t.test(artifact, (subtest) => {
      const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-read-hardlink-'));
      const outside = mkdtempSync(join(tmpdir(), 'wk-flow-read-outside-'));
      try {
        const flowContract = contract('flow-1');
        createFlowContract(vault, flowContract);
        const dir = flowDir(vault, 'session-1', 'flow-1');
        let target;
        let value;
        if (artifact === 'receipt') {
          target = join(dir, 'receipt.json');
          value = {
            schema_version: 1,
            flow_id: 'flow-1',
            status: 'finished',
            finished_at: '2026-07-26T12:02:00.000Z',
            reason: 'ajuste localizado',
            allowed_paths: ['src/a.mjs'],
            sensor_ids: ['tests'],
            changed_paths: ['src/a.mjs'],
            evidence: [{
              id: 'tests', status: 'green', ts: '2026-07-26T12:02:00.000Z', severity: 'critical',
            }],
            baseline_head: 'abc',
            final_head: 'abc',
          };
        } else if (artifact === 'reservation') {
          target = join(dir, 'promotion-reservation.json');
          value = promotionReservation(flowContract);
        } else if (artifact === 'promotion') {
          reserveFlowPromotion(vault, 'session-1', 'flow-1', promotionReservation(flowContract));
          target = join(dir, 'promotion.json');
          value = terminalPromotion();
        } else {
          const attempts = join(dir, 'attempts');
          mkdirSync(attempts);
          target = join(attempts, 'attempt-1.json');
          value = {
            schema_version: 1,
            attempt_id: 'attempt-1',
            status: 'red',
            recorded_at: '2026-07-26T12:01:00.000Z',
            failures: ['sensor vermelho'],
            changed_paths: ['src/a.mjs'],
            evidence: [{ id: 'tests', status: 'red', severity: 'critical' }],
          };
        }
        const source = join(outside, `${artifact}.json`);
        const original = `${JSON.stringify(value, null, 2)}\n`;
        writeFileSync(source, original);
        try {
          linkSync(source, target);
        } catch (error) {
          if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
            subtest.skip(`hardlinks indisponíveis neste filesystem: ${error.code}`);
            return;
          }
          throw error;
        }
        assert.throws(
          () => readFlow(vault, { sessionId: 'session-1', flowId: 'flow-1' }),
          /hardlink|nlink|Vault/i,
        );
        assert.equal(readFileSync(source, 'utf8'), original);
      } finally {
        rmSync(vault, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });
  }
});

test('[req:OP-7] readFlow rejeita reserva cuja origem troca o contrato ou a sessão externa', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-reservation-contract-'));
  try {
    const flowContract = contract('flow-1');
    createFlowContract(vault, flowContract);
    const reservation = {
      schema_version: 1,
      flow_id: 'flow-1',
      status: 'promoting',
      reserved_at: '2026-07-26T12:02:00.000Z',
      change_slug: 'normal-change',
      change_rel: '08-Mudanças/normal-change',
      origin: {
        schema_version: 1,
        flow_id: 'flow-1',
        promoted_at: '2026-07-26T12:02:00.000Z',
        contract: {
          ...flowContract,
          session_id: 'session-rival',
          session_file: '02-Sessões/2026/07-JUL/DIA 26/rival.md',
        },
        attempts: [],
        observed_git: {
          baseline_head: 'abc',
          current_head: 'abc',
          head_changed: false,
          changed_paths: ['src/a.mjs'],
        },
      },
    };
    writeFileSync(
      join(flowDir(vault, 'session-1', 'flow-1'), 'promotion-reservation.json'),
      `${JSON.stringify(reservation, null, 2)}\n`,
    );

    assert.throws(
      () => readFlow(vault, { sessionId: 'session-1', flowId: 'flow-1' }),
      (error) => error?.code === 'FLOW_STORE_CORRUPT' && /reserva|contrato|sessão/i.test(error.message),
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OP-7] readFlow rejeita toda divergência entre promoção terminal e reserva', async (t) => {
  const cases = [
    ['promoted_at', '2026-07-26T12:03:00.000Z'],
    ['change_slug', 'outra-change'],
    ['change_rel', '08-Mudanças/outra-change'],
    ['origin_file', '08-Mudanças/normal-change/outra-origem.json'],
    ['changed_paths', ['src/outro.mjs']],
    ['baseline_head', 'def'],
    ['current_head', 'def'],
  ];
  for (const [field, divergent] of cases) {
    await t.test(field, () => {
      const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-promotion-relation-'));
      try {
        const flowContract = contract('flow-1');
        createFlowContract(vault, flowContract);
        const reservation = {
          schema_version: 1,
          flow_id: 'flow-1',
          status: 'promoting',
          reserved_at: '2026-07-26T12:02:00.000Z',
          change_slug: 'normal-change',
          change_rel: '08-Mudanças/normal-change',
          origin: {
            schema_version: 1,
            flow_id: 'flow-1',
            promoted_at: '2026-07-26T12:02:00.000Z',
            contract: flowContract,
            attempts: [],
            observed_git: {
              baseline_head: 'abc',
              current_head: 'abc',
              head_changed: false,
              changed_paths: ['src/a.mjs'],
            },
          },
        };
        const promotion = {
          schema_version: 1,
          flow_id: 'flow-1',
          status: 'promoted',
          promoted_at: '2026-07-26T12:02:00.000Z',
          change_slug: 'normal-change',
          change_rel: '08-Mudanças/normal-change',
          origin_file: '08-Mudanças/normal-change/flow-origin.json',
          changed_paths: ['src/a.mjs'],
          baseline_head: 'abc',
          current_head: 'abc',
          [field]: divergent,
        };
        const dir = flowDir(vault, 'session-1', 'flow-1');
        writeFileSync(join(dir, 'promotion-reservation.json'), `${JSON.stringify(reservation, null, 2)}\n`);
        writeFileSync(join(dir, 'promotion.json'), `${JSON.stringify(promotion, null, 2)}\n`);

        assert.throws(
          () => readFlow(vault, { sessionId: 'session-1', flowId: 'flow-1' }),
          (error) => error?.code === 'FLOW_STORE_CORRUPT' && /promoção|reserva/i.test(error.message),
        );
      } finally {
        rmSync(vault, { recursive: true, force: true });
      }
    });
  }
});

test('[req:OP-7] receipt deve corresponder semanticamente ao contrato no write e no read', async (t) => {
  const cases = [
    ['reason', { reason: 'outro motivo' }],
    ['allowed_paths', { allowed_paths: ['src/outro.mjs'] }],
    ['sensor_ids', { sensor_ids: ['outro-sensor'] }],
    ['evidence', { evidence: [{ id: 'tests', status: 'red', ts: '2026-07-26T12:02:00.000Z', severity: 'critical' }] }],
    ['changed_paths', { changed_paths: ['src/fora.mjs'] }],
    ['baseline_head', { baseline_head: 'def' }],
  ];
  for (const [field, patch] of cases) {
    await t.test(field, () => {
      const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-receipt-contract-'));
      try {
        createFlowContract(vault, contract('flow-1'));
        const divergent = { ...finishedReceipt(), ...patch };
        assert.throws(
          () => writeFlowReceipt(vault, 'session-1', 'flow-1', divergent),
          (error) => error?.code === 'FLOW_STORE_CORRUPT' && /recibo|contrato/i.test(error.message),
        );
        const receiptPath = join(flowDir(vault, 'session-1', 'flow-1'), 'receipt.json');
        assert.equal(existsSync(receiptPath), false);
        writeFileSync(receiptPath, `${JSON.stringify(divergent, null, 2)}\n`);
        assert.throws(
          () => readFlow(vault, { sessionId: 'session-1', flowId: 'flow-1' }),
          (error) => error?.code === 'FLOW_STORE_CORRUPT' && /recibo|contrato/i.test(error.message),
        );
      } finally {
        rmSync(vault, { recursive: true, force: true });
      }
    });
  }
});

test('[req:OP-7] reservation aceita somente slug seguro e change_rel canônico derivado', async (t) => {
  const cases = [
    ['slug traversal', { change_slug: '../escape', change_rel: '08-Mudanças/../escape' }],
    ['rel traversal', { change_rel: '../outside/normal-change' }],
    ['rel divergente', { change_rel: '08-Mudanças/outra-change' }],
    ['rel absoluto', { change_rel: 'C:/outside/normal-change' }],
  ];
  for (const [label, patch] of cases) {
    await t.test(label, () => {
      const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-reservation-path-'));
      try {
        const flowContract = contract('flow-1');
        createFlowContract(vault, flowContract);
        const unsafeReservation = { ...promotionReservation(flowContract), ...patch };
        assert.throws(
          () => reserveFlowPromotion(vault, 'session-1', 'flow-1', unsafeReservation),
          /reserva|change_slug|change_rel|inválid/i,
        );
        const reservationPath = join(flowDir(vault, 'session-1', 'flow-1'), 'promotion-reservation.json');
        assert.equal(existsSync(reservationPath), false);
        writeFileSync(reservationPath, `${JSON.stringify(unsafeReservation, null, 2)}\n`);
        assert.throws(
          () => readFlow(vault, { sessionId: 'session-1', flowId: 'flow-1' }),
          (error) => error?.code === 'FLOW_STORE_CORRUPT' && /reserva/i.test(error.message),
        );
      } finally {
        rmSync(vault, { recursive: true, force: true });
      }
    });
  }
});

test('[req:OP-7] contrato rejeita paths FLOW não canônicos antes de criar runtime', async (t) => {
  const cases = [
    ['allowlist traversal', { allowed_paths: ['src/../outside.mjs'] }],
    ['allowlist absoluto Windows', { allowed_paths: ['C:/outside.mjs'] }],
    ['allowlist absoluto POSIX', { allowed_paths: ['/outside.mjs'] }],
    ['allowlist separador Windows', { allowed_paths: ['src\\a.mjs'] }],
    ['allowlist segmento vazio', { allowed_paths: ['src//a.mjs'] }],
    ['allowlist segmento dot', { allowed_paths: ['src/./a.mjs'] }],
    ['allowlist ADS', { allowed_paths: ['src/a.mjs:payload'] }],
    ['allowlist glob intermediário', { allowed_paths: ['src/*.mjs'] }],
    ['allowlist tree não terminal', { allowed_paths: ['src/**/nested'] }],
    ['protected root traversal', { protected_roots: ['src/../private/**'] }],
    ['session_file traversal', { session_file: '../outside.md' }],
    ['project_rel absoluto', { project_rel: 'C:/repo' }],
  ];
  for (const [label, patch] of cases) {
    await t.test(label, () => {
      const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-canonical-contract-'));
      try {
        assert.throws(
          () => createFlowContract(vault, { ...contract('flow-1'), ...patch }),
          /contrato|path|inválid/i,
        );
        assert.equal(existsSync(join(vault, '.brain', 'runtime')), false);
      } finally {
        rmSync(vault, { recursive: true, force: true });
      }
    });
  }
});

test('[req:OP-7] receipt não aceita traversal lexical coberto apenas textualmente por /**', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-canonical-receipt-'));
  try {
    const flowContract = { ...contract('flow-1'), allowed_paths: ['src/**'] };
    createFlowContract(vault, flowContract);
    const unsafeReceipt = {
      ...finishedReceipt(),
      allowed_paths: ['src/**'],
      changed_paths: ['src/../outside.mjs'],
    };
    assert.throws(
      () => writeFlowReceipt(vault, 'session-1', 'flow-1', unsafeReceipt),
      (error) => error?.code === 'FLOW_STORE_CORRUPT' && /recibo|contrato/i.test(error.message),
    );
    const receiptPath = join(flowDir(vault, 'session-1', 'flow-1'), 'receipt.json');
    assert.equal(existsSync(receiptPath), false);
    writeFileSync(receiptPath, `${JSON.stringify(unsafeReceipt, null, 2)}\n`);
    assert.throws(
      () => readFlow(vault, { sessionId: 'session-1', flowId: 'flow-1' }),
      (error) => error?.code === 'FLOW_STORE_CORRUPT' && /recibo|contrato/i.test(error.message),
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OP-7] reservation vincula observed_git ao contrato no write e no read', async (t) => {
  const cases = [
    ['baseline divergente', { baseline_head: 'def' }],
    ['head_changed falso com HEAD diferente', { current_head: 'def', head_changed: false }],
    ['head_changed verdadeiro com HEAD igual', { current_head: 'abc', head_changed: true }],
    ['path traversal sob prefixo permitido', { changed_paths: ['src/../outside.mjs'] }, ['src/**']],
  ];
  for (const [label, observedPatch, allowedPaths = ['src/a.mjs']] of cases) {
    await t.test(label, () => {
      const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-observed-git-'));
      try {
        const flowContract = { ...contract('flow-1'), allowed_paths: allowedPaths };
        createFlowContract(vault, flowContract);
        const base = promotionReservation(flowContract);
        const unsafeReservation = {
          ...base,
          origin: {
            ...base.origin,
            observed_git: { ...base.origin.observed_git, ...observedPatch },
          },
        };
        assert.throws(
          () => reserveFlowPromotion(vault, 'session-1', 'flow-1', unsafeReservation),
          (error) => error?.code === 'FLOW_STORE_CORRUPT' && /reserva|contrato|Git/i.test(error.message),
        );
        const reservationPath = join(flowDir(vault, 'session-1', 'flow-1'), 'promotion-reservation.json');
        assert.equal(existsSync(reservationPath), false);
        writeFileSync(reservationPath, `${JSON.stringify(unsafeReservation, null, 2)}\n`);
        assert.throws(
          () => readFlow(vault, { sessionId: 'session-1', flowId: 'flow-1' }),
          (error) => error?.code === 'FLOW_STORE_CORRUPT' && /reserva|contrato|Git/i.test(error.message),
        );
      } finally {
        rmSync(vault, { recursive: true, force: true });
      }
    });
  }
});

test('[req:OP-7] tentativa rejeita changed_path não canônico no write e no read', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-flow-store-canonical-attempt-'));
  try {
    createFlowContract(vault, contract('flow-1'));
    const unsafeAttempt = {
      schema_version: 1,
      attempt_id: 'attempt-unsafe',
      status: 'red',
      recorded_at: '2026-07-26T12:01:00.000Z',
      failures: ['path inválido'],
      changed_paths: ['src/../outside.mjs'],
      evidence: [{ id: 'tests', status: 'red', ts: '2026-07-26T12:01:00.000Z', severity: 'critical' }],
    };
    assert.throws(
      () => appendFlowAttempt(vault, 'session-1', 'flow-1', unsafeAttempt),
      (error) => error?.code === 'FLOW_STORE_CORRUPT' && /tentativa/i.test(error.message),
    );
    const attemptsDir = join(flowDir(vault, 'session-1', 'flow-1'), 'attempts');
    assert.equal(existsSync(attemptsDir), false);
    mkdirSync(attemptsDir);
    writeFileSync(join(attemptsDir, 'attempt-unsafe.json'), `${JSON.stringify(unsafeAttempt, null, 2)}\n`);
    assert.throws(
      () => readFlow(vault, { sessionId: 'session-1', flowId: 'flow-1' }),
      (error) => error?.code === 'FLOW_STORE_CORRUPT' && /tentativa/i.test(error.message),
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
