import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { finishDelivery, startDelivery } from '../src/delivery.mjs';
import {
  createFileReceiptStore,
  readReceiptLedger,
  verifyReceiptChain,
} from '../src/receipt-ledger.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'wendkeep.mjs');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function findFile(root, name) {
  if (!existsSync(root)) return '';
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(path, name);
      if (found) return found;
    } else if (entry.name === name) return path;
  }
  return '';
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'wk-provenance-e2e-repo-'));
  const vault = mkdtempSync(join(tmpdir(), 'wk-provenance-e2e-vault-'));
  mkdirSync(join(vault, '.brain'), { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'provenance-e2e@example.test']);
  git(repo, ['config', 'user.name', 'Provenance E2E']);
  git(repo, ['checkout', '-q', '-b', 'main']);
  writeJson(join(repo, 'package.json'), {
    name: 'provenance-e2e-fixture',
    version: '1.2.3',
    repository: 'https://github.com/example/project.git',
  });
  writeFileSync(join(repo, 'CHANGELOG.md'), '# Changelog\n\n## [1.2.3] — 2026-08-23\n- Provenance E2E.\n');
  writeJson(join(repo, 'wendkeep.sensors.json'), {
    version: 1,
    sensors: [{
      id: 'provenance-e2e',
      severity: 'critical',
      type: 'command',
      command: 'node -e "process.exit(0)"',
    }],
  });
  git(repo, ['add', 'package.json', 'CHANGELOG.md', 'wendkeep.sensors.json']);
  git(repo, ['commit', '-q', '-m', 'release 1.2.3']);
  const commit = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['tag', '-a', 'v1.2.3', '-m', 'v1.2.3']);
  git(repo, ['remote', 'add', 'origin', 'https://github.com/example/project.git']);
  git(repo, ['update-ref', 'refs/remotes/origin/main', commit]);
  return { repo, vault, commit };
}

