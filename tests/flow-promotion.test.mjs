import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, symlinkSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionRegistry, writeSessionRegistry } from '../hooks/obsidian-common.mjs';
import { finishFlow, promoteFlow, startFlow } from '../hooks/flow-core.mjs';
import {
  appendFlowAttempt, readFlow, reserveFlowPromotion, writeFlowReceipt,
} from '../hooks/vault-runtime-store.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wk-flow-promotion-'));
  const vault = join(root, '.vault');
  const sessionRel = '02-Sessões/2026/07-JUL/DIA 26/promotion.md';
  const sessionPath = join(vault, ...sessionRel.split('/'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(vault, '.brain'), { recursive: true });
  mkdirSync(join(sessionPath, '..'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, '.gitignore'), '.vault/\n');
  writeFileSync(join(root, 'wendkeep.sensors.json'), JSON.stringify({
    version: 1,
    sensors: [{ id: 'focused', severity: 'critical', command: 'node -e "process.exit(0)"' }],
  }));
  writeFileSync(sessionPath, `---
type: session
session_id: session-promote
status: active
---

# Promotion

## Iterações

## Encerramento
`);
  writeSessionRegistry(vault, {
    version: 2,
    sessions: {
      'session-promote': {
        status: 'active', provider: 'codex', session_file: sessionRel,
        started_at: '2026-07-26T10:00:00.000Z',
      },
    },
  });
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'flow@example.invalid');
  git(root, 'config', 'user.name', 'FLOW Test');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  return { root, vault, sessionRel, sessionPath };
}

function start(fx, overrides = {}) {
  return startFlow({
    vaultBase: fx.vault,
    projectRoot: fx.root,
    slug: 'promote-me',
    allowedPaths: ['src/app.mjs'],
    sensorIds: ['focused'],
    reason: 'o escopo deixou de ser uma alteração pequena',
    sessionId: 'session-promote',
    now: new Date('2026-07-26T12:00:00.000Z'),
    flowId: 'flow-promote-1',
    ...overrides,
  });
}

function addSession(fx, sessionId, basename) {
  const sessionRel = `02-Sessões/2026/07-JUL/DIA 26/${basename}.md`;
  const sessionPath = join(fx.vault, ...sessionRel.split('/'));
  mkdirSync(join(sessionPath, '..'), { recursive: true });
  writeFileSync(sessionPath, `---
type: session
session_id: ${sessionId}
status: active
---

# Promotion

## Iterações

## Encerramento
`);
  const registry = readSessionRegistry(fx.vault);
  registry.sessions[sessionId] = {
    status: 'active', provider: 'codex', session_file: sessionRel,
    started_at: '2026-07-26T10:01:00.000Z',
  };
  writeSessionRegistry(fx.vault, registry);
  return { sessionRel, sessionPath };
}

function reservePromotionForRetry(fx, active, {
  slug = active.contract.slug,
  reservedAt = '2026-07-26T12:05:00.000Z',
} = {}) {
  const state = readFlow(fx.vault, {
    sessionId: active.contract.session_id,
    flowId: active.contract.flow_id,
  });
  const changeRel = `08-Mudanças/${slug}`;
  reserveFlowPromotion(fx.vault, active.contract.session_id, active.contract.flow_id, {
    schema_version: 1,
    flow_id: active.contract.flow_id,
    status: 'promoting',
    reserved_at: reservedAt,
    change_slug: slug,
    change_rel: changeRel,
    origin: {
      schema_version: 1,
      flow_id: active.contract.flow_id,
      promoted_at: reservedAt,
      contract: active.contract,
      attempts: state.attempts,
      observed_git: {
        baseline_head: active.contract.baseline.head,
        current_head: active.contract.baseline.head,
        head_changed: false,
        changed_paths: ['src/app.mjs'],
      },
    },
  });
  return readFlow(fx.vault, {
    sessionId: active.contract.session_id,
    flowId: active.contract.flow_id,
  });
}

function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('timeout aguardando workers de promoção'));
      return setTimeout(poll, 10);
    };
    poll();
  });
}

