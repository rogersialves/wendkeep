import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateReleaseProvenance,
  packageHasSelfDependency,
} from '../src/release-provenance.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function provenance(overrides = {}) {
  return {
    name: 'wendkeep',
    version: '0.72.1',
    headCommit: 'a'.repeat(40),
    tagCommit: 'a'.repeat(40),
    publishedIntegrity: 'sha512-published',
    localIntegrity: 'sha512-published',
    requirePublished: true,
    ...overrides,
  };
}

test('[req:REL-PROV-1] checkout de desenvolvimento não depende do próprio pacote publicado', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(packageHasSelfDependency(pkg), false);
  assert.equal(Object.hasOwn(lock.packages, 'node_modules/wendkeep'), false);
});
test('[req:REL-PROV-2] hooks versionados do próprio repositório executam o working tree', () => {
  for (const relative of ['.claude/settings.json', '.codex/hooks.json']) {
    const config = JSON.parse(readFileSync(join(ROOT, relative), 'utf8'));
    const commands = Object.values(config.hooks).flatMap((groups) => groups)
      .flatMap((group) => group.hooks || [])
      .filter((entry) => String(entry.command || '').includes('wendkeep'));
    assert.ok(commands.length > 0, `${relative} precisa conter hooks do WendKeep`);
    for (const entry of commands) {
      assert.match(entry.command, /^node \.\/bin\/wendkeep\.mjs hook [a-z-]+$/);
      assert.equal(entry.args, undefined);
      assert.doesNotMatch(entry.command, /node_modules|\bnpx\b/);
    }
  }
});

test('[req:REL-PROV-3] pacote consumidor usa npx sem instalação implícita', async () => {
  const { hookCommand, codexHookEntry } = await import('../packages/integrations/src/host-hooks.mjs');
  assert.equal(hookCommand('session-stop'), 'npx --no-install wendkeep hook session-stop');
  assert.equal(
    codexHookEntry({ name: 'session-stop', timeout: 60 }).command,
    'npx --no-install wendkeep hook session-stop',
  );
});

test('[req:REL-PROV-4] tag em outro commit bloqueia a mesma versão', () => {
  const result = evaluateReleaseProvenance(provenance({ tagCommit: 'b'.repeat(40) }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'tag_commit_mismatch');
});

test('[req:REL-PROV-5] tarball publicado divergente do SHA testado é rejeitado', () => {
  const result = evaluateReleaseProvenance(provenance({ localIntegrity: 'sha512-local' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'tarball_integrity_mismatch');
});

test('[req:REL-PROV-5] tag, commit e integridade iguais produzem receipt verificável', () => {
  assert.deepEqual(evaluateReleaseProvenance(provenance()), {
    ok: true,
    code: 'verified',
    name: 'wendkeep',
    version: '0.72.1',
    tag: 'v0.72.1',
    commit: 'a'.repeat(40),
    integrity: 'sha512-published',
  });
});

test('[req:REL-PROV-5] verificação pós-publicação falha se o registry ainda não comprova o pacote', () => {
  const result = evaluateReleaseProvenance(provenance({ publishedIntegrity: '' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'published_artifact_missing');
});