function runCli(repo, vault, args) {
  return spawnSync(process.execPath, [BIN, ...args, '--vault', vault, '--project', repo], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function prepareChange(repo, vault) {
  const slug = 'provenance-e2e';
  const created = runCli(repo, vault, ['change', 'new', slug]);
  assert.equal(created.status, 0, created.stderr);
  const changeDir = join(vault, '08-Mudanças', slug);
  writeFileSync(join(changeDir, 'proposta.md'), `---
type: change
status: active
spec_impact: required
spec_impact_reason: "Contrato de proveniência e receipts v2"
specs: [provenance]
---

# ${slug}

## Por quê

O fluxo de archive e delivery precisa provar a mesma origem até a publicação.

## O que muda

Testa o encadeamento v2 sem consultar serviços externos.
`);
  writeFileSync(join(changeDir, 'design.md'), `# ${slug} — design

## Abordagem

O teste usa um repositório Git sintético, adapters autoritativos injetados e
ledgers v2 independentes para archive e delivery.
`);
  mkdirSync(join(changeDir, 'specs', 'provenance'), { recursive: true });
  writeFileSync(join(changeDir, 'specs', 'provenance', 'spec.md'), `## ADDED Requirements

### Requisito: PROV-1 — envelope v2 ligado ao archive
Archive exige pacote e verdict ligados ao envelope v2 atual.

### Requisito: PROV-2 — autorização de archive persistida
Archive autorizado persiste receipt v2, ADR e spec promovida.

### Requisito: PROV-3 — target remoto observável
Delivery resolve o commit do target remoto no mesmo repositório.

### Requisito: PROV-4 — cadeia de release vinculada
Tag, artefato, CI, NPM e release apontam para o mesmo commit e versão.

### Requisito: PROV-5 — adapters autoritativos
Adapters de publicação são injetáveis e suas observações governam o gate.

### Requisito: PROV-6 — receipt delivery v2
Delivery concluído grava receipt v2 e checkpoint verificável.

### Requisito: PROV-7 — fail-closed e idempotência
Elo divergente não conclui delivery; repetição válida é idempotente.
`);
  writeFileSync(join(changeDir, 'tarefas.md'), '- [x] 1.1 fluxo vertical de proveniência [req:PROV-1] [req:PROV-2] [req:PROV-3] [req:PROV-4] [req:PROV-5] [req:PROV-6] [req:PROV-7] [sensor:provenance-e2e]\n');
  return { slug, changeDir };
}

function archiveStore(repo) {
  const raw = git(repo, ['rev-parse', '--git-common-dir']);
  const commonDir = resolve(repo, raw);
  const runtime = join(commonDir, 'wendkeep');
  return createFileReceiptStore({
    ledgerPath: join(runtime, 'change-archive-receipts-v2.jsonl'),
    checkpointPath: join(runtime, 'change-archive-receipts-v2.checkpoint.json'),
    legacyPath: join(runtime, 'change-archive-receipts-v1.jsonl'),
    lockPath: join(runtime, 'change-archive-receipts-v2.lock'),
  });
}

function deliveryStore(vault) {
  const runtime = join(vault, '.brain', 'runtime');
  return createFileReceiptStore({
    ledgerPath: join(runtime, 'delivery-receipts-v2.jsonl'),
    checkpointPath: join(runtime, 'delivery-receipts-v2.checkpoint.json'),
    legacyPath: join(runtime, 'delivery-receipts.jsonl'),
    lockPath: join(runtime, 'delivery-receipts-v2.lock'),
  });
}

function executeWithRemoteTarget(commit) {
  return (command, args, options = {}) => {
    if (command === 'git' && args[0] === 'ls-remote') return `${commit}\trefs/heads/main\n`;
    return execFileSync(command, args, options);
  };
}

function authoritativeCollectors(commit, overrides = {}) {
  const repository = 'example/project';
  const version = '1.2.3';
  const packageName = 'provenance-e2e-fixture';
  const integrity = 'sha512-provenance-e2e';
  const base = {
    collectGitSubject() {
      return {
        ok: true,
        state: 'verified',
        sourceCommit: commit,
        targetCommit: commit,
        name: packageName,
        version,
        package: { name: packageName, version },
        notes: '- Provenance E2E.',
        changelog: '## [1.2.3] — 2026-08-23\n- Provenance E2E.',
      };
    },
    collectArtifactObservation() {
      return { ok: true, state: 'verified', commit, integrity };
    },
    collectTagObservation() {
      return { ok: true, state: 'verified', name: 'v1.2.3', tag: 'v1.2.3', commit };
    },
    collectCiObservation() {
      return { ok: true, state: 'verified', status: 'success', conclusion: 'success', commit, repository };
    },
    collectNpmObservation() {
      return {
        ok: true, state: 'verified', name: packageName, version, integrity, commit, repository,
      };
    },
    collectGitHubReleaseObservation() {
      return {
        ok: true, state: 'verified', tag: 'v1.2.3', version, commit, repository, status: 'published',
      };
    },
  };
  return { ...base, ...overrides };
}

function publishEvidence() {
  return {
    ci_url: 'https://github.com/example/project/actions/runs/42',
    version: '1.2.3',
    npm_integrity: 'sha512-provenance-e2e',
    release_url: 'https://github.com/example/project/releases/tag/v1.2.3',
  };
}

test('[req:PROV-1] [req:PROV-2] [req:PROV-3] [req:PROV-4] [req:PROV-5] [req:PROV-6] [req:PROV-7] percorre verify → archive → delivery → publicação sem rede e falha fechado', () => {
  const { repo, vault, commit } = fixture();
  try {
    const { slug, changeDir } = prepareChange(repo, vault);
    const deep = runCli(repo, vault, ['verify', '--deep', '--change', slug]);
    assert.equal(deep.status, 0, deep.stderr);
    const verification = JSON.parse(readFileSync(join(changeDir, 'verificacao.json'), 'utf8'));
    writeJson(join(changeDir, 'verdict.json'), {
      slug,
      ok: true,
      coverage: ['PROV-1', 'PROV-2', 'PROV-3', 'PROV-4', 'PROV-5', 'PROV-6', 'PROV-7']
        .map((req) => ({ req, covered: true })),
      tasksHash: verification.tasksHash,
      effectiveSpecHash: verification.effectiveSpecHash,
      evidenceEnvelopeId: verification.evidenceEnvelopeId,
      evidenceBinding: verification.evidenceBinding,
      notes: [],
    });

    const archived = runCli(repo, vault, ['change', 'archive', slug]);
    assert.equal(archived.status, 0, archived.stderr);
    const adr = findFile(join(vault, '04-Decisões'), 'ADR-0001-provenance-e2e.md');
    assert.ok(adr, 'archive deve gerar ADR');
    assert.match(readFileSync(adr, 'utf8'), /PROV-1|provenance/i);
    const promotedSpec = join(vault, '07-Specs', 'provenance.md');
    assert.ok(existsSync(promotedSpec), 'archive deve promover a spec');
    assert.match(readFileSync(promotedSpec, 'utf8'), /PROV-7/);

    const archiveLedger = readReceiptLedger({ store: archiveStore(repo) });
    const archiveReceipt = archiveLedger.records.find((record) => record.kind === 'change-archive-authorization');
    assert.ok(archiveReceipt, 'archive deve registrar autorização v2');
    assert.equal(archiveReceipt.schema_version, 2);
    assert.equal(archiveReceipt.subject.operation, 'archive');
    assert.equal(archiveReceipt.subject.outcome, 'authorized');
    assert.equal(archiveReceipt.subject.change_slug, slug);
    assert.match(archiveReceipt.subject.evidence_envelope_id, /^sha256:[0-9a-f]{64}$/);
    assert.equal(verifyReceiptChain({ records: archiveLedger.records, checkpoint: archiveLedger.checkpoint }).ok, true);

    const delivery = startDelivery({
      vaultBase: vault,
      repoRoot: repo,
      id: 'provenance-e2e-release',
      capabilities: ['git:push', 'git:tag', 'publish'],
      sourceChange: slug,
      sourceCommit: commit,
      now: new Date('2026-08-23T12:00:00.000Z'),
    });
    const execute = executeWithRemoteTarget(commit);
    const collectors = authoritativeCollectors(commit);
    const receipt = finishDelivery({
      vaultBase: vault,
      repoRoot: repo,
      id: delivery.id,
      target: 'origin/main',
      evidence: publishEvidence(),
      collectors,
      execute,
      now: new Date('2026-08-23T12:01:00.000Z'),
    });
    assert.equal(receipt.outcome, 'completed');
    assert.equal(receipt.schema_version, 2);
    assert.equal(receipt.kind, 'delivery.completed');
    assert.equal(receipt.delivery_id, delivery.id);
    assert.equal(receipt.source_commit, commit);
    assert.equal(receipt.target_commit, commit);
    assert.equal(receipt.observations.remote_target.commit, commit);
    assert.equal(receipt.observations.release.commit, commit);
    assert.equal(receipt.observations.npm.integrity, 'sha512-provenance-e2e');

    const deliveryReceiptStore = deliveryStore(vault);
    const deliveryLedger = readReceiptLedger({ store: deliveryReceiptStore });
    assert.equal(deliveryLedger.records.length, 1);
    assert.equal(deliveryLedger.records[0].kind, 'delivery.completed');
    assert.equal(deliveryLedger.records[0].subject.delivery_id, delivery.id);
    assert.equal(verifyReceiptChain({ records: deliveryLedger.records, checkpoint: deliveryLedger.checkpoint }).ok, true);
    const ledgerBytes = readFileSync(deliveryReceiptStore.ledgerPath, 'utf8');
    const repeated = finishDelivery({
      vaultBase: vault,
      repoRoot: repo,
      id: delivery.id,
      collectors,
      execute,
      now: new Date('2026-08-23T12:02:00.000Z'),
    });
    assert.deepEqual(repeated, receipt, 'finish repetido deve devolver o mesmo receipt');
    assert.equal(readFileSync(deliveryReceiptStore.ledgerPath, 'utf8'), ledgerBytes, 'idempotência não duplica o ledger');

    const negative = startDelivery({
      vaultBase: vault,
      repoRoot: repo,
      id: 'provenance-e2e-negative',
      capabilities: ['git:push', 'git:tag', 'publish'],
      sourceChange: slug,
      sourceCommit: commit,
      now: new Date('2026-08-23T12:03:00.000Z'),
    });
    const foreignCommit = 'f'.repeat(40);
    assert.throws(
      () => finishDelivery({
        vaultBase: vault,
        repoRoot: repo,
        id: negative.id,
        target: 'origin/main',
        evidence: publishEvidence(),
        collectors: authoritativeCollectors(commit, {
          collectGitHubReleaseObservation: () => ({
            ok: true,
            state: 'verified',
            tag: 'v1.2.3',
            version: '1.2.3',
            commit: foreignCommit,
            repository: 'example/project',
            status: 'published',
          }),
        }),
        execute,
        now: new Date('2026-08-23T12:04:00.000Z'),
      }),
      (error) => error?.code === 'WENDKEEP_PROVENANCE_GATE_BLOCKED'
        && ['conflict', 'stale', 'unproven'].includes(error?.provenance?.state),
    );
    const afterNegative = readReceiptLedger({ store: deliveryStore(vault) });
    assert.equal(afterNegative.records.length, 1, 'elo divergente não pode gravar completion receipt');
    assert.equal(afterNegative.records.some((record) => record.subject.delivery_id === negative.id), false);
    assert.equal(JSON.parse(readFileSync(join(vault, '.brain', 'runtime', 'deliveries', `${negative.id}.json`), 'utf8')).state, 'active');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});
