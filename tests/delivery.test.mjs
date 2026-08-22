import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  abandonDelivery, activeDelivery, finishDelivery, startDelivery,
} from '../src/delivery.mjs';
import { buildChangePing } from '../hooks/change-context.mjs';
import { warnDecision } from '../hooks/change-warn.mjs';
import {
  clearActiveContextDelivery,
  resolveActiveContext,
  setActiveContextDelivery,
} from '../hooks/active-context-store.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'wk-delivery-repo-'));
  const vault = mkdtempSync(join(tmpdir(), 'wk-delivery-vault-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'delivery@example.test']);
  git(repo, ['config', 'user.name', 'Delivery Test']);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.2.3' }));
  git(repo, ['add', 'package.json']);
  git(repo, ['commit', '-m', 'release']);
  const commit = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['tag', '-a', 'v1.2.3', '-m', 'v1.2.3']);
  return { repo, vault, commit };
}

function identity(worktreeId, workSessionId) {
  return {
    projectId: 'project-delivery',
    repositoryId: 'repository-delivery',
    worktreeId,
    workSessionId,
    branch: `wk/${worktreeId}`,
    headSha: 'a'.repeat(40),
  };
}

test('delivery registra autorização e receipt sem criar change/spec/ADR', () => {
  const { repo, vault, commit } = fixture();
  try {
    const state = startDelivery({
      vaultBase: vault,
      repoRoot: repo,
      id: 'release-1-2-3',
      capabilities: ['git:push', 'publish'],
      sourceChange: 'feature-pronta',
      now: new Date('2026-08-20T10:00:00Z'),
    });
    assert.equal(state.route.work_kind, 'delivery');
    assert.equal(state.route.contract_impact, 'none');
    assert.equal(state.route.profile, 'ASSURE');
    assert.equal(state.source_commit, commit);
    assert.equal(existsSync(join(vault, '08-Mudanças')), false);
    assert.equal(existsSync(join(vault, '07-Specs')), false);
    assert.equal(existsSync(join(vault, '04-Decisões')), false);
    const ping = buildChangePing(vault, 'session-1', 'Corrija e publique a versão pronta', '', {
      profile: 'ASSURE',
    });
    assert.match(ping.context, /active_delivery/);
    assert.match(ping.context, /sem nova change\/spec/);
    assert.equal(buildChangePing(vault, 'session-1', 'publique novamente', '', { profile: 'ASSURE' }), null);
    assert.equal(warnDecision('src/release.mjs', {
      vaultBase: vault, cwd: repo, sessionId: 'session-1', profile: 'ASSURE',
    }), null);

    const receipt = finishDelivery({
      vaultBase: vault,
      repoRoot: repo,
      id: state.id,
      target: 'HEAD',
      evidence: {
        ci_url: 'https://github.test/actions/1',
        version: '1.2.3',
        npm_integrity: 'sha512-published',
        release_url: 'https://github.test/releases/v1.2.3',
      },
      now: new Date('2026-08-20T10:05:00Z'),
    });
    assert.equal(receipt.outcome, 'completed');
    assert.equal(receipt.target_commit, commit);
    const ledger = readFileSync(join(vault, '.brain', 'runtime', 'delivery-receipts.jsonl'), 'utf8');
    assert.equal(JSON.parse(ledger.trim()).delivery_id, state.id);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});

test('delivery interrompe quando surge edição e abandono também gera receipt', () => {
  const { repo, vault } = fixture();
  try {
    const state = startDelivery({
      vaultBase: vault, repoRoot: repo, id: 'dirty-delivery', capabilities: ['git:push'],
    });
    writeFileSync(join(repo, 'package.json'), '{"changed":true}');
    assert.throws(
      () => finishDelivery({ vaultBase: vault, repoRoot: repo, id: state.id }),
      (error) => error.code === 'WENDKEEP_DELIVERY_IMPLEMENTATION_REQUIRED',
    );
    git(repo, ['restore', 'package.json']);
    const receipt = abandonDelivery({
      vaultBase: vault, id: state.id, reason: 'código precisa ser corrigido',
    });
    assert.equal(receipt.outcome, 'abandoned');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});

test('delivery rejeita capabilities desconhecidas e exige prova da tag autorizada', () => {
  const { repo, vault } = fixture();
  try {
    assert.throws(
      () => startDelivery({ vaultBase: vault, repoRoot: repo, id: 'typo', capabilities: ['git:pus'] }),
      /capability inválida/,
    );
    const state = startDelivery({
      vaultBase: vault, repoRoot: repo, id: 'tag-only', capabilities: ['git:tag'],
    });
    assert.throws(
      () => finishDelivery({ vaultBase: vault, repoRoot: repo, id: state.id }),
      /--version/,
    );
    const receipt = finishDelivery({
      vaultBase: vault, repoRoot: repo, id: state.id, evidence: { version: '1.2.3' },
    });
    assert.equal(receipt.outcome, 'completed');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:ACTX-14] [req:ACTX-17] lifecycle resolves and clears only the owning active context', () => {
  const { repo, vault } = fixture();
  try {
    const a = identity('worktree-a', 'work-a');
    const b = identity('worktree-b', 'work-b');
    const first = startDelivery({
      vaultBase: vault, repoRoot: repo, id: 'delivery-a', capabilities: ['git:push'], context: a,
    });
    const second = startDelivery({
      vaultBase: vault, repoRoot: repo, id: 'delivery-b', capabilities: ['git:push'], context: b,
    });
    const secondPath = join(vault, '.brain', 'runtime', 'deliveries', 'delivery-b.json');
    const secondBefore = readFileSync(secondPath);

    assert.equal(activeDelivery(vault, { context: a }).id, first.id);
    assert.equal(activeDelivery(vault, { context: b }).id, second.id);
    assert.throws(
      () => finishDelivery({ vaultBase: vault, repoRoot: repo, id: first.id, context: b }),
      (error) => error?.code === 'WENDKEEP_DELIVERY_CONTEXT_MISMATCH',
    );

    const receipt = finishDelivery({
      vaultBase: vault, repoRoot: repo, id: first.id, context: a, target: 'HEAD',
    });
    assert.equal(receipt.outcome, 'completed');
    assert.equal(receipt.context_key, first.context_key);
    assert.equal(activeDelivery(vault, { context: a }), null);
    assert.equal(activeDelivery(vault, { context: b }).id, second.id);
    assert.equal(resolveActiveContext(vault, a).delivery_id, '');
    assert.equal(resolveActiveContext(vault, b).delivery_id, second.id);
    assert.deepEqual(readFileSync(secondPath), secondBefore);

    const abandoned = abandonDelivery({
      vaultBase: vault, id: second.id, context: b, reason: 'context-specific stop',
    });
    assert.equal(abandoned.outcome, 'abandoned');
    assert.equal(activeDelivery(vault, { context: b }), null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:ACTX-17] abandon records its context and preserves an active sibling byte-for-byte', () => {
  const { repo, vault } = fixture();
  try {
    const a = identity('worktree-a', 'work-a');
    const b = identity('worktree-b', 'work-b');
    const first = startDelivery({
      vaultBase: vault, repoRoot: repo, id: 'abandon-a', capabilities: ['git:push'], context: a,
    });
    const second = startDelivery({
      vaultBase: vault, repoRoot: repo, id: 'keep-b', capabilities: ['git:push'], context: b,
    });
    const siblingPath = join(vault, '.brain', 'runtime', 'deliveries', 'keep-b.json');
    const siblingBefore = readFileSync(siblingPath);

    const receipt = abandonDelivery({
      vaultBase: vault, id: first.id, context: a, reason: 'context-specific stop',
    });

    assert.equal(receipt.outcome, 'abandoned');
    assert.equal(receipt.context_key, first.context_key);
    assert.equal(activeDelivery(vault, { context: a }), null);
    assert.equal(activeDelivery(vault, { context: b }).id, second.id);
    assert.equal(resolveActiveContext(vault, b).delivery_id, second.id);
    assert.deepEqual(readFileSync(siblingPath), siblingBefore);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:ACTX-14] one context cannot replace an active delivery silently', () => {
  const { repo, vault } = fixture();
  try {
    const context = identity('worktree-a', 'work-a');
    startDelivery({
      vaultBase: vault, repoRoot: repo, id: 'delivery-a', capabilities: ['git:push'], context,
    });
    const secondPath = join(vault, '.brain', 'runtime', 'deliveries', 'delivery-a-2.json');
    assert.throws(
      () => startDelivery({
        vaultBase: vault, repoRoot: repo, id: 'delivery-a-2', capabilities: ['git:push'], context,
      }),
      (error) => error?.code === 'WENDKEEP_DELIVERY_CONTEXT_BUSY',
    );
    assert.equal(existsSync(secondPath), false);
    assert.equal(activeDelivery(vault, { context }).id, 'delivery-a');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:ACTX-15] start removes its new state when contextual bind fails', () => {
  const { repo, vault } = fixture();
  try {
    const statePath = join(vault, '.brain', 'runtime', 'deliveries', 'bind-fails.json');
    assert.throws(
      () => startDelivery({
        vaultBase: vault,
        repoRoot: repo,
        id: 'bind-fails',
        capabilities: ['git:push'],
        context: identity('worktree-a', 'work-a'),
        bindDelivery: () => { throw new Error('simulated context bind failure'); },
      }),
      /simulated context bind failure/,
    );
    assert.equal(existsSync(statePath), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:ACTX-16] hooks observe delivery only in the caller active context', () => {
  const { repo, vault } = fixture();
  try {
    const a = identity('worktree-a', 'work-a');
    const b = identity('worktree-b', 'work-b');
    assert.match(warnDecision('src/pre-context.mjs', {
      vaultBase: vault, cwd: repo, sessionId: 'session-before-context', profile: 'ASSURE', context: a,
    }), /change_warn/);
    setActiveContextDelivery(vault, a, 'temporary-a');
    clearActiveContextDelivery(vault, a);
    startDelivery({
      vaultBase: vault, repoRoot: repo, id: 'delivery-b', capabilities: ['git:push'], context: b,
    });

    assert.equal(buildChangePing(vault, 'session-a', 'publique a versão', '', {
      profile: 'ASSURE', context: a,
    }), null);
    assert.match(buildChangePing(vault, 'session-b', 'publique a versão', '', {
      profile: 'ASSURE', context: b,
    }).context, /Delivery delivery-b ativa/);

    assert.match(warnDecision('src/release.mjs', {
      vaultBase: vault, cwd: repo, sessionId: 'session-a', profile: 'ASSURE', context: a,
    }), /change_warn/);
    assert.equal(warnDecision('src/release.mjs', {
      vaultBase: vault, cwd: repo, sessionId: 'session-b', profile: 'ASSURE', context: b,
    }), null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});
