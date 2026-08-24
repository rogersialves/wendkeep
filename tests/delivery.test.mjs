import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  abandonDelivery, activeDelivery, DELIVERY_HELP, finishDelivery, runDelivery, startDelivery,
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
  writeFileSync(join(repo, 'CHANGELOG.md'), '# Changelog\n\n## [1.2.3] — 2026-08-20\n- Delivery fixture.\n');
  git(repo, ['add', 'package.json', 'CHANGELOG.md']);
  git(repo, ['commit', '-m', 'release']);
  const commit = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['tag', '-a', 'v1.2.3', '-m', 'v1.2.3']);
  git(repo, ['remote', 'add', 'origin', 'https://github.com/example/project.git']);
  git(repo, ['update-ref', 'refs/remotes/origin/main', commit]);
  return { repo, vault, commit };
}

function executeWithRemoteTarget(commit, ref = 'refs/heads/main') {
  return (command, args, options = {}) => {
    if (command === 'git' && args[0] === 'ls-remote') return `${commit}\t${ref}\n`;
    return execFileSync(command, args, options);
  };
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

function captureDeliveryCli(argv) {
  let stdout = '';
  let stderr = '';
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  process.stdout.write = (chunk) => { stdout += String(chunk); return true; };
  process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
  try {
    return { code: runDelivery(argv), stdout, stderr };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

test('delivery registra autorização e receipt sem criar change/spec/ADR', () => {
  const { repo, vault, commit } = fixture();
  try {
    const state = startDelivery({
      vaultBase: vault,
      repoRoot: repo,
      id: 'release-1-2-3',
      capabilities: ['git:push'],
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
      target: 'origin/main',
      execute: executeWithRemoteTarget(commit),
      now: new Date('2026-08-20T10:05:00Z'),
    });
    assert.equal(receipt.outcome, 'completed');
    assert.equal(receipt.target_commit, commit);
    const ledger = readFileSync(join(vault, '.brain', 'runtime', 'delivery-receipts-v2.jsonl'), 'utf8');
    assert.equal(JSON.parse(ledger.trim()).subject.delivery_id, state.id);
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

test('[req:PROV-4] delivery normaliza source ref para o SHA completo no start', () => {
  const { repo, vault, commit } = fixture();
  try {
    const state = startDelivery({
      vaultBase: vault, repoRoot: repo, id: 'source-full-sha', capabilities: ['git:pull'], sourceCommit: 'HEAD',
    });
    assert.equal(state.source_commit, commit);
    assert.match(state.route.source_commit, /^[0-9a-f]{40}$/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:PROV-4] delivery captura a identidade normalizada do remote permitido no start', () => {
  const { repo, vault } = fixture();
  try {
    const state = startDelivery({
      vaultBase: vault, repoRoot: repo, id: 'bound-remote', capabilities: ['git:push'],
    });
    assert.equal(state.remote_repository, 'example/project');
    assert.equal(state.remote_name, 'origin');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:PROV-4] merge e push bloqueiam destino omitido sem gravar completion receipt', () => {
  for (const capability of ['git:merge', 'git:push']) {
    const { repo, vault } = fixture();
    try {
      const state = startDelivery({
        vaultBase: vault, repoRoot: repo, id: `missing-target-${capability.slice(4)}`, capabilities: [capability],
      });
      assert.throws(
        () => finishDelivery({ vaultBase: vault, repoRoot: repo, id: state.id }),
        (error) => error?.code === 'WENDKEEP_PROVENANCE_GATE_BLOCKED',
      );
      assert.equal(existsSync(join(vault, '.brain', 'runtime', 'delivery-receipts-v2.jsonl')), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(vault, { recursive: true, force: true });
    }
  }
});

test('[req:PROV-4] push deriva o destino do remote observado, não do remote-tracking local stale', () => {
  const { repo, vault, commit } = fixture();
  try {
    const state = startDelivery({
      vaultBase: vault, repoRoot: repo, id: 'authoritative-remote-target', capabilities: ['git:push'],
    });
    writeFileSync(join(repo, 'remote.txt'), 'remote target\n');
    git(repo, ['add', 'remote.txt']);
    git(repo, ['commit', '-m', 'remote target']);
    const remoteCommit = git(repo, ['rev-parse', 'HEAD']);
    assert.notEqual(remoteCommit, commit);

    const receipt = finishDelivery({
      vaultBase: vault,
      repoRoot: repo,
      id: state.id,
      target: 'origin/main',
      execute: executeWithRemoteTarget(remoteCommit),
    });
    assert.equal(receipt.target_commit, remoteCommit);
    assert.equal(receipt.observations.remote_target.commit, remoteCommit);
    assert.equal(receipt.observations.remote_target.remote, 'origin');
    assert.equal(receipt.observations.remote_target.ref, 'refs/heads/main');
    assert.equal(receipt.observations.remote_target.repository, 'example/project');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:PROV-4] troca do remote após start é conflict e não gera receipt', () => {
  const { repo, vault, commit } = fixture();
  try {
    const state = startDelivery({
      vaultBase: vault, repoRoot: repo, id: 'remote-changed', capabilities: ['git:push'],
    });
    git(repo, ['remote', 'set-url', 'origin', 'https://github.com/foreign/project.git']);
    assert.throws(
      () => finishDelivery({
        vaultBase: vault,
        repoRoot: repo,
        id: state.id,
        target: 'origin/main',
        execute: executeWithRemoteTarget(commit),
      }),
      (error) => error?.code === 'WENDKEEP_PROVENANCE_GATE_BLOCKED'
        && error?.provenance?.state === 'conflict',
    );
    assert.equal(existsSync(join(vault, '.brain', 'runtime', 'delivery-receipts-v2.jsonl')), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:PROV-4] finish remains bound to the repository, worktree, and branch captured at start', () => {
  for (const mutation of ['worktree', 'branch']) {
    const { repo, vault } = fixture();
    try {
      const state = startDelivery({
        vaultBase: vault, repoRoot: repo, id: `checkout-${mutation}`, capabilities: ['git:pull'],
      });
      let finishRoot = repo;
      if (mutation === 'worktree') {
        finishRoot = join(repo, 'nested');
        mkdirSync(finishRoot);
      } else {
        git(repo, ['checkout', '-b', 'other-branch']);
      }
      assert.throws(
        () => finishDelivery({ vaultBase: vault, repoRoot: finishRoot, id: state.id }),
        (error) => error?.code === 'WENDKEEP_DELIVERY_SCOPE_MISMATCH',
      );
      assert.equal(existsSync(join(vault, '.brain', 'runtime', 'delivery-receipts-v2.jsonl')), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(vault, { recursive: true, force: true });
    }
  }
});

test('[req:PROV-4] a contextual delivery cannot be finished or abandoned through the context-free API', () => {
  for (const operation of ['finish', 'abandon']) {
    const { repo, vault } = fixture();
    try {
      const context = identity(`context-${operation}`, `session-${operation}`);
      const state = startDelivery({
        vaultBase: vault, repoRoot: repo, id: `context-required-${operation}`,
        capabilities: ['git:pull'], context,
      });
      assert.throws(
        () => operation === 'finish'
          ? finishDelivery({ vaultBase: vault, repoRoot: repo, id: state.id })
          : abandonDelivery({ vaultBase: vault, id: state.id, reason: 'must provide context' }),
        (error) => error?.code === 'WENDKEEP_DELIVERY_CONTEXT_MISMATCH',
      );
      assert.equal(activeDelivery(vault, { context }).id, state.id);
      assert.match(readFileSync(join(vault, '.brain', 'runtime', 'deliveries', `${state.id}.json`), 'utf8'), /"state": "active"/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(vault, { recursive: true, force: true });
    }
  }
});

test('[req:PROV-4] remote target must name the remote captured at start even when an alias has the same URL', () => {
  const { repo, vault, commit } = fixture();
  let consultedRemote = false;
  try {
    git(repo, ['remote', 'add', 'mirror', 'https://github.com/example/project.git']);
    const state = startDelivery({
      vaultBase: vault, repoRoot: repo, id: 'remote-alias', capabilities: ['git:push'],
    });
    assert.throws(
      () => finishDelivery({
        vaultBase: vault,
        repoRoot: repo,
        id: state.id,
        target: 'mirror/main',
        execute(command, args, options = {}) {
          if (command === 'git' && args[0] === 'ls-remote') {
            consultedRemote = true;
            return `${commit}\trefs/heads/main\n`;
          }
          return execFileSync(command, args, options);
        },
      }),
      (error) => error?.code === 'WENDKEEP_PROVENANCE_GATE_BLOCKED'
        && error?.provenance?.state === 'conflict',
    );
    assert.equal(consultedRemote, false);
    assert.equal(existsSync(join(vault, '.brain', 'runtime', 'delivery-receipts-v2.jsonl')), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:PROV-4] delivery help describes remote branch targets explicitly', () => {
  assert.match(DELIVERY_HELP, /--target <remote>\/<branch>/);
  assert.doesNotMatch(DELIVERY_HELP, /--target <ref>/);
});

test('[req:PROV-8] delivery failures expose equivalent structured diagnostics in text and JSON', () => {
  const { repo, vault } = fixture();
  try {
    const state = startDelivery({
      vaultBase: vault, repoRoot: repo, id: 'json-diagnostics', capabilities: ['git:push'],
    });
    const common = ['finish', state.id, '--project', repo, '--vault', vault];
    const jsonResult = captureDeliveryCli([...common, '--json']);
    assert.equal(jsonResult.code, 2);
    const payload = JSON.parse(jsonResult.stderr);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'WENDKEEP_PROVENANCE_GATE_BLOCKED');
    assert.equal(payload.operation, 'delivery.finish');
    assert.equal(payload.state, 'unproven');
    assert.equal(payload.blocker, 'PROVENANCE_REMOTE_TARGET_REQUIRED');
    assert.match(payload.recovery, /^wendkeep /);
    assert.equal(jsonResult.stdout, '');

    const textResult = captureDeliveryCli(common);
    assert.equal(textResult.code, 2);
    for (const field of ['operation', 'state', 'blocker', 'expected', 'observed', 'recovery']) {
      assert.ok(textResult.stderr.includes(`${field}=`), field);
    }
    for (const value of [payload.operation, payload.state, payload.blocker, payload.recovery]) {
      assert.ok(textResult.stderr.includes(value), value);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:PROV-4] completed receipt binds repository, worktree, branch, work session, and change', () => {
  const { repo, vault } = fixture();
  try {
    const context = identity('receipt-worktree', 'receipt-session');
    const state = startDelivery({
      vaultBase: vault,
      repoRoot: repo,
      id: 'complete-binding',
      capabilities: ['git:pull'],
      sourceChange: 'provenance-gates',
      context,
    });
    const receipt = finishDelivery({ vaultBase: vault, repoRoot: repo, id: state.id, context });
    const record = JSON.parse(readFileSync(
      join(vault, '.brain', 'runtime', 'delivery-receipts-v2.jsonl'), 'utf8',
    ).trim());
    const expected = {
      project_id: context.projectId,
      repository_id: context.repositoryId,
      repository: 'example/project',
      worktree_id: context.worktreeId,
      work_session_id: context.workSessionId,
      change_slug: 'provenance-gates',
      branch: state.branch,
    };
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(record.subject[key], value, `ledger subject ${key}`);
      assert.equal(receipt[key], value, `public receipt ${key}`);
    }
    assert.doesNotMatch(JSON.stringify(record), new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:PROV-4] retry of a completed contextual delivery works after its binding was cleared', () => {
  const { repo, vault } = fixture();
  try {
    const context = identity('retry-worktree', 'retry-session');
    const state = startDelivery({
      vaultBase: vault, repoRoot: repo, id: 'context-completed-retry', capabilities: ['git:pull'], context,
    });
    const input = { vaultBase: vault, repoRoot: repo, id: state.id, context };
    const first = finishDelivery(input);
    assert.equal(resolveActiveContext(vault, context).delivery_id, '');
    const ledgerPath = join(vault, '.brain', 'runtime', 'delivery-receipts-v2.jsonl');
    const before = readFileSync(ledgerPath, 'utf8');
    const replay = finishDelivery(input);
    assert.equal(replay.receipt_hash, first.receipt_hash);
    assert.equal(readFileSync(ledgerPath, 'utf8'), before);
    assert.equal(resolveActiveContext(vault, context).delivery_id, '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:PROV-8] git failures and abandon reasons cannot expose refs, tokens, or private paths', () => {
  const { repo, vault } = fixture();
  const secret = 'secret-token-value';
  const privatePath = 'C:\\private\\vault\\customer.txt';
  try {
    assert.throws(
      () => startDelivery({
        vaultBase: vault, repoRoot: repo, id: 'git-secret', capabilities: ['git:pull'], sourceCommit: secret,
      }),
      (error) => error?.code === 'WENDKEEP_DELIVERY_GIT_FAILED'
        && !String(error.message).includes(secret)
        && !String(error.message).includes(repo),
    );

    const context = identity('abandon-worktree', 'abandon-session');
    const state = startDelivery({
      vaultBase: vault, repoRoot: repo, id: 'sanitized-abandon', capabilities: ['git:pull'], context,
    });
    const receipt = abandonDelivery({
      vaultBase: vault, id: state.id, context, reason: `token=${secret} path=${privatePath}`,
    });
    const stateRaw = readFileSync(join(vault, '.brain', 'runtime', 'deliveries', `${state.id}.json`), 'utf8');
    const ledgerRaw = readFileSync(join(vault, '.brain', 'runtime', 'delivery-receipts-v2.jsonl'), 'utf8');
    const exposed = JSON.stringify(receipt) + stateRaw + ledgerRaw;
    assert.doesNotMatch(exposed, /secret-token-value|private[\\/]vault|customer\.txt/i);
    assert.match(receipt.reason_digest, /^sha256:[0-9a-f]{64}$/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:PROV-4] contextual finalization stays bound until receipt and state are durable', () => {
  for (const operation of ['finish', 'abandon']) {
    for (const failurePoint of ['append', 'persist']) {
    const { repo, vault } = fixture();
    try {
      const context = identity(`durable-${operation}-${failurePoint}`, `durable-session-${operation}-${failurePoint}`);
      const state = startDelivery({
        vaultBase: vault, repoRoot: repo, id: `durable-${operation}-${failurePoint}`, capabilities: ['git:pull'], context,
      });
      const failure = new Error(`synthetic ${operation} ${failurePoint} failure`);
      const dependencies = {
        appendLedger: failurePoint === 'append'
          ? () => {
            assert.equal(activeDelivery(vault, { context }).id, state.id);
            throw failure;
          }
          : undefined,
        persistState: failurePoint === 'persist'
          ? () => {
            assert.equal(activeDelivery(vault, { context }).id, state.id);
            throw failure;
          }
          : undefined,
      };
      assert.throws(
        () => operation === 'finish'
          ? finishDelivery({
            vaultBase: vault, repoRoot: repo, id: state.id, context,
            ...dependencies,
          })
          : abandonDelivery({
            vaultBase: vault, id: state.id, context, reason: 'durability test',
            ...dependencies,
          }),
        (error) => error === failure,
      );
      assert.equal(activeDelivery(vault, { context }).id, state.id);
      assert.match(readFileSync(join(vault, '.brain', 'runtime', 'deliveries', `${state.id}.json`), 'utf8'), /"state": "active"/);
      assert.equal(
        existsSync(join(vault, '.brain', 'runtime', 'delivery-receipts-v2.jsonl')),
        failurePoint === 'persist',
      );
      if (failurePoint === 'persist') {
        const ledgerPath = join(vault, '.brain', 'runtime', 'delivery-receipts-v2.jsonl');
        const before = readFileSync(ledgerPath, 'utf8');
        const replay = operation === 'finish'
          ? finishDelivery({ vaultBase: vault, repoRoot: repo, id: state.id, context })
          : abandonDelivery({ vaultBase: vault, id: state.id, context, reason: 'durability test' });
        assert.equal(readFileSync(ledgerPath, 'utf8'), before);
        assert.match(replay.receipt_hash, /^sha256:[0-9a-f]{64}$/);
        assert.equal(resolveActiveContext(vault, context).delivery_id, '');
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(vault, { recursive: true, force: true });
    }
    }
  }
});

test('[req:PROV-4] a durable finalized state converges after context projection failure', () => {
  for (const operation of ['finish', 'abandon']) {
    const { repo, vault } = fixture();
    try {
      const context = identity(`projection-${operation}`, `projection-session-${operation}`);
      const state = startDelivery({
        vaultBase: vault, repoRoot: repo, id: `projection-retry-${operation}`, capabilities: ['git:pull'], context,
      });
      const failure = new Error(`synthetic ${operation} clear failure`);
      assert.throws(
        () => operation === 'finish'
          ? finishDelivery({
            vaultBase: vault, repoRoot: repo, id: state.id, context,
            clearContextDelivery: () => { throw failure; },
          })
          : abandonDelivery({
            vaultBase: vault, id: state.id, context, reason: 'projection durability',
            clearContextDelivery: () => { throw failure; },
          }),
        (error) => error === failure,
      );
      const persisted = JSON.parse(readFileSync(
        join(vault, '.brain', 'runtime', 'deliveries', `${state.id}.json`), 'utf8',
      ));
      assert.equal(persisted.state, operation === 'finish' ? 'completed' : 'abandoned');
      assert.equal(resolveActiveContext(vault, context).delivery_id, state.id);
      const replay = operation === 'finish'
        ? finishDelivery({ vaultBase: vault, repoRoot: repo, id: state.id, context })
        : abandonDelivery({ vaultBase: vault, id: state.id, context, reason: 'ignored on retry' });
      assert.equal(replay.receipt_hash, persisted.receipt.receipt_hash);
      assert.equal(resolveActiveContext(vault, context).delivery_id, '');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(vault, { recursive: true, force: true });
    }
  }
});

test('[req:PROV-7] retry de completed valida ledger, checkpoint e hash antes de retornar', () => {
  const { repo, vault } = fixture();
  try {
    const state = startDelivery({
      vaultBase: vault, repoRoot: repo, id: 'retry-validates-ledger', capabilities: ['git:tag'],
    });
    const input = {
      vaultBase: vault, repoRoot: repo, id: state.id, evidence: { version: '1.2.3' },
    };
    finishDelivery(input);
    writeFileSync(join(vault, '.brain', 'runtime', 'delivery-receipts-v2.jsonl'), '');
    assert.throws(
      () => finishDelivery(input),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_TRUNCATED',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:PROV-7] retry rejeita receipt do state que não coincide com o record encadeado', () => {
  const { repo, vault } = fixture();
  try {
    const state = startDelivery({
      vaultBase: vault, repoRoot: repo, id: 'retry-validates-subject', capabilities: ['git:tag'],
    });
    const input = {
      vaultBase: vault, repoRoot: repo, id: state.id, evidence: { version: '1.2.3' },
    };
    finishDelivery(input);
    const statePath = join(vault, '.brain', 'runtime', 'deliveries', `${state.id}.json`);
    const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
    persisted.receipt.target_commit = 'f'.repeat(40);
    writeFileSync(statePath, `${JSON.stringify(persisted, null, 2)}\n`);
    assert.throws(
      () => finishDelivery(input),
      (error) => error?.code === 'WENDKEEP_RECEIPT_LEDGER_CORRUPT',
    );
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
      vaultBase: vault, repoRoot: repo, id: 'delivery-a', capabilities: ['git:pull'], context: a,
    });
    const second = startDelivery({
      vaultBase: vault, repoRoot: repo, id: 'delivery-b', capabilities: ['git:pull'], context: b,
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
