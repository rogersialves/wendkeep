import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');

test('[req:COMMIT-15] pacote raiz exporta kernel, empacota hooks/schema e checa a superfície', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.exports['./commit'], './packages/commit/src/index.mjs');
  assert.ok(pkg.files.includes('.githooks'));
  assert.match(pkg.scripts.check, /packages\/commit\/src\/index\.mjs/);
  assert.match(pkg.scripts.check, /scripts\/validate-commit-range\.mjs/);
  const workspace = JSON.parse(read('packages', 'commit', 'package.json'));
  assert.equal(workspace.name, '@wendkeep/commit');
  assert.equal(workspace.private, true);
  const schema = JSON.parse(read('schema', 'commit-message-v1.schema.json'));
  assert.ok(schema.properties.evidence.items.properties.kind.enum.includes('spec'));
});

test('[req:COMMIT-16] CI busca o histórico e valida todos os commits novos do PR', () => {
  const workflow = read('.github', 'workflows', 'test.yml');
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /validate-commit-range\.mjs/);
  assert.match(workflow, /github\.event\.pull_request\.base\.sha/);
  assert.match(workflow, /github\.event\.pull_request\.head\.sha/);
});

test('[req:COMMIT-17] documentação pública é bilíngue e descreve opt-in, privacidade e recuperação', () => {
  const cases = [
    { locale: 'pt-BR', optIn: /opt-in|opcional/i, privacy: /Vault|privad/i, recovery: /doctor|recuper/i },
    { locale: 'en', optIn: /opt-in|optional/i, privacy: /Vault|private/i, recovery: /doctor|recover/i },
  ];
  for (const expected of cases) {
    const guide = read('docs', expected.locale, 'commands', 'commit.md');
    assert.match(guide, /wendkeep commit context/);
    assert.match(guide, /wendkeep commit validate/);
    assert.match(guide, /--git-commit-hooks/);
    assert.match(guide, expected.optIn);
    assert.match(guide, expected.privacy);
    assert.match(guide, expected.recovery);
    assert.match(guide, /native-no-causal-change/);
    assert.match(guide, /rederiv|re-deriv/i);
    assert.match(guide, /perfil.*OFF|profile.*OFF/i);
    assert.match(guide, /context|contexto/i);
    assert.match(guide, /docs\/superpowers\/specs/);
    assert.match(guide, /Remote-Proof-Scope/);
    assert.match(guide, /Local-Causal-Proof/);
    assert.match(guide, /REMOTE_PROOF_UNAVAILABLE/);
  }
  assert.match(read('README.md'), /wendkeep commit/);
  assert.match(read('README.en.md'), /wendkeep commit/);
});
