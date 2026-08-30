import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getLocale } from '../hooks/locale.mjs';
import { writeVaultFileAtomic } from '../packages/vault/src/vault-path-safety.mjs';
import { validateBridgeProjection } from '../packages/integrations/src/bridge-contract.mjs';

const BASELINE_FILE = 'spec-kit-baseline.v1.json';

function safeChangeSlug(value) {
  const slug = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug) || slug.includes('..')) {
    throw Object.assign(new Error('a safe change slug is required for the Spec Kit baseline'), {
      code: 'BRIDGE_BASELINE_CONTEXT_INVALID',
    });
  }
  return slug;
}

export function specKitBaselinePath(vaultBase, changeSlug) {
  return join(vaultBase, getLocale(vaultBase).folders.changes, safeChangeSlug(changeSlug), BASELINE_FILE);
}

export function readSpecKitBaseline(vaultBase, changeSlug) {
  const path = specKitBaselinePath(vaultBase, changeSlug);
  if (!existsSync(path)) return null;
  let projection;
  try { projection = JSON.parse(readFileSync(path, 'utf8')); } catch {
    throw Object.assign(new Error('canonical Spec Kit baseline is invalid JSON'), { code: 'BRIDGE_BASELINE_INVALID' });
  }
  const validation = validateBridgeProjection(projection);
  if (!validation.valid || projection.ok !== true || projection.adapter !== 'spec-kit') {
    throw Object.assign(new Error('canonical Spec Kit baseline is invalid or blocked'), {
      code: 'BRIDGE_BASELINE_INVALID', diagnostics: validation.diagnostics,
    });
  }
  return projection;
}

export function writeSpecKitBaseline(vaultBase, changeSlug, projection) {
  const validation = validateBridgeProjection(projection);
  if (!validation.valid || projection.ok !== true || projection.adapter !== 'spec-kit') {
    throw Object.assign(new Error('only a valid green Spec Kit projection can become baseline'), {
      code: 'BRIDGE_BASELINE_INVALID', diagnostics: validation.diagnostics,
    });
  }
  const path = specKitBaselinePath(vaultBase, changeSlug);
  const changeDir = join(vaultBase, getLocale(vaultBase).folders.changes, safeChangeSlug(changeSlug));
  if (!existsSync(changeDir)) {
    throw Object.assign(new Error(`change not found for Spec Kit baseline: ${changeSlug}`), {
      code: 'BRIDGE_BASELINE_CONTEXT_INVALID',
    });
  }
  writeVaultFileAtomic(vaultBase, path, `${JSON.stringify(projection, null, 2)}\n`, 'utf8', {
    scopeRoot: changeDir, label: 'baseline canônico Spec Kit', code: 'BRIDGE_BASELINE_PATH_UNSAFE',
  });
  return projection;
}