function spawnPromotion({ vaultBase, projectRoot, sessionId, flowId, readyPath }) {
  const script = `
    import { writeFileSync } from 'node:fs';
    const { promoteFlow } = await import(process.env.WK_FLOW_CORE_URL);
    writeFileSync(process.env.WK_PROMOTION_READY, String(process.pid));
    try {
      const result = promoteFlow({
        vaultBase: process.env.WK_PROMOTION_VAULT,
        projectRoot: process.env.WK_PROMOTION_PROJECT,
        sessionId: process.env.WK_PROMOTION_SESSION,
        flowId: process.env.WK_PROMOTION_FLOW,
        now: new Date('2026-07-26T12:05:00.000Z'),
      });
      process.stdout.write(JSON.stringify({
        sessionId: process.env.WK_PROMOTION_SESSION,
        flowId: process.env.WK_PROMOTION_FLOW,
        ok: true,
        state: result.state.state,
        idempotent: result.idempotent === true,
      }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        sessionId: process.env.WK_PROMOTION_SESSION,
        flowId: process.env.WK_PROMOTION_FLOW,
        ok: false,
        code: error?.code || '',
        message: error?.message || String(error),
      }));
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: projectRoot,
    env: {
      ...process.env,
      WK_FLOW_CORE_URL: new URL('../hooks/flow-core.mjs', import.meta.url).href,
      WK_PROMOTION_READY: readyPath,
      WK_PROMOTION_VAULT: vaultBase,
      WK_PROMOTION_PROJECT: projectRoot,
      WK_PROMOTION_SESSION: sessionId,
      WK_PROMOTION_FLOW: flowId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`worker de promoção travou: ${sessionId}`));
    }, 10_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`worker ${sessionId} saiu ${code}: ${stderr}`));
      try {
        return resolve(JSON.parse(stdout));
      } catch (error) {
        return reject(new Error(`worker ${sessionId} não devolveu JSON: ${stdout}\n${stderr}`, { cause: error }));
      }
    });
  });
  return { child, completed };
}

test('[req:OP-7] flow promote cria change normal e preserva contrato, tentativas e projeção idempotente', () => {
  const fx = fixture();
  try {
    const active = start(fx);
    appendFlowAttempt(fx.vault, 'session-promote', active.contract.flow_id, {
      schema_version: 1,
      attempt_id: 'attempt-before-promotion',
      status: 'red',
      recorded_at: '2026-07-26T12:02:00.000Z',
      failures: ['superfície protegida descoberta durante a execução'],
      changed_paths: ['src/app.mjs'],
      evidence: [{ id: 'focused', severity: 'critical', status: 'green' }],
    });
    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 2;\n');

    const promoted = promoteFlow({
      vaultBase: fx.vault,
      projectRoot: fx.root,
      flowId: active.contract.flow_id,
      now: new Date('2026-07-26T12:05:00.000Z'),
    });

    assert.equal(promoted.ok, true);
    assert.equal(promoted.state.state, 'promoted');
    assert.equal(promoted.state.promotion.change_slug, 'promote-me');
    const changeDir = join(fx.vault, '08-Mudanças', 'promote-me');
    const origin = JSON.parse(readFileSync(join(changeDir, 'flow-origin.json'), 'utf8'));
    assert.equal(origin.flow_id, active.contract.flow_id);
    assert.equal(origin.contract.reason, active.contract.reason);
    assert.equal(origin.attempts[0].attempt_id, 'attempt-before-promotion');
    assert.deepEqual(origin.observed_git.changed_paths, ['src/app.mjs']);
    const proposal = readFileSync(join(changeDir, 'proposta.md'), 'utf8');
    assert.match(proposal, /o escopo deixou de ser uma alteração pequena/);
    assert.match(proposal, /src\/app\.mjs/);
    assert.match(proposal, /focused/);
    assert.match(readFileSync(join(fx.vault, '.brain', 'CURRENT_CHANGE.md'), 'utf8'), /change: promote-me/);
    assert.equal(readSessionRegistry(fx.vault).sessions['session-promote'].change_slug, 'promote-me');
    assert.equal((readFileSync(fx.sessionPath, 'utf8').match(/wk-turn: flow:flow-promote-1:promoted/g) || []).length, 1);

    const proposalBeforeRetry = readFileSync(join(changeDir, 'proposta.md'), 'utf8');
    const retried = promoteFlow({ vaultBase: fx.vault, projectRoot: fx.root, flowId: active.contract.flow_id });
    assert.equal(retried.idempotent, true);
    assert.equal(readFileSync(join(changeDir, 'proposta.md'), 'utf8'), proposalBeforeRetry);
    assert.equal((readFileSync(fx.sessionPath, 'utf8').match(/wk-turn: flow:flow-promote-1:promoted/g) || []).length, 1);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] promoções multiprocesso para o mesmo slug elegem um único owner sem prender o perdedor', async () => {
  const fx = fixture();
  const sessionB = addSession(fx, 'session-promote-rival', 'promotion-rival');
  const sessionLocks = [
    join(fx.vault, '.brain', 'runtime', 'flows', 'session-promote', '.state.lock'),
    join(fx.vault, '.brain', 'runtime', 'flows', 'session-promote-rival', '.state.lock'),
  ];
  try {
    const flowA = start(fx, { flowId: 'flow-promote-race-a' });
    const flowB = start(fx, {
      flowId: 'flow-promote-race-b',
      sessionId: 'session-promote-rival',
    });
    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 2;\n');

    for (const lock of sessionLocks) mkdirSync(lock);
    const readyA = join(fx.vault, '.brain', 'promotion-a.ready');
    const readyB = join(fx.vault, '.brain', 'promotion-b.ready');
    const workerA = spawnPromotion({
      vaultBase: fx.vault,
      projectRoot: fx.root,
      sessionId: flowA.contract.session_id,
      flowId: flowA.contract.flow_id,
      readyPath: readyA,
    });
    const workerB = spawnPromotion({
      vaultBase: fx.vault,
      projectRoot: fx.root,
      sessionId: flowB.contract.session_id,
      flowId: flowB.contract.flow_id,
      readyPath: readyB,
    });
    await waitFor(() => existsSync(readyA) && existsSync(readyB));
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const lock of sessionLocks) rmdirSync(lock);

    const outcomes = await Promise.all([workerA.completed, workerB.completed]);
    const states = [
      readFlow(fx.vault, { sessionId: flowA.contract.session_id, flowId: flowA.contract.flow_id }),
      readFlow(fx.vault, { sessionId: flowB.contract.session_id, flowId: flowB.contract.flow_id }),
    ];
    const promoted = states.filter((state) => state.state === 'promoted');
    const active = states.filter((state) => state.state === 'active');
    assert.equal(promoted.length, 1, JSON.stringify({ outcomes, states }, null, 2));
    assert.equal(active.length, 1, JSON.stringify({ outcomes, states }, null, 2));
    assert.equal(active[0].reservation, null);

    const loserOutcome = outcomes.find((outcome) => outcome.flowId === active[0].contract.flow_id);
    assert.equal(loserOutcome.ok, false);
    assert.equal(loserOutcome.code, 'FLOW_PROMOTION_CONFLICT', JSON.stringify({ outcomes, states }, null, 2));
    const changeDir = join(fx.vault, '08-Mudanças', 'promote-me');
    const originPath = join(changeDir, 'flow-origin.json');
    const originBeforeRetry = readFileSync(originPath, 'utf8');
    const origin = JSON.parse(originBeforeRetry);
    assert.equal(origin.flow_id, promoted[0].contract.flow_id);

    const winnerRetry = promoteFlow({
      vaultBase: fx.vault,
      projectRoot: fx.root,
      sessionId: promoted[0].contract.session_id,
      flowId: promoted[0].contract.flow_id,
    });
    assert.equal(winnerRetry.idempotent, true);
    assert.equal(readFileSync(originPath, 'utf8'), originBeforeRetry);
    assert.throws(() => promoteFlow({
      vaultBase: fx.vault,
      projectRoot: fx.root,
      sessionId: active[0].contract.session_id,
      flowId: active[0].contract.flow_id,
    }), (error) => error?.code === 'FLOW_PROMOTION_CONFLICT');
    assert.equal(readFlow(fx.vault, {
      sessionId: active[0].contract.session_id,
      flowId: active[0].contract.flow_id,
    }).state, 'active');
    assert.equal(readFileSync(originPath, 'utf8'), originBeforeRetry);
    const loserRetry = promoteFlow({
      vaultBase: fx.vault,
      projectRoot: fx.root,
      sessionId: active[0].contract.session_id,
      flowId: active[0].contract.flow_id,
      changeSlug: 'promote-me-rival-retry',
    });
    assert.equal(loserRetry.state.state, 'promoted');
    assert.equal(loserRetry.state.promotion.change_slug, 'promote-me-rival-retry');
    assert.equal(readFileSync(originPath, 'utf8'), originBeforeRetry);
    assert.equal(existsSync(sessionB.sessionPath), true);
  } finally {
    for (const lock of sessionLocks) {
      try { rmdirSync(lock); } catch { /* worker ou teste já liberou */ }
    }
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] reserva durável bloqueia finish concorrente e retoma efeitos após falha', () => {
  const fx = fixture();
  try {
    const active = start(fx, { flowId: 'flow-promoting-saga' });
    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 2;\n');
    const changesRoot = join(fx.vault, '08-Mudanças');
    const reserved = reservePromotionForRetry(fx, active, {
      slug: 'promote-reserved',
      reservedAt: '2026-07-26T12:05:00.000Z',
    });
    assert.equal(reserved.state, 'promoting');
    assert.equal(reserved.reservation.status, 'promoting');
    assert.equal(reserved.reservation.change_slug, 'promote-reserved');
    assert.deepEqual(reserved.reservation.origin.observed_git.changed_paths, ['src/app.mjs']);
    assert.throws(() => promoteFlow({
      vaultBase: fx.vault,
      projectRoot: fx.root,
      flowId: active.contract.flow_id,
      changeSlug: 'outra-change',
    }), (error) => error?.code === 'FLOW_PROMOTION_CONFLICT');
    assert.throws(() => finishFlow({
      vaultBase: fx.vault,
      projectRoot: fx.root,
      flowId: active.contract.flow_id,
    }), (error) => error?.code === 'FLOW_TERMINAL');
    assert.throws(() => writeFlowReceipt(
      fx.vault,
      'session-promote',
      active.contract.flow_id,
      {
        schema_version: 1,
        flow_id: active.contract.flow_id,
        status: 'finished',
        finished_at: '2026-07-26T12:06:00.000Z',
        reason: active.contract.reason,
        allowed_paths: active.contract.allowed_paths,
        sensor_ids: active.contract.sensor_ids,
        changed_paths: ['src/app.mjs'],
        evidence: [{
          id: 'focused', severity: 'critical', status: 'green', ts: '2026-07-26T12:06:00.000Z',
        }],
        baseline_head: active.contract.baseline.head,
        final_head: active.contract.baseline.head,
      },
    ), (error) => error?.code === 'FLOW_TERMINAL');

    mkdirSync(join(changesRoot, 'promote-reserved'), { recursive: true });
    writeFileSync(join(fx.root, 'src', 'later.mjs'), 'export const later = true;\n');
    const promoted = promoteFlow({
      vaultBase: fx.vault,
      projectRoot: fx.root,
      flowId: active.contract.flow_id,
      now: new Date('2026-07-26T13:00:00.000Z'),
    });

    assert.equal(promoted.ok, true);
    assert.equal(promoted.state.state, 'promoted');
    assert.equal(promoted.state.promotion.promoted_at, '2026-07-26T12:05:00.000Z');
    assert.deepEqual(promoted.state.promotion.changed_paths, ['src/app.mjs']);
    assert.equal(existsSync(join(changesRoot, 'promote-reserved', 'proposta.md')), true);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] reserva sem scaffold continua dona do slug e não prende outro FLOW', () => {
  const fx = fixture();
  addSession(fx, 'session-promote-rival', 'promotion-rival');
  try {
    const owner = start(fx, { flowId: 'flow-reserved-owner' });
    const rival = start(fx, {
      flowId: 'flow-reserved-rival',
      sessionId: 'session-promote-rival',
    });
    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 2;\n');
    const changesRoot = join(fx.vault, '08-Mudanças');
    reservePromotionForRetry(fx, owner);
    assert.equal(readFlow(fx.vault, {
      sessionId: owner.contract.session_id, flowId: owner.contract.flow_id,
    }).state, 'promoting');

    assert.throws(() => promoteFlow({
      vaultBase: fx.vault,
      projectRoot: fx.root,
      sessionId: rival.contract.session_id,
      flowId: rival.contract.flow_id,
    }), (error) => error?.code === 'FLOW_PROMOTION_CONFLICT');
    assert.equal(readFlow(fx.vault, {
      sessionId: rival.contract.session_id, flowId: rival.contract.flow_id,
    }).state, 'active');

    const promoted = promoteFlow({
      vaultBase: fx.vault,
      projectRoot: fx.root,
      sessionId: owner.contract.session_id,
      flowId: owner.contract.flow_id,
    });
    assert.equal(promoted.state.state, 'promoted');
    assert.equal(JSON.parse(readFileSync(
      join(fx.vault, '08-Mudanças', 'promote-me', 'flow-origin.json'),
      'utf8',
    )).flow_id, owner.contract.flow_id);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] retry retoma origem e scaffold parciais sem reatribuir a promoção', () => {
  const fx = fixture();
  try {
    const active = start(fx, { flowId: 'flow-partial-promotion' });
    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 2;\n');
    const changesRoot = join(fx.vault, '08-Mudanças');
    const reserved = reservePromotionForRetry(fx, active);
    const changeDir = join(changesRoot, 'promote-me');
    mkdirSync(changeDir, { recursive: true });
    writeFileSync(
      join(changeDir, 'flow-origin.json'),
      `${JSON.stringify(reserved.reservation.origin, null, 2)}\n`,
    );
    mkdirSync(join(changeDir, 'proposta.md'));

    assert.throws(() => promoteFlow({
      vaultBase: fx.vault,
      projectRoot: fx.root,
      flowId: active.contract.flow_id,
    }));
    assert.equal(readFlow(fx.vault, {
      sessionId: 'session-promote', flowId: active.contract.flow_id,
    }).state, 'promoting');

    rmdirSync(join(changeDir, 'proposta.md'));
    assert.equal(existsSync(join(changeDir, 'proposta.md')), false);
    const promoted = promoteFlow({
      vaultBase: fx.vault,
      projectRoot: fx.root,
      flowId: active.contract.flow_id,
    });
    assert.equal(promoted.state.state, 'promoted');
    assert.equal(promoted.state.promotion.change_slug, reserved.reservation.change_slug);
    assert.equal(readSessionRegistry(fx.vault).sessions['session-promote'].change_slug, 'promote-me');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] promoção nunca toma uma change preexistente sem a mesma origem FLOW', () => {
  const fx = fixture();
  try {
    const active = start(fx, { flowId: 'flow-conflict-1' });
    const changeDir = join(fx.vault, '08-Mudanças', 'promote-me');
    mkdirSync(changeDir, { recursive: true });
    writeFileSync(join(changeDir, 'proposta.md'), '# change de outra origem\n');
    assert.throws(() => promoteFlow({
      vaultBase: fx.vault, projectRoot: fx.root, flowId: active.contract.flow_id,
    }), (error) => error?.code === 'FLOW_PROMOTION_CONFLICT');
    assert.equal(readFlow(fx.vault, {
      sessionId: 'session-promote', flowId: active.contract.flow_id,
    }).state, 'active');
    assert.equal(existsSync(join(changeDir, 'flow-origin.json')), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] promoção rejeita um projectRoot diferente do repositório do contrato', () => {
  const fx = fixture();
  const other = fixture();
  try {
    const active = start(fx, { flowId: 'flow-wrong-root' });
    assert.throws(() => promoteFlow({
      vaultBase: fx.vault,
      projectRoot: other.root,
      flowId: active.contract.flow_id,
    }), (error) => error?.code === 'FLOW_REPOSITORY_CHANGED');
    assert.equal(readFlow(fx.vault, {
      sessionId: 'session-promote', flowId: active.contract.flow_id,
    }).state, 'active');
    assert.equal(existsSync(join(fx.vault, '08-Mudanças', 'promote-me')), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(other.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] promoção rejeita 08-Mudanças redirecionado para fora antes de reservar ou escrever', (t) => {
  const fx = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-promotion-outside-'));
  try {
    const active = start(fx, { flowId: 'flow-change-root-junction' });
    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 2;\n');
    const changesRoot = join(fx.vault, '08-Mudanças');
    try {
      symlinkSync(outside, changesRoot, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`links indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    assert.throws(() => promoteFlow({
      vaultBase: fx.vault,
      projectRoot: fx.root,
      flowId: active.contract.flow_id,
    }), (error) => error?.code === 'FLOW_VAULT_BOUNDARY');
    const state = readFlow(fx.vault, {
      sessionId: 'session-promote', flowId: active.contract.flow_id,
    });
    assert.equal(state.state, 'active');
    assert.equal(state.reservation, null);
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] FLOW ativo rejeita destino dangling antes da reserva', (t) => {
  const fx = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-promotion-dangling-'));
  try {
    const active = start(fx, { flowId: 'flow-change-dangling' });
    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 2;\n');
    const changesRoot = join(fx.vault, '08-Mudanças');
    mkdirSync(changesRoot, { recursive: true });
    const missingTarget = join(outside, 'nao-existe');
    try {
      symlinkSync(missingTarget, join(changesRoot, 'promote-me'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`links indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    assert.throws(() => promoteFlow({
      vaultBase: fx.vault,
      projectRoot: fx.root,
      flowId: active.contract.flow_id,
    }), (error) => error?.code === 'FLOW_VAULT_BOUNDARY');
    const state = readFlow(fx.vault, {
      sessionId: 'session-promote', flowId: active.contract.flow_id,
    });
    assert.equal(state.state, 'active');
    assert.equal(state.reservation, null);
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] FLOW ativo rejeita CURRENT_CHANGE por hardlink antes de reservar ou criar change', (t) => {
  const fx = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-promotion-pointer-hardlink-'));
  try {
    const active = start(fx, { flowId: 'flow-pointer-hardlink' });
    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 2;\n');
    const source = join(outside, 'CURRENT_CHANGE.md');
    const original = 'change: externo\n';
    writeFileSync(source, original);
    try {
      linkSync(source, join(fx.vault, '.brain', 'CURRENT_CHANGE.md'));
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
        t.skip(`hardlinks indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    assert.throws(() => promoteFlow({
      vaultBase: fx.vault,
      projectRoot: fx.root,
      flowId: active.contract.flow_id,
    }), (error) => error?.code === 'FLOW_VAULT_BOUNDARY' && /hardlink|nlink/i.test(error.message));
    const state = readFlow(fx.vault, {
      sessionId: 'session-promote', flowId: active.contract.flow_id,
    });
    assert.equal(state.state, 'active');
    assert.equal(state.reservation, null);
    assert.equal(existsSync(join(fx.vault, '08-Mudanças', 'promote-me')), false);
    assert.equal(readFileSync(source, 'utf8'), original);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] FLOW ativo rejeita CURRENT_SESSION por hardlink antes de reservar ou projetar', (t) => {
  const fx = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-promotion-session-control-hardlink-'));
  try {
    const active = start(fx, { flowId: 'flow-session-control-hardlink' });
    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 2;\n');
    const source = join(outside, 'CURRENT_SESSION.md');
    const original = 'status: external\n';
    writeFileSync(source, original);
    try {
      linkSync(source, join(fx.vault, '.brain', 'CURRENT_SESSION.md'));
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
        t.skip(`hardlinks indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    assert.throws(() => promoteFlow({
      vaultBase: fx.vault,
      projectRoot: fx.root,
      flowId: active.contract.flow_id,
    }), (error) => error?.code === 'FLOW_VAULT_BOUNDARY' && /hardlink|nlink/i.test(error.message));
    const state = readFlow(fx.vault, {
      sessionId: 'session-promote', flowId: active.contract.flow_id,
    });
    assert.equal(state.state, 'active');
    assert.equal(state.reservation, null);
    assert.equal(readFileSync(source, 'utf8'), original);
    assert.equal(existsSync(join(fx.vault, '08-Mudanças', 'promote-me')), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] retry rejeita flow-origin ou proposta por hardlink sem alterar origem externa', async (t) => {
  for (const artifact of ['flow-origin.json', 'proposta.md']) {
    await t.test(artifact, (subtest) => {
      const fx = fixture();
      const outside = mkdtempSync(join(tmpdir(), 'wk-flow-promotion-retry-hardlink-'));
      try {
        const active = start(fx, { flowId: `flow-retry-${artifact.replace(/\W/g, '-')}` });
        writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 2;\n');
        const reserved = reservePromotionForRetry(fx, active);
        const changeDir = join(fx.vault, '08-Mudanças', 'promote-me');
        mkdirSync(changeDir, { recursive: true });
        if (artifact !== 'flow-origin.json') {
          writeFileSync(
            join(changeDir, 'flow-origin.json'),
            `${JSON.stringify(reserved.reservation.origin, null, 2)}\n`,
          );
        }
        const source = join(outside, artifact);
        const original = artifact === 'flow-origin.json'
          ? `${JSON.stringify(reserved.reservation.origin, null, 2)}\n`
          : '# proposta externa\n';
        writeFileSync(source, original);
        try {
          linkSync(source, join(changeDir, artifact));
        } catch (error) {
          if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
            subtest.skip(`hardlinks indisponíveis neste filesystem: ${error.code}`);
            return;
          }
          throw error;
        }

        assert.throws(() => promoteFlow({
          vaultBase: fx.vault,
          projectRoot: fx.root,
          flowId: active.contract.flow_id,
        }), (error) => error?.code === 'FLOW_VAULT_BOUNDARY' && /hardlink|nlink/i.test(error.message));
        assert.equal(readFlow(fx.vault, {
          sessionId: 'session-promote', flowId: active.contract.flow_id,
        }).state, 'promoting');
        assert.equal(readFileSync(source, 'utf8'), original);
      } finally {
        rmSync(fx.root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });
  }
});

test('[req:OP-7] retry sem origem valida artefato inesperado antes de reportar conflito', (t) => {
  const fx = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-promotion-retry-unexpected-'));
  try {
    const active = start(fx, { flowId: 'flow-retry-unexpected-hardlink' });
    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 2;\n');
    reservePromotionForRetry(fx, active);
    const changeDir = join(fx.vault, '08-Mudanças', 'promote-me');
    mkdirSync(changeDir, { recursive: true });
    const source = join(outside, 'unexpected.md');
    const original = '# artefato externo\n';
    writeFileSync(source, original);
    try {
      linkSync(source, join(changeDir, 'unexpected.md'));
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) {
        t.skip(`hardlinks indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    assert.throws(() => promoteFlow({
      vaultBase: fx.vault,
      projectRoot: fx.root,
      flowId: active.contract.flow_id,
    }), (error) => error?.code === 'FLOW_VAULT_BOUNDARY' && /hardlink|nlink/i.test(error.message));
    assert.equal(readFlow(fx.vault, {
      sessionId: 'session-promote', flowId: active.contract.flow_id,
    }).state, 'promoting');
    assert.equal(readFileSync(source, 'utf8'), original);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] promoção não cria change quando a sessão não aceita projeção', () => {
  const fx = fixture();
  try {
    const active = start(fx, { flowId: 'flow-missing-session' });
    unlinkSync(fx.sessionPath);
    assert.throws(() => promoteFlow({
      vaultBase: fx.vault,
      projectRoot: fx.root,
      flowId: active.contract.flow_id,
    }), /sessão.*projeção|nota.*sessão/i);
    assert.equal(existsSync(join(fx.vault, '08-Mudanças', 'promote-me')), false);
    assert.equal(readFlow(fx.vault, {
      sessionId: 'session-promote', flowId: active.contract.flow_id,
    }).state, 'active');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
