import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('[req:OBS-7] Docker Observer publica somente loopback e não monta vaults', () => {
  const composePath = join(ROOT, 'docker', 'wendkeep-observer', 'compose.yaml');
  const dockerfilePath = join(ROOT, 'docker', 'wendkeep-observer', 'Dockerfile');
  assert.equal(existsSync(composePath), true);
  assert.equal(existsSync(dockerfilePath), true);
  const compose = readFileSync(composePath, 'utf8');
  assert.match(compose, /127\.0\.0\.1:8787:8787/);
  assert.match(compose, /observer-data/);
  assert.doesNotMatch(compose, /C:\\\\GitHub|\.WendKeep-vault/);
  assert.match(compose, /WENDKEEP_OBSERVER_TOKEN:\s*"?\$\{/);
  const dockerfile = readFileSync(dockerfilePath, 'utf8');
  assert.match(dockerfile, /healthz/);
  assert.match(dockerfile, /0\.0\.0\.0/);
  assert.match(dockerfile, /allow-non-loopback/);
});
