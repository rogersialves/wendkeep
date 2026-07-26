// [req:MEM-HYB-3] [req:MEM-HYB-7] [req:MEM-HYB-9]
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCoreSkeleton } from '../src/validate-core.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

function fixture() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-memory-cli-'));
  const brain = join(vault, '.brain');
  mkdirSync(brain, { recursive: true });
  writeFileSync(join(brain, 'PROJECT.json'), '{"schemaVersion":1,"projectId":"project-a"}\n');
  writeFileSync(join(brain, 'CORE.md'), renderCoreSkeleton());
  writeFileSync(join(brain, 'SHARED_MEMORY.md'), '# Shared legacy\n\n## Estado\n- backend entregue\n\n## Próximo\n- revisão UI\n');
  return vault;
}

test('memory migrate é dry-run por padrão e não toca nenhum byte', async () => {
  const vault = fixture();
  const before = readFileSync(join(vault, '.brain', 'SHARED_MEMORY.md'), 'utf8');
  try {
    const { migrateMemory } = await import('../src/memory.mjs');
    const result = migrateMemory(vault);
    assert.equal(result.status, 'dry-run');
    assert.equal(readFileSync(join(vault, '.brain', 'SHARED_MEMORY.md'), 'utf8'), before);
    assert.equal(existsSync(join(vault, '.brain', 'MEMORY_EVENTS.jsonl')), false);
    assert.equal(existsSync(result.backupPath), false);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('memory migrate --apply em vault sem SHARED apenas cria bundle v2 vazio', async () => {
  const vault = fixture();
  rmSync(join(vault, '.brain', 'SHARED_MEMORY.md'));
  try {
    const { migrateMemory } = await import('../src/memory.mjs');
    const { checkMemoryBundle } = await import('../hooks/vault-health.mjs');
    const result = migrateMemory(vault, { apply: true });
    assert.equal(result.status, 'migrated');
    assert.equal(result.backupPath, null);
    assert.ok(existsSync(join(vault, '.brain', 'SHARED_MEMORY.md')));
    assert.equal(checkMemoryBundle(vault).status, 'healthy', 'migrate vazio e gate devem usar o mesmo state_hash canônico');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('memory migrate --apply preserva CORE, cria backup e bundle v2 válido com candidates', async () => {
  const vault = fixture();
  const core = readFileSync(join(vault, '.brain', 'CORE.md'), 'utf8');
  try {
    const { migrateMemory } = await import('../src/memory.mjs');
    const { validateMemoryBundle } = await import('../src/validate-memory.mjs');
    const result = migrateMemory(vault, { apply: true });
    assert.equal(result.status, 'migrated');
    assert.ok(existsSync(result.backupPath));
    assert.match(readFileSync(result.backupPath, 'utf8'), /backend entregue/);
    assert.equal(readFileSync(join(vault, '.brain', 'CORE.md'), 'utf8'), core);
    assert.match(readFileSync(join(vault, '.brain', 'MEMORY_CANDIDATES.jsonl'), 'utf8'), /backend entregue/);
    assert.equal(validateMemoryBundle(vault).ok, true);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('cada conteúdo legado distinto recebe seu próprio backup antes do apply', async () => {
  const vault = fixture();
  try {
    const { migrateMemory } = await import('../src/memory.mjs');
    const first = migrateMemory(vault, { apply: true });
    writeFileSync(join(vault, '.brain', 'SHARED_MEMORY.md'), '# outro legado\n\n- decisão B\n');
    const second = migrateMemory(vault, { apply: true });
    assert.notEqual(second.backupPath, first.backupPath);
    assert.match(readFileSync(second.backupPath, 'utf8'), /decisão B/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('migrate --apply reverte toda publicação quando a validação final falha', async () => {
  const vault = fixture();
  const brain = join(vault, '.brain');
  const legacy = readFileSync(join(brain, 'SHARED_MEMORY.md'), 'utf8');
  try {
    const { migrateMemory } = await import('../src/memory.mjs');
    assert.throws(
      () => migrateMemory(vault, {
        apply: true,
        validateBundle: () => ({ ok: false, errors: ['falha final injetada'] }),
      }),
      /falha final injetada/,
    );
    assert.equal(readFileSync(join(brain, 'SHARED_MEMORY.md'), 'utf8'), legacy);
    assert.equal(existsSync(join(brain, 'MEMORY_EVENTS.jsonl')), false);
    assert.equal(existsSync(join(brain, 'MEMORY_CANDIDATES.jsonl')), false);
    const backups = readdirSync(brain).filter((name) => name.includes('.legacy-') && name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(brain, backups[0]), 'utf8'), legacy);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('migrate valida bundle completo em staging antes de tocar nos paths finais', async () => {
  const vault = fixture();
  const brain = join(vault, '.brain');
  const legacy = readFileSync(join(brain, 'SHARED_MEMORY.md'), 'utf8');
  let staging = '';
  try {
    const { migrateMemory } = await import('../src/memory.mjs');
    const { validateMemoryBundle } = await import('../src/validate-memory.mjs');
    const result = migrateMemory(vault, {
      apply: true,
      validateBundle: (candidateVault) => {
        staging = candidateVault;
        assert.notEqual(candidateVault, vault, 'validação recebe um vault de staging');
        assert.equal(readFileSync(join(brain, 'SHARED_MEMORY.md'), 'utf8'), legacy, 'SHARED final ainda é legado');
        assert.equal(existsSync(join(brain, 'MEMORY_EVENTS.jsonl')), false, 'ledger final ainda não foi criado');
        assert.equal(existsSync(join(brain, 'MEMORY_CANDIDATES.jsonl')), false, 'candidates final ainda não foi criado');
        const stagedBrain = join(candidateVault, '.brain');
        assert.equal(readFileSync(join(stagedBrain, 'CORE.md'), 'utf8'), readFileSync(join(brain, 'CORE.md'), 'utf8'));
        assert.equal(readFileSync(join(stagedBrain, 'PROJECT.json'), 'utf8'), readFileSync(join(brain, 'PROJECT.json'), 'utf8'));
        assert.match(readFileSync(join(stagedBrain, 'SHARED_MEMORY.md'), 'utf8'), /schema_version: 2/);
        assert.match(readFileSync(join(stagedBrain, 'MEMORY_CANDIDATES.jsonl'), 'utf8'), /backend entregue/);
        return validateMemoryBundle(candidateVault);
      },
    });
    assert.equal(result.status, 'migrated');
    assert.ok(staging);
    assert.equal(existsSync(staging), false, 'staging removido após validação/publicação');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('falha durante publish restaura todos os paths finais e mantém backup', async () => {
  const vault = fixture();
  const brain = join(vault, '.brain');
  const legacy = readFileSync(join(brain, 'SHARED_MEMORY.md'), 'utf8');
  try {
    const { migrateMemory } = await import('../src/memory.mjs');
    const { writeFileAtomic } = await import('../hooks/session-note-io.mjs');
    let writes = 0;
    assert.throws(() => migrateMemory(vault, {
      apply: true,
      publishArtifact: (path, content) => {
        writes += 1;
        if (writes === 2) throw new Error('publish injetado');
        writeFileAtomic(path, content);
      },
    }), /publish injetado/);
    assert.equal(readFileSync(join(brain, 'SHARED_MEMORY.md'), 'utf8'), legacy);
    assert.equal(existsSync(join(brain, 'MEMORY_EVENTS.jsonl')), false);
    assert.equal(existsSync(join(brain, 'MEMORY_CANDIDATES.jsonl')), false);
    const backups = readdirSync(brain).filter((name) => name.includes('.legacy-') && name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(brain, backups[0]), 'utf8'), legacy);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('promote e reject referenciam candidate e apenas acrescentam eventos ao ledger', async () => {
  const vault = fixture();
  try {
    const { migrateMemory, decideMemoryCandidate } = await import('../src/memory.mjs');
    migrateMemory(vault, { apply: true });
    const candidates = readFileSync(join(vault, '.brain', 'MEMORY_CANDIDATES.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(candidates.length >= 2);
    const first = decideMemoryCandidate(vault, { action: 'promote', candidateId: candidates[0].candidate_id });
    const second = decideMemoryCandidate(vault, { action: 'reject', candidateId: candidates[1].candidate_id });
    assert.equal(first.status, 'promoted');
    assert.equal(second.status, 'rejected');
    const ledger = readFileSync(join(vault, '.brain', 'MEMORY_EVENTS.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(ledger.some((event) => event.evidence.includes(`candidate:${candidates[0].candidate_id}`)));
    assert.ok(ledger.some((event) => event.evidence.includes(`candidate:${candidates[1].candidate_id}`)));
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('memory repair preserva bytes corrompidos em backup antes de reconstruir', async () => {
  const vault = fixture();
  try {
    const { migrateMemory, repairMemory } = await import('../src/memory.mjs');
    migrateMemory(vault, { apply: true });
    const ledgerPath = join(vault, '.brain', 'MEMORY_EVENTS.jsonl');
    writeFileSync(ledgerPath, '{parcial');
    const result = repairMemory(vault);
    assert.equal(result.status, 'repaired');
    assert.ok(existsSync(result.repaired.backupPath));
    assert.equal(readFileSync(result.repaired.backupPath, 'utf8'), '{parcial');
    assert.equal(readFileSync(ledgerPath, 'utf8'), '');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('wendkeep memory roteia migrate dry-run/apply e expõe o comando no help', () => {
  const vault = fixture();
  try {
    const dry = spawnSync(process.execPath, [BIN, 'memory', 'migrate', '--vault', vault], { encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /dry-run/);
    assert.equal(existsSync(join(vault, '.brain', 'MEMORY_EVENTS.jsonl')), false);
    const apply = spawnSync(process.execPath, [BIN, 'memory', 'migrate', '--apply', '--vault', vault], { encoding: 'utf8' });
    assert.equal(apply.status, 0, apply.stderr);
    assert.match(apply.stdout, /migrated/);
    const help = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
    assert.match(help.stdout, /wendkeep memory/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
